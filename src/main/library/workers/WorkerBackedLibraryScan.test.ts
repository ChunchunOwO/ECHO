import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkerBackedLibraryScanWorkers } from './WorkerBackedLibraryScan';
import type { LibraryScanWorkerRequest, LibraryScanWorkerResponse } from './LibraryScanWorkerProtocol';
import type { CoverResult, MetadataResult } from '../libraryTypes';

const metadataResult = (): MetadataResult => ({
  fields: {
    title: 'Worker Title',
    artist: 'Worker Artist',
    album: 'Worker Album',
    albumArtist: 'Worker Artist',
    trackNo: 1,
    discNo: null,
    year: null,
    genre: null,
    duration: 120,
    codec: 'FLAC',
    sampleRate: 44100,
    bitDepth: 16,
    bitrate: 900000,
  },
  fieldSources: {
    title: 'embedded',
    artist: 'embedded',
    album: 'embedded',
    albumArtist: 'embedded',
    trackNo: 'embedded',
    discNo: 'unknown',
    year: 'unknown',
    genre: 'unknown',
    duration: 'technical',
    codec: 'technical',
    sampleRate: 'technical',
    bitDepth: 'technical',
    bitrate: 'technical',
    bpm: 'unknown',
  },
  embeddedMetadataStatus: 'present',
  embeddedCoverStatus: 'missing',
  warnings: [],
  errors: [],
  status: 'ok',
});

const coverResult = (): CoverResult => ({
  source: 'embedded',
  thumbPath: 'D:\\Cache\\thumb.webp',
  albumPath: 'D:\\Cache\\album.webp',
  largePath: 'D:\\Cache\\large.webp',
  originalRef: 'D:\\Cache\\original.jpg',
  sourceHash: 'worker-cover-hash',
  mimeType: 'image/jpeg',
  warnings: [],
  errors: [],
});

class FakeWorker extends EventEmitter {
  readonly requests: LibraryScanWorkerRequest[] = [];
  terminated = false;

  constructor(private readonly respond: (request: LibraryScanWorkerRequest) => LibraryScanWorkerResponse) {
    super();
  }

  postMessage(message: LibraryScanWorkerRequest): void {
    this.requests.push(message);
    setImmediate(() => {
      this.emit('message', this.respond(message));
    });
  }

  terminate(): number {
    this.terminated = true;
    return 0;
  }
}

describe('WorkerBackedLibraryScan', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads metadata through the scan worker pool', async () => {
    const workers: FakeWorker[] = [];
    const scanWorkers = createWorkerBackedLibraryScanWorkers({
      workerCount: 1,
      workerFactory: () => {
        const worker = new FakeWorker((request) => ({
          requestId: request.requestId,
          ok: true,
          result: metadataResult(),
        }));
        workers.push(worker);
        return worker;
      },
    });

    try {
      const result = await scanWorkers.metadataReader.read('D:\\Music\\Worker.flac');

      expect(result.fields.title).toBe('Worker Title');
      expect(workers[0]?.requests).toEqual([
        expect.objectContaining({
          type: 'metadata:read',
          filePath: 'D:\\Music\\Worker.flac',
        }),
      ]);
    } finally {
      scanWorkers.close();
    }
  });

  it('falls back to the TypeScript metadata reader when a worker task fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const scanWorkers = createWorkerBackedLibraryScanWorkers({
      workerCount: 1,
      workerFactory: () =>
        new FakeWorker((request) => ({
          requestId: request.requestId,
          ok: false,
          message: 'worker unavailable',
        })),
    });

    try {
      const missingPath = join(tmpdir(), 'Worker Fallback.mp3');
      const result = await scanWorkers.metadataReader.read(missingPath);

      expect(result.status).toBe('error');
      expect(result.fields.title).toBe('Worker Fallback');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('metadata:read worker failed; falling back'));
    } finally {
      scanWorkers.close();
    }
  });

  it('extracts covers through the scan worker pool', async () => {
    const workers: FakeWorker[] = [];
    const scanWorkers = createWorkerBackedLibraryScanWorkers({
      workerCount: 1,
      workerFactory: () => {
        const worker = new FakeWorker((request) => ({
          requestId: request.requestId,
          ok: true,
          result: coverResult(),
        }));
        workers.push(worker);
        return worker;
      },
    });

    try {
      const result = await scanWorkers.coverExtractor.extract('D:\\Music\\Worker.flac', {
        cacheRoot: 'D:\\Cache',
        metadata: metadataResult(),
      });

      expect(result.sourceHash).toBe('worker-cover-hash');
      expect(workers[0]?.requests).toEqual([
        expect.objectContaining({
          type: 'cover:extract',
          filePath: 'D:\\Music\\Worker.flac',
          options: expect.objectContaining({ cacheRoot: 'D:\\Cache' }),
        }),
      ]);
    } finally {
      scanWorkers.close();
    }
  });
});
