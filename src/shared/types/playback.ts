import type { AudioOutputSettings, AudioPlaybackState } from './audio';
import type { LibraryTrack } from './library';
import type { PlayableTrack } from './remoteSources';

export type PlaybackStatus = {
  state: AudioPlaybackState;
  currentTrackId: string | null;
  positionMs: number;
  durationMs: number;
  filePath: string | null;
};

export type PlaybackProbeHint = {
  durationSeconds?: number;
  fileSampleRate?: number | null;
  channels?: number;
  codec?: string | null;
  bitDepth?: number | null;
  bitrate?: number | null;
  bpm?: number | null;
  bpmConfidence?: number | null;
  beatOffsetMs?: number | null;
};

export type PlaybackAutomixOptions = {
  enabled?: boolean;
  maxTransitionSeconds?: number;
  beatAlignEnabled?: boolean;
  nextItem?: PlayableTrack | null;
  nextProbe?: PlaybackProbeHint;
  upcomingItems?: PlayableTrack[];
  upcomingProbes?: PlaybackProbeHint[];
};

export type PlaybackStartRequest = {
  filePath: string;
  trackId?: string;
  startSeconds?: number;
  output?: AudioOutputSettings;
  probe?: PlaybackProbeHint;
  automix?: PlaybackAutomixOptions;
};

export type PlaybackPrepareLocalFileRequest = {
  filePath: string;
  trackId?: string;
  probe?: PlaybackProbeHint;
};

export type PlaybackMediaStartRequest = {
  item: PlayableTrack;
  startSeconds?: number;
  output?: AudioOutputSettings;
  automix?: PlaybackAutomixOptions;
};

export type LocalFileOpenRejectionReason = 'missing' | 'not_file' | 'unsupported';

export type LocalFileOpenRejection = {
  path: string;
  reason: LocalFileOpenRejectionReason;
};

export type LocalFileResolveResult = {
  tracks: LibraryTrack[];
  rejected: LocalFileOpenRejection[];
};
