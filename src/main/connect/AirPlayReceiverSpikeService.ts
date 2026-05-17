import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { AudioStatus } from '../../shared/types/audio';
import type { AirPlayReceiverStatus, ConnectMetadata, ConnectReceiverClient, ConnectReceiverDebugEvent } from '../../shared/types/connect';
import { getAudioSession } from '../audio/AudioSession';

type RaopEvent = Record<string, unknown> & {
  type?: string;
  data?: Buffer;
  sampleRate?: number;
  channels?: number;
  title?: string;
  artist?: string;
  album?: string;
  durationMs?: number;
  elapsedMs?: number;
  value?: number;
  remoteAddress?: string;
  address?: string;
  host?: string;
  mimeType?: string;
  contentType?: string;
};

type RaopReceiverOptions = {
  name: string;
  model: string;
  metadata: boolean;
  portBase: number;
  portRange: number;
};

type RaopModule = {
  startReceiver: (options: RaopReceiverOptions, handler: (event: RaopEvent) => void) => number;
  stopReceiver: (handle: number) => void;
  sendRemoteCommand?: (handle: number, command: 'play' | 'pause' | 'stop' | 'next' | 'prev' | 'previous') => boolean;
  setLogHandler?: (handler: ((event: unknown) => void) | null, level?: string) => void;
};

type AirPlayAudioSession = {
  getStatus: () => AudioStatus;
  playPcmStream: (request: {
    stream: PassThrough;
    sourceId: string;
    trackId?: string | null;
    sampleRate: number;
    channels: number;
    durationSeconds?: number;
  }) => Promise<AudioStatus>;
  pause: () => Promise<AudioStatus> | AudioStatus;
  stop: () => Promise<AudioStatus> | AudioStatus;
  setOutput: (settings: { volume: number }) => Promise<AudioStatus> | AudioStatus;
  on: (event: 'status', listener: (status: AudioStatus) => void) => AirPlayAudioSession;
  off?: (event: 'status', listener: (status: AudioStatus) => void) => AirPlayAudioSession;
};

type AirPlayReceiverEvents = {
  status: [AirPlayReceiverStatus];
};

type AirPlayReceiverDependencies = {
  audioSession?: AirPlayAudioSession;
  advertisedName?: string;
  loadRaopModule?: () => Promise<RaopModule>;
  now?: () => number;
};

const defaultAdvertisedName = (): string => 'ECHO Next (AirPlay)';
const defaultTitle = 'AirPlay stream';
const unknownArtist = 'Unknown Artist';
const debugEventLimit = 24;
const defaultSampleRate = 44_100;
const defaultChannels = 2;

const loadDefaultRaopModule = async (): Promise<RaopModule> => {
  const specifier = '@lox-audioserver/node-libraop';
  return (await import(specifier)) as RaopModule;
};

const trimText = (value: unknown): string | null => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text : null;
};

const normalizeVolume = (value: unknown): number => {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return 100;
  }

  if (numberValue <= 1 && numberValue >= 0) {
    return Math.round(numberValue * 100);
  }

  return Math.max(0, Math.min(100, Math.round(numberValue)));
};

const eventAddress = (event: RaopEvent): string | null =>
  trimText(event.remoteAddress) ?? trimText(event.address) ?? trimText(event.host);

export const convertS16leToF32le = (input: Buffer): Buffer => {
  const sampleCount = Math.floor(input.length / 2);
  const output = Buffer.allocUnsafe(sampleCount * 4);

  for (let index = 0; index < sampleCount; index += 1) {
    output.writeFloatLE(input.readInt16LE(index * 2) / 32768, index * 4);
  }

  return output;
};

const metadataFromEvent = (event: RaopEvent, current: ConnectMetadata | null, artworkUrl: string | null): ConnectMetadata => {
  const durationSeconds = Number(event.durationMs);
  return {
    title: trimText(event.title) ?? current?.title ?? defaultTitle,
    artist: trimText(event.artist) ?? current?.artist ?? unknownArtist,
    album: trimText(event.album) ?? current?.album ?? null,
    albumArtist: current?.albumArtist ?? trimText(event.artist) ?? current?.artist ?? unknownArtist,
    durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? Math.round(durationSeconds / 1000) : current?.durationSeconds ?? 0,
    coverHttpUrl: artworkUrl ?? current?.coverHttpUrl ?? '',
  };
};

export class AirPlayReceiverSpikeService extends EventEmitter<AirPlayReceiverEvents> {
  private readonly audioSession: AirPlayAudioSession;
  private readonly advertisedName: string;
  private readonly loadRaopModule: () => Promise<RaopModule>;
  private readonly now: () => number;
  private raopModule: RaopModule | null = null;
  private receiverHandle: number | null = null;
  private pcmStream: PassThrough | null = null;
  private pcmPlaybackStarted = false;
  private currentSourceId: string | null = null;
  private ignorePcmUntilNextStream = false;
  private sessionCounter = 0;
  private status: AirPlayReceiverStatus;

  constructor(dependencies: AirPlayReceiverDependencies = {}) {
    super();
    this.audioSession = dependencies.audioSession ?? getAudioSession();
    this.advertisedName = dependencies.advertisedName ?? defaultAdvertisedName();
    this.loadRaopModule = dependencies.loadRaopModule ?? loadDefaultRaopModule;
    this.now = dependencies.now ?? Date.now;
    this.status = this.createDisabledStatus();
    this.audioSession.on('status', this.handleAudioStatus);
  }

  getStatus(): AirPlayReceiverStatus {
    return this.withAudioPosition(this.status);
  }

  async setEnabled(enabled: boolean): Promise<AirPlayReceiverStatus> {
    if (enabled) {
      await this.start();
    } else {
      await this.stop();
    }

    return this.getStatus();
  }

  async stopPlayback(): Promise<AirPlayReceiverStatus> {
    this.sendRemoteCommand('stop');
    const currentSourceId = this.currentSourceId;
    if (currentSourceId && this.audioSession.getStatus().currentFilePath === currentSourceId) {
      await Promise.resolve(this.audioSession.stop()).catch(() => undefined);
    }
    this.ignorePcmUntilNextStream = true;
    this.clearCurrentSession('stopped by ECHO');
    this.setStatus({
      state: this.status.enabled ? 'idle' : 'disabled',
      currentSourceId: null,
      currentClient: null,
      metadata: null,
      artworkUrl: null,
      positionSeconds: 0,
      durationSeconds: 0,
    });
    return this.getStatus();
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.audioSession.off?.('status', this.handleAudioStatus);
    this.removeAllListeners();
  }

  private createDisabledStatus(): AirPlayReceiverStatus {
    return {
      enabled: false,
      state: 'disabled',
      advertisedName: this.advertisedName,
      nativeAvailable: false,
      currentSourceId: null,
      currentClient: null,
      metadata: null,
      artworkUrl: null,
      positionSeconds: 0,
      durationSeconds: 0,
      volume: Math.round((this.audioSession.getStatus().volume ?? 1) * 100),
      error: null,
      debugEvents: [],
      updatedAt: new Date(this.now()).toISOString(),
    };
  }

  private async start(): Promise<void> {
    if (this.status.enabled && this.receiverHandle !== null) {
      return;
    }

    this.setStatus({ enabled: false, state: 'starting', error: null });
    try {
      this.raopModule = await this.loadRaopModule();
      this.raopModule.setLogHandler?.((event) => this.addDebugEvent('log', String(event ?? '')), 'warn');
      this.receiverHandle = this.raopModule.startReceiver(
        {
          name: this.advertisedName,
          model: 'ECHO-Next-AirPlay-Spike',
          metadata: true,
          portBase: 6000,
          portRange: 100,
        },
        (event) => this.handleRaopEvent(event),
      );
      this.setStatus({
        enabled: true,
        state: 'idle',
        nativeAvailable: true,
        error: null,
      });
      this.addDebugEvent('start', 'RAOP receiver started');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.receiverHandle = null;
      this.raopModule = null;
      this.clearCurrentSession('native module unavailable');
      this.setStatus({
        enabled: false,
        state: 'unavailable',
        nativeAvailable: false,
        error: `AirPlay native backend unavailable: ${message}`,
      });
      this.addDebugEvent('error', message);
    }
  }

  private async stop(): Promise<void> {
    await this.stopPlayback().catch(() => undefined);
    if (this.receiverHandle !== null && this.raopModule) {
      try {
        this.raopModule.stopReceiver(this.receiverHandle);
      } catch (error) {
        this.addDebugEvent('error', error instanceof Error ? error.message : String(error));
      }
    }
    this.receiverHandle = null;
    this.raopModule = null;
    this.setStatus({
      enabled: false,
      state: 'disabled',
      currentClient: null,
      currentSourceId: null,
      metadata: null,
      artworkUrl: null,
      positionSeconds: 0,
      durationSeconds: 0,
      error: null,
    });
  }

  private handleRaopEvent(event: RaopEvent): void {
    const type = trimText(event.type) ?? 'unknown';
    this.addDebugEvent(type, eventAddress(event) ?? '');

    switch (type) {
      case 'stream':
        this.prepareIncomingStream(event);
        break;
      case 'metadata':
        this.applyMetadataEvent(event);
        break;
      case 'artwork':
        this.applyArtworkEvent(event);
        break;
      case 'pcm':
        this.handlePcmEvent(event);
        break;
      case 'play':
        this.setStatus({ state: 'playing' });
        break;
      case 'pause':
      case 'flush':
        void Promise.resolve(this.audioSession.pause()).catch(() => undefined);
        this.setStatus({ state: 'paused' });
        break;
      case 'stop':
        void this.stopPlayback();
        break;
      case 'volume':
        void Promise.resolve(this.audioSession.setOutput({ volume: normalizeVolume(event.value) / 100 })).catch(() => undefined);
        this.setStatus({ volume: normalizeVolume(event.value) });
        break;
      default:
        break;
    }
  }

  private prepareIncomingStream(event: RaopEvent): void {
    this.clearCurrentSession('new AirPlay stream');
    this.ignorePcmUntilNextStream = false;
    this.sessionCounter += 1;
    this.currentSourceId = `airplay-receiver:${this.now().toString(36)}-${this.sessionCounter.toString(36)}`;
    this.pcmStream = new PassThrough({ highWaterMark: 1024 * 1024 });
    this.pcmPlaybackStarted = false;
    const address = eventAddress(event);
    const client: ConnectReceiverClient | null = address
      ? {
          address,
          userAgent: 'AirPlay',
          lastSeenAt: new Date(this.now()).toISOString(),
        }
      : null;
    this.setStatus({
      state: 'ready',
      currentClient: client,
      currentSourceId: this.currentSourceId,
      metadata: metadataFromEvent(event, this.status.metadata, this.status.artworkUrl),
      positionSeconds: 0,
      durationSeconds: 0,
      error: null,
    });
  }

  private applyMetadataEvent(event: RaopEvent): void {
    const metadata = metadataFromEvent(event, this.status.metadata, this.status.artworkUrl);
    const elapsedMs = Number(event.elapsedMs);
    this.setStatus({
      metadata,
      durationSeconds: metadata.durationSeconds,
      positionSeconds: Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs / 1000 : this.status.positionSeconds,
    });
  }

  private applyArtworkEvent(event: RaopEvent): void {
    const data = Buffer.isBuffer(event.data) ? event.data : null;
    if (!data || data.length === 0) {
      return;
    }

    const mimeType = trimText(event.mimeType) ?? trimText(event.contentType) ?? 'image/jpeg';
    const artworkUrl = `data:${mimeType};base64,${data.toString('base64')}`;
    const metadata = metadataFromEvent(event, this.status.metadata, artworkUrl);
    this.setStatus({
      artworkUrl,
      metadata,
      durationSeconds: metadata.durationSeconds,
    });
  }

  private handlePcmEvent(event: RaopEvent): void {
    const data = Buffer.isBuffer(event.data) ? event.data : null;
    if (!data || data.length < 2) {
      return;
    }

    if (this.ignorePcmUntilNextStream && !this.currentSourceId) {
      return;
    }

    if (!this.currentSourceId || !this.pcmStream) {
      this.prepareIncomingStream(event);
    }

    if (!this.currentSourceId || !this.pcmStream) {
      return;
    }

    if (!this.pcmPlaybackStarted) {
      this.pcmPlaybackStarted = true;
      const stream = this.pcmStream;
      void this.audioSession
        .playPcmStream({
          stream,
          sourceId: this.currentSourceId,
          trackId: this.currentSourceId,
          sampleRate: Number(event.sampleRate) || defaultSampleRate,
          channels: Number(event.channels) || defaultChannels,
          durationSeconds: this.status.durationSeconds,
        })
        .then(() => this.setStatus({ state: 'playing', error: null }))
        .catch((error) => {
          this.setStatus({
            state: 'error',
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }

    const converted = convertS16leToF32le(data);
    if (!this.pcmStream.write(converted)) {
      this.addDebugEvent('pcm', 'backpressure');
    }
  }

  private clearCurrentSession(reason: string): void {
    if (this.pcmStream) {
      this.pcmStream.destroy();
    }
    this.pcmStream = null;
    this.pcmPlaybackStarted = false;
    this.currentSourceId = null;
    if (reason) {
      this.addDebugEvent('clear', reason);
    }
  }

  private sendRemoteCommand(command: 'play' | 'pause' | 'stop'): void {
    if (this.receiverHandle === null || !this.raopModule?.sendRemoteCommand) {
      return;
    }

    try {
      this.raopModule.sendRemoteCommand(this.receiverHandle, command);
    } catch (error) {
      this.addDebugEvent('remote', error instanceof Error ? error.message : String(error));
    }
  }

  private withAudioPosition(status: AirPlayReceiverStatus): AirPlayReceiverStatus {
    const audioStatus = this.audioSession.getStatus();
    if (!this.currentSourceId || audioStatus.currentFilePath !== this.currentSourceId) {
      return status;
    }

    return {
      ...status,
      state: audioStatus.state === 'playing' || audioStatus.state === 'paused' || audioStatus.state === 'stopped'
        ? audioStatus.state
        : status.state,
      positionSeconds: audioStatus.positionSeconds,
      durationSeconds: audioStatus.durationSeconds || status.durationSeconds,
      volume: Math.round(audioStatus.volume * 100),
      updatedAt: new Date(this.now()).toISOString(),
    };
  }

  private readonly handleAudioStatus = (audioStatus: AudioStatus): void => {
    if (!this.currentSourceId) {
      return;
    }

    if (
      audioStatus.currentFilePath &&
      audioStatus.currentFilePath !== this.currentSourceId &&
      (audioStatus.state === 'loading' || audioStatus.state === 'playing')
    ) {
      this.sendRemoteCommand('stop');
      this.ignorePcmUntilNextStream = true;
      this.clearCurrentSession('local playback took over');
      this.setStatus({
        state: this.status.enabled ? 'idle' : 'disabled',
        currentClient: null,
        currentSourceId: null,
        metadata: null,
        artworkUrl: null,
        positionSeconds: 0,
        durationSeconds: 0,
      });
      return;
    }

    if (audioStatus.currentFilePath !== this.currentSourceId) {
      return;
    }

    const state =
      audioStatus.state === 'playing' || audioStatus.state === 'paused' || audioStatus.state === 'stopped' || audioStatus.state === 'error'
        ? audioStatus.state
        : this.status.state;
    this.setStatus({
      state,
      positionSeconds: audioStatus.positionSeconds,
      durationSeconds: audioStatus.durationSeconds || this.status.durationSeconds,
      volume: Math.round(audioStatus.volume * 100),
      error: audioStatus.error ?? this.status.error,
    });
  };

  private setStatus(next: Partial<AirPlayReceiverStatus>): void {
    this.status = {
      ...this.status,
      ...next,
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.emit('status', this.getStatus());
  }

  private addDebugEvent(action: string, message: string | null): void {
    const event: ConnectReceiverDebugEvent = {
      id: `${this.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      at: new Date(this.now()).toISOString(),
      remoteAddress: this.status.currentClient?.address ?? null,
      method: 'RAOP',
      path: '/airplay/receiver',
      action,
      statusCode: null,
      message,
    };
    this.status = {
      ...this.status,
      debugEvents: [event, ...this.status.debugEvents].slice(0, debugEventLimit),
      updatedAt: new Date(this.now()).toISOString(),
    };
  }
}

let airPlayReceiverService: AirPlayReceiverSpikeService | null = null;

export const getAirPlayReceiverSpikeService = (): AirPlayReceiverSpikeService => {
  airPlayReceiverService ??= new AirPlayReceiverSpikeService();
  return airPlayReceiverService;
};

export const disposeAirPlayReceiverSpikeService = async (): Promise<void> => {
  if (airPlayReceiverService) {
    await airPlayReceiverService.dispose();
    airPlayReceiverService = null;
  }
};
