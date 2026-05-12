import type { PlaybackSpeedMode } from './audio';

export type AppSettings = {
  coverCacheDir: string | null;
  hideToTrayOnClose: boolean;
  networkMetadataEnabled: boolean;
  networkMetadataProviders: Array<'mock' | 'musicbrainz' | 'cover-art-archive' | 'netease-cloud-music' | 'qq-music'>;
  playerVolume: number;
  playbackSpeed: number;
  playbackSpeedMode: PlaybackSpeedMode;
};
