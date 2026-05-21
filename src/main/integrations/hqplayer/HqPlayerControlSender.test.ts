import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { HqPlayerPlaybackControlPlan } from '../../../shared/types/hqplayer';
import { probeHqPlayerControlEndpoint, sendHqPlayerPlaybackControlPlan } from './HqPlayerControlSender';

const servers: Server[] = [];

const basePlan = (port: number | null): HqPlayerPlaybackControlPlan => ({
  state: 'prepared',
  reason: null,
  action: 'play-source',
  transport: 'dry-run',
  endpoint: {
    connectionMode: 'localDesktop',
    host: '127.0.0.1',
    port,
  },
  profileName: null,
  source: {
    trackId: 'track-1',
    mediaType: 'local',
    url: 'http://127.0.0.1:17890/hqplayer-media/song.flac?token=a&b=1',
    exposure: 'media-server',
    mimeType: 'audio/flac',
    expiresAt: null,
    hasHeaders: false,
  },
  metadata: {
    title: 'Song & Test',
    artist: 'Artist',
    album: 'Album',
    durationSeconds: 180,
  },
  startSeconds: 0,
  createdAt: '2026-05-21T01:00:00.000Z',
  send: null,
});

const createTcpServer = async (
  onData: (data: string, socket: Socket) => void,
): Promise<{ port: number; received: string[] }> => {
  const received: string[] = [];
  const server = createServer((socket) => {
    socket.on('data', (chunk) => {
      const data = chunk.toString('utf8');
      received.push(data);
      onData(data, socket);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('test_server_port_unavailable');
  }

  return { port: address.port, received };
};

const getUnusedPort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (!address || typeof address === 'string') {
    throw new Error('test_server_port_unavailable');
  }

  return address.port;
};

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) =>
      new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    ),
  );
});

describe('HqPlayerControlSender', () => {
  it('reads HQPlayer GetInfo and one-shot Status without changing playback', async () => {
    const server = await createTcpServer((data, socket) => {
      if (data.includes('<GetInfo')) {
        socket.write('<?xml version="1.0"?><GetInfo name="Living Room" product="HQPlayer Desktop" version="5.17.2" platform="Windows" engine="5.29.2"/>\n');
        return;
      }

      if (data.includes('<Status')) {
        socket.write(
          '<?xml version="1.0"?><Status state="2" track="1" track_id="track-1" tracks_total="2" queued="1" position="12.5" length="180" volume="-3.0" active_mode="poly-sinc" active_filter="sinc-M" active_shaper="ASDM7" active_rate="2822400" active_bits="1" active_channels="2" input_fill="0.5" output_fill="0.7" output_delay="12000" apod="1"><metadata uri="file:///D:/Music/song.flac" mime="audio/flac" song="Song" artist="Artist" album="Album" albumartist="Album Artist" samplerate="44100" bits="16" channels="2" bitrate="900000"/></Status>\n',
        );
      }
    });

    const result = await probeHqPlayerControlEndpoint({
      connectionMode: 'localDesktop',
      host: '127.0.0.1',
      port: server.port,
    }, { timeoutMs: 250 });

    expect(result).toMatchObject({
      ok: true,
      error: null,
      controlInfo: {
        name: 'Living Room',
        product: 'HQPlayer Desktop',
        version: '5.17.2',
        engine: '5.29.2',
      },
      playbackStatus: {
        state: 'playing',
        stateCode: 2,
        track: 1,
        trackId: 'track-1',
        tracksTotal: 2,
        queued: true,
        positionSeconds: 12.5,
        durationSeconds: 180,
        activeRate: 2822400,
        activeBits: 1,
        activeChannels: 2,
        metadata: {
          title: 'Song',
          artist: 'Artist',
          album: 'Album',
          sampleRate: 44100,
        },
      },
    });
    expect(server.received.join('')).toContain('<GetInfo');
    expect(server.received.join('')).toContain('<Status subscribe="0"');
  });

  it('reports protocol errors when a read-only probe receives the wrong response', async () => {
    const server = await createTcpServer((_data, socket) => {
      socket.write('<?xml version="1.0"?><Unexpected result="OK"/>\n');
    });

    const result = await probeHqPlayerControlEndpoint({
      connectionMode: 'localDesktop',
      host: '127.0.0.1',
      port: server.port,
    }, { timeoutMs: 25 });

    expect(result).toMatchObject({
      ok: false,
      error: 'hqplayer_protocol_error',
      controlInfo: null,
      playbackStatus: null,
    });
  });

  it('sends the official PlayNextURI XML command and records success', async () => {
    const server = await createTcpServer((_data, socket) => {
      socket.write('<?xml version="1.0"?><PlayNextURI result="OK"/>\n');
    });

    const result = await sendHqPlayerPlaybackControlPlan(basePlan(server.port), { timeoutMs: 250 });

    expect(result).toMatchObject({
      state: 'sent',
      reason: null,
      command: 'PlayNextURI',
    });
    expect(server.received.join('')).toContain('<PlayNextURI');
    expect(server.received.join('')).toContain('value="http://127.0.0.1:17890/hqplayer-media/song.flac?token=a&amp;b=1"');
    expect(server.received.join('')).toContain('song="Song &amp; Test"');
  });

  it('reports timeout when HQPlayer accepts the socket but does not answer', async () => {
    const server = await createTcpServer(() => undefined);

    const result = await sendHqPlayerPlaybackControlPlan(basePlan(server.port), { timeoutMs: 25 });

    expect(result).toMatchObject({
      state: 'failed',
      reason: 'hqplayer_connection_timeout',
    });
  });

  it('reports connection refused without throwing', async () => {
    const result = await sendHqPlayerPlaybackControlPlan(basePlan(await getUnusedPort()), { timeoutMs: 100 });

    expect(result.state).toBe('failed');
    expect(['hqplayer_connection_refused', 'hqplayer_connection_failed']).toContain(result.reason);
  });

  it('reports protocol errors when the response is not for PlayNextURI', async () => {
    const server = await createTcpServer((_data, socket) => {
      socket.write('<?xml version="1.0"?><Unexpected result="OK"/>\n');
    });

    const result = await sendHqPlayerPlaybackControlPlan(basePlan(server.port), { timeoutMs: 25 });

    expect(result).toMatchObject({
      state: 'failed',
      reason: 'hqplayer_protocol_error',
    });
  });

  it('skips sending when the HQPlayer control port is not configured', async () => {
    const result = await sendHqPlayerPlaybackControlPlan(basePlan(null), { timeoutMs: 25 });

    expect(result).toMatchObject({
      state: 'skipped',
      reason: 'hqplayer_control_port_not_configured',
      command: 'none',
    });
  });
});
