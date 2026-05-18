import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { AudioStatus } from '../../shared/types/audio';
import { AirPlayReceiverSpikeService, convertS16leToF32le } from './AirPlayReceiverSpikeService';

const audioStatus = (overrides: Partial<AudioStatus> = {}): AudioStatus => ({
  host: 'ready',
  state: 'idle',
  outputDeviceId: null,
  outputDeviceName: null,
  outputDeviceType: null,
  outputBackend: null,
  activeOutputBackendImpl: null,
  outputMode: 'shared',
  sharedBackend: 'auto',
  useJuceOutputRequested: false,
  useJuceDecodeRequested: false,
  activeDecodeBackendImpl: null,
  dsdOutputModeRequested: 'pcm',
  activeDsdOutputMode: null,
  dsdNativeSampleRate: null,
  dsdTransportSampleRate: null,
  volume: 1,
  playbackRate: 1,
  playbackSpeedMode: 'nightcore',
  currentFilePath: null,
  currentTrackId: null,
  durationSeconds: 0,
  positionSeconds: 0,
  channels: null,
  codec: null,
  bitDepth: null,
  bitrate: null,
  fileSampleRate: null,
  decoderOutputSampleRate: null,
  requestedOutputSampleRate: null,
  actualDeviceSampleRate: null,
  sharedDeviceSampleRate: null,
  resampling: false,
  resamplerEngine: 'default',
  resamplerFallbackActive: false,
  bitPerfectCandidate: false,
  sampleRateMismatch: false,
  latencyProfile: 'balanced',
  eqEnabled: false,
  channelBalanceEnabled: false,
  dspActive: false,
  preampDb: 0,
  eqPresetName: null,
  clippingRisk: false,
  bitPerfectDisabledReason: null,
  warnings: [],
  error: null,
  ...overrides,
});

class FakeAudioSession extends EventEmitter {
  status = audioStatus();
  playPcmStream = vi.fn(async (request: { stream: PassThrough; sourceId: string; trackId?: string | null }) => {
    this.status = audioStatus({
      state: 'playing',
      currentFilePath: request.sourceId,
      currentTrackId: request.trackId ?? request.sourceId,
      codec: 'pcm-f32le',
      channels: 2,
      fileSampleRate: 44100,
      decoderOutputSampleRate: 44100,
      requestedOutputSampleRate: 44100,
    });
    this.emit('status', this.status);
    return this.status;
  });
  pause = vi.fn(async () => {
    this.status = { ...this.status, state: 'paused' };
    this.emit('status', this.status);
    return this.status;
  });
  stop = vi.fn(async () => {
    this.status = { ...this.status, state: 'stopped', currentFilePath: null, currentTrackId: null };
    this.emit('status', this.status);
    return this.status;
  });
  setOutput = vi.fn(async (settings: { volume: number }) => {
    this.status = { ...this.status, volume: settings.volume };
    this.emit('status', this.status);
    return this.status;
  });
  getStatus = (): AudioStatus => this.status;
}

describe('AirPlayReceiverSpikeService', () => {
  it('converts signed 16-bit PCM to float32 PCM', () => {
    const input = Buffer.alloc(8);
    input.writeInt16LE(-32768, 0);
    input.writeInt16LE(0, 2);
    input.writeInt16LE(16384, 4);
    input.writeInt16LE(32767, 6);

    const output = convertS16leToF32le(input);

    expect(output.readFloatLE(0)).toBe(-1);
    expect(output.readFloatLE(4)).toBe(0);
    expect(output.readFloatLE(8)).toBeCloseTo(0.5, 4);
    expect(output.readFloatLE(12)).toBeCloseTo(0.99997, 4);
  });

  it('reports native backend failure without enabling the receiver', async () => {
    const service = new AirPlayReceiverSpikeService({
      audioSession: new FakeAudioSession() as never,
      loadRaopModule: async () => {
        throw new Error('Cannot find module @lox-audioserver/node-libraop');
      },
    });

    const status = await service.setEnabled(true);

    expect(status.enabled).toBe(false);
    expect(status.state).toBe('unavailable');
    expect(status.nativeAvailable).toBe(false);
    expect(status.error).toContain('node-libraop');
  });

  it('maps RAOP metadata artwork and PCM events into an AirPlay playback session', async () => {
    const audio = new FakeAudioSession();
    const harness: { handler?: (event: Record<string, unknown>) => void } = {};
    const stopReceiver = vi.fn();
    const service = new AirPlayReceiverSpikeService({
      audioSession: audio as never,
      loadRaopModule: async () => ({
        startReceiver: (_options, nextHandler) => {
          harness.handler = nextHandler;
          return 7;
        },
        stopReceiver,
        sendRemoteCommand: vi.fn(() => true),
      }),
      now: () => 1_000,
    });

    await service.setEnabled(true);
    harness.handler?.({ type: 'stream', remoteAddress: '192.168.1.50' });
    harness.handler?.({ type: 'metadata', title: 'Air Song', artist: 'Singer', album: 'Album', durationMs: 180_000 });
    harness.handler?.({ type: 'artwork', data: Buffer.from([1, 2, 3]), mimeType: 'image/png' });
    const pcm = Buffer.alloc(4);
    pcm.writeInt16LE(32767, 0);
    pcm.writeInt16LE(-32768, 2);
    harness.handler?.({ type: 'pcm', data: pcm, sampleRate: 44100, channels: 2 });
    await Promise.resolve();

    const status = service.getStatus();
    expect(audio.playPcmStream).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: expect.stringMatching(/^airplay-receiver:/u),
      sampleRate: 44100,
      channels: 2,
      output: expect.objectContaining({
        requestedOutputSampleRate: 48000,
        latencyProfile: 'stable',
        bufferSizeFrames: 8192,
      }),
    }));
    expect(status.state).toBe('playing');
    expect(status.currentClient?.address).toBe('192.168.1.50');
    expect(status.metadata?.title).toBe('Air Song');
    expect(status.metadata?.artist).toBe('Singer');
    expect(status.metadata?.coverHttpUrl).toMatch(/^data:image\/png;base64,/u);
  });

  it('uses album metadata when AirPlay sends a generic instrumental title', async () => {
    const audio = new FakeAudioSession();
    const harness: { handler?: (event: Record<string, unknown>) => void } = {};
    const service = new AirPlayReceiverSpikeService({
      audioSession: audio as never,
      loadRaopModule: async () => ({
        startReceiver: (_options, nextHandler) => {
          harness.handler = nextHandler;
          return 11;
        },
        stopReceiver: vi.fn(),
        sendRemoteCommand: vi.fn(() => true),
      }),
      now: () => 1_000,
    });

    await service.setEnabled(true);
    harness.handler?.({
      type: 'metadata',
      title: '纯音乐，请欣赏',
      artist: 'lapix/Flamenco House',
      album: 'Flamenco House',
      durationMs: 144_000,
    });

    const status = service.getStatus();
    expect(status.metadata?.title).toBe('Flamenco House');
    expect(status.metadata?.artist).toBe('lapix');
    expect(status.metadata?.album).toBe('Flamenco House');
    expect(status.metadata?.durationSeconds).toBe(144);
  });

  it('uses album metadata when AirPlay sends a lyric line as title', async () => {
    const audio = new FakeAudioSession();
    const harness: { handler?: (event: Record<string, unknown>) => void } = {};
    const service = new AirPlayReceiverSpikeService({
      audioSession: audio as never,
      loadRaopModule: async () => ({
        startReceiver: (_options, nextHandler) => {
          harness.handler = nextHandler;
          return 12;
        },
        stopReceiver: vi.fn(),
        sendRemoteCommand: vi.fn(() => true),
      }),
      now: () => 1_000,
    });

    await service.setEnabled(true);
    harness.handler?.({
      type: 'metadata',
      title: "And I know, I'm not alone",
      artist: 'Porter Robinson/Madeon/Shelter (シェルター)',
      album: 'Shelter',
      durationMs: 219_000,
    });

    const status = service.getStatus();
    expect(status.metadata?.title).toBe('Shelter');
    expect(status.metadata?.artist).toBe('Porter Robinson / Madeon');
    expect(status.metadata?.album).toBe('Shelter');
  });

  it('releases the AirPlay session when local playback takes over', async () => {
    const audio = new FakeAudioSession();
    const harness: { handler?: (event: Record<string, unknown>) => void } = {};
    const sendRemoteCommand = vi.fn(() => true);
    const service = new AirPlayReceiverSpikeService({
      audioSession: audio as never,
      loadRaopModule: async () => ({
        startReceiver: (_options, nextHandler) => {
          harness.handler = nextHandler;
          return 8;
        },
        stopReceiver: vi.fn(),
        sendRemoteCommand,
      }),
    });

    await service.setEnabled(true);
    harness.handler?.({ type: 'stream', remoteAddress: '192.168.1.50' });
    harness.handler?.({ type: 'metadata', title: 'Air Song', artist: 'Singer' });
    harness.handler?.({ type: 'pcm', data: Buffer.from([0, 0]), sampleRate: 44100, channels: 2 });
    await Promise.resolve();
    audio.status = audioStatus({ state: 'loading', currentFilePath: 'local.flac' });
    audio.emit('status', audio.status);
    harness.handler?.({ type: 'pcm', data: Buffer.from([0, 0]), sampleRate: 44100, channels: 2 });

    const status = service.getStatus();
    expect(sendRemoteCommand).toHaveBeenCalledWith(8, 'stop');
    expect(audio.playPcmStream).toHaveBeenCalledTimes(1);
    expect(status.state).toBe('idle');
    expect(status.metadata).toBeNull();
    expect(status.currentSourceId).toBeNull();
  });

  it('does not stop local audio when disabling an idle AirPlay receiver', async () => {
    const audio = new FakeAudioSession();
    audio.status = audioStatus({ state: 'playing', currentFilePath: 'local.flac', currentTrackId: 'local-track' });
    const stopReceiver = vi.fn();
    const service = new AirPlayReceiverSpikeService({
      audioSession: audio as never,
      loadRaopModule: async () => ({
        startReceiver: () => 9,
        stopReceiver,
        sendRemoteCommand: vi.fn(() => true),
      }),
    });

    await service.setEnabled(true);
    await service.setEnabled(false);

    expect(stopReceiver).toHaveBeenCalledWith(9);
    expect(audio.stop).not.toHaveBeenCalled();
    expect(audio.status.currentFilePath).toBe('local.flac');
  });
});
