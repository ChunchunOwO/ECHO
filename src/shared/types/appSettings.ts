import type { ChannelBalanceState, PlaybackSpeedMode } from './audio';

export type ScanPerformanceMode = 'low' | 'balanced' | 'performance';

export type AppSettings = {
  albumMergeStrategy: 'standard' | 'sameTitleAndCover';
  artistWallAlbumArtwork: boolean;
  coverCacheDir: string | null;
  hideToTrayOnClose: boolean;
  networkMetadataEnabled: boolean;
  networkMetadataProviders: Array<'mock' | 'musicbrainz' | 'cover-art-archive' | 'netease-cloud-music' | 'qq-music'>;
  channelBalance: ChannelBalanceState;
  playerVolume: number;
  playbackSpeed: number;
  playbackSpeedMode: PlaybackSpeedMode;
  scanPerformanceMode: ScanPerformanceMode;
  discordRichPresenceEnabled: boolean;
  lastFmEnabled: boolean;
  lastFmUsername: string | null;
  lastFmSessionKey: string | null;
  lastFmScrobbleEnabled: boolean;
  lastFmNowPlayingEnabled: boolean;
  lastFmMinScrobbleSeconds: number;
  lastFmAuthToken: string | null;
  smtcEnabled: boolean;
};
