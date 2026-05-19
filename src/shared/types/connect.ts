import type { LibraryTrack } from './library';

export type ConnectProtocol = 'dlna' | 'airplay';

export type ConnectDeviceState = 'available' | 'connecting' | 'connected' | 'unavailable' | 'unsupported';

export type ConnectSessionState =
  | 'idle'
  | 'discovering'
  | 'connecting'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'stopped'
  | 'error'
  | 'unsupported';

export type ConnectDeviceCapabilities = {
  canPlay: boolean;
  canPause: boolean;
  canStop: boolean;
  canSeek: boolean;
  canSetVolume: boolean;
  supportsMetadata: boolean;
  supportsSetNext: boolean;
  supportedMimeTypes: string[];
  requiresTranscode: boolean;
};

export type ConnectDevice = {
  id: string;
  name: string;
  protocol: ConnectProtocol;
  model: string | null;
  manufacturer: string | null;
  address: string | null;
  capabilities: ConnectDeviceCapabilities;
  state: ConnectDeviceState;
  lastSeenAt: string | null;
  unsupportedReason: string | null;
};

export type ConnectMetadata = {
  title: string;
  artist: string;
  album: string | null;
  albumArtist: string | null;
  durationSeconds: number;
  coverHttpUrl: string;
};

export type ConnectSessionStatus = {
  deviceId: string | null;
  protocol: ConnectProtocol | null;
  state: ConnectSessionState;
  currentTrackId: string | null;
  metadata: ConnectMetadata | null;
  positionSeconds: number;
  durationSeconds: number;
  latencyMs: number | null;
  error: string | null;
  updatedAt: string;
};

export type ConnectReceiverState = 'disabled' | 'idle' | 'ready' | 'loading' | 'playing' | 'paused' | 'stopped' | 'error';

export type ConnectReceiverClient = {
  address: string;
  userAgent: string | null;
  lastSeenAt: string;
};

export type ConnectReceiverDebugEvent = {
  id: string;
  at: string;
  remoteAddress: string | null;
  method: string;
  path: string;
  action: string | null;
  statusCode: number | null;
  message: string | null;
};

export type AirPlayReceiverState = 'disabled' | 'unavailable' | 'idle' | 'starting' | 'ready' | 'playing' | 'paused' | 'stopped' | 'error';

export type AirPlayReceiverStatus = {
  enabled: boolean;
  state: AirPlayReceiverState;
  advertisedName: string;
  nativeAvailable: boolean;
  currentSourceId: string | null;
  currentClient: ConnectReceiverClient | null;
  metadata: ConnectMetadata | null;
  currentLyricLine: string | null;
  artworkUrl: string | null;
  positionSeconds: number;
  durationSeconds: number;
  volume: number;
  error: string | null;
  debugEvents: ConnectReceiverDebugEvent[];
  updatedAt: string;
};

export type ConnectReceiverStatus = {
  enabled: boolean;
  state: ConnectReceiverState;
  advertisedName: string;
  addresses: string[];
  currentClient: ConnectReceiverClient | null;
  currentUri: string | null;
  metadata: ConnectMetadata | null;
  positionSeconds: number;
  durationSeconds: number;
  volume: number;
  error: string | null;
  debugEvents: ConnectReceiverDebugEvent[];
  updatedAt: string;
};

export type ConnectPlaybackTarget = Pick<
  LibraryTrack,
  | 'id'
  | 'path'
  | 'mediaType'
  | 'title'
  | 'artist'
  | 'album'
  | 'albumArtist'
  | 'duration'
  | 'codec'
  | 'coverId'
  | 'coverThumb'
> & {
  sourceUrl?: string | null;
};

export type ConnectStartRequest = {
  deviceId: string;
  track?: ConnectPlaybackTarget | null;
  filePath?: string | null;
  positionSeconds?: number;
};
