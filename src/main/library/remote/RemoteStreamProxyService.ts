import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { RemoteStreamUrlResult } from '../../../shared/types/remoteSources';
import type { RemoteSourceSecret } from './remoteTypes';
import { normalizeRemotePath } from './remoteIdentity';
import { WebDavRemoteSourceAdapter } from './adapters/WebDavRemoteSourceAdapter';

type TokenRecord = {
  source: RemoteSourceSecret;
  remotePath: string;
  stableKey: string | null;
  expiresAtMs: number;
};

const defaultTokenTtlMs = 6 * 60 * 60 * 1000;
const playbackTokenTtlMs = 24 * 60 * 60 * 1000;

const safeHeader = (value: string | string[] | undefined): string | undefined => (typeof value === 'string' ? value : undefined);

export class RemoteStreamProxyService {
  private server: Server | null = null;
  private port: number | null = null;
  private readonly tokens = new Map<string, TokenRecord>();

  constructor(private readonly webdavAdapter: WebDavRemoteSourceAdapter) {}

  async createStreamUrl(source: RemoteSourceSecret, remotePath: string, stableKey?: string | null, expiresInSeconds?: number): Promise<RemoteStreamUrlResult> {
    await this.ensureStarted();
    const token = randomBytes(24).toString('base64url');
    const ttlMs = expiresInSeconds === undefined ? playbackTokenTtlMs : Math.max(1, Math.round(expiresInSeconds * 1000));
    const expiresAtMs = Date.now() + ttlMs;

    this.tokens.set(token, {
      source,
      remotePath: normalizeRemotePath(remotePath),
      stableKey: stableKey ?? null,
      expiresAtMs,
    });

    return {
      url: `http://127.0.0.1:${this.port}/remote-stream/${token}`,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  clearSourceTokens(sourceId: string): void {
    for (const [token, record] of this.tokens) {
      if (record.source.id === sourceId) {
        this.tokens.delete(token);
      }
    }
  }

  async close(): Promise<void> {
    this.tokens.clear();
    if (!this.server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.server!.close((error) => (error ? reject(error) : resolve()));
    });
    this.server = null;
    this.port = null;
  }

  private async ensureStarted(): Promise<void> {
    if (this.server && this.port) {
      return;
    }

    this.server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => {
        const address = this.server!.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Remote stream proxy did not bind to a TCP port'));
          return;
        }

        this.port = address.port;
        this.server!.off('error', reject);
        resolve();
      });
    });
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405);
        response.end();
        return;
      }

      const token = request.url?.match(/^\/remote-stream\/([^/?#]+)/u)?.[1] ?? null;
      const record = token ? this.tokens.get(token) : null;

      if (!token || !record || record.expiresAtMs <= Date.now()) {
        if (token) {
          this.tokens.delete(token);
        }
        response.writeHead(401);
        response.end();
        return;
      }

      record.expiresAtMs = Math.max(record.expiresAtMs, Date.now() + defaultTokenTtlMs);
      await this.forward(record, request, response);
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(502, {
          'Cache-Control': 'no-store',
        });
      }
      response.end(error instanceof Error ? error.message : 'remote stream failed');
    }
  }

  private async forward(record: TokenRecord, request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (record.source.provider !== 'webdav' || !record.source.baseUrl) {
      response.writeHead(501);
      response.end();
      return;
    }

    const headers: Record<string, string> = {
      ...this.webdavAdapter.createAuthHeaders({ source: record.source }),
      Accept: '*/*',
    };
    const range = safeHeader(request.headers.range);
    if (range) {
      headers.Range = range;
    }

    const upstream = await fetch(this.webdavAdapter.createBackendUrl(record.source.baseUrl, record.remotePath), {
      method: request.method,
      headers,
    });

    const status = upstream.status === 416 ? 416 : upstream.status === 206 ? 206 : upstream.ok ? 200 : upstream.status;
    const acceptRanges = upstream.headers.get('accept-ranges') ?? (upstream.status === 206 || upstream.headers.has('content-range') ? 'bytes' : 'none');
    const responseHeaders: Record<string, string> = {
      'Accept-Ranges': acceptRanges,
      'Cache-Control': 'private, max-age=0, no-store',
    };

    for (const [source, target] of [
      ['content-type', 'Content-Type'],
      ['content-length', 'Content-Length'],
      ['content-range', 'Content-Range'],
      ['last-modified', 'Last-Modified'],
      ['etag', 'ETag'],
    ] as const) {
      const value = upstream.headers.get(source);
      if (value) {
        responseHeaders[target] = value;
      }
    }

    response.writeHead(status, responseHeaders);
    if (request.method === 'HEAD' || !upstream.body) {
      response.end();
      return;
    }

    Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(response);
  }
}
