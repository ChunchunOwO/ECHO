import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { ArrowLeft, Disc3, Music2 } from 'lucide-react';
import type { AudioStatus } from '../../shared/types/audio';
import type { LibraryTrack } from '../../shared/types/library';
import type { PlaybackStatus } from '../../shared/types/playback';
import { LyricsView } from '../components/lyrics/LyricsView';
import { MvPanel } from '../components/lyrics/MvPanel';
import type { LyricLine, LyricsState } from '../components/lyrics/lyricsTypes';
import { titleFromPath } from '../components/player/playerFormat';
import { usePlaybackQueue } from '../stores/PlaybackQueueProvider';

type LyricsPageProps = {
  initialLyrics?: LyricLine[];
};

type TrackWithLargeCover = LibraryTrack & {
  coverLarge?: string | null;
};

const idlePollingStates = new Set(['paused', 'stopped', 'idle', 'error']);

const emptyLyrics = (offsetMs = 0): LyricsState => ({
  kind: 'empty',
  source: 'none',
  lines: [],
  offsetMs,
});

const syncedLyrics = (lines: LyricLine[], offsetMs: number): LyricsState => ({
  kind: 'synced',
  source: 'placeholder',
  lines,
  offsetMs,
});

const safeCoverUrl = (track: LibraryTrack | null): string | null => {
  const coverLarge = (track as TrackWithLargeCover | null)?.coverLarge ?? null;
  const coverUrl = coverLarge ?? (track?.coverId ? `echo-cover://large/${encodeURIComponent(track.coverId)}` : track?.coverThumb ?? null);

  return coverUrl && !coverUrl.startsWith('data:') ? coverUrl : null;
};

const safeOriginalCoverUrl = (track: LibraryTrack | null): string | null => {
  const coverUrl = track?.coverId ? `echo-cover://original/${encodeURIComponent(track.coverId)}` : safeCoverUrl(track);

  return coverUrl && !coverUrl.startsWith('data:') ? coverUrl : null;
};

export const LyricsPage = ({ initialLyrics }: LyricsPageProps): JSX.Element => {
  const queue = usePlaybackQueue();
  const [playbackStatus, setPlaybackStatus] = useState<PlaybackStatus | null>(null);
  const [audioStatus, setAudioStatus] = useState<AudioStatus | null>(null);
  const [seekPreviewSeconds, setSeekPreviewSeconds] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const state = audioStatus?.state ?? playbackStatus?.state ?? 'idle';
  const pollIntervalMs = idlePollingStates.has(state) && seekPreviewSeconds === null ? 1800 : 500;
  const statusTrackId = playbackStatus?.currentTrackId ?? audioStatus?.currentTrackId ?? null;
  const currentTrack =
    queue.currentTrack ??
    (statusTrackId ? queue.tracks.find((track) => track.id === statusTrackId) ?? null : null) ??
    (queue.lastPlayedTrack?.id === statusTrackId ? queue.lastPlayedTrack : null);
  const filePath = currentTrack?.path ?? audioStatus?.currentFilePath ?? playbackStatus?.filePath ?? null;
  const title = currentTrack?.title ?? titleFromPath(filePath);
  const artist = currentTrack?.artist || currentTrack?.albumArtist || (filePath ? 'Local file' : 'Ready');
  const coverUrl = safeCoverUrl(currentTrack);
  const headerCoverUrl = safeOriginalCoverUrl(currentTrack);
  const positionSeconds = seekPreviewSeconds ?? audioStatus?.positionSeconds ?? (playbackStatus?.positionMs ?? 0) / 1000;
  const lyrics = useMemo(
    () => (initialLyrics && initialLyrics.length > 0 ? syncedLyrics(initialLyrics, 0) : emptyLyrics(0)),
    [initialLyrics],
  );

  const refreshStatus = useCallback(async (): Promise<void> => {
    const echo = window.echo;

    if (!echo) {
      setError('Desktop bridge unavailable');
      return;
    }

    try {
      const [nextPlaybackStatus, nextAudioStatus] = await Promise.all([
        echo.playback.getStatus(),
        echo.audio.getStatus(),
      ]);

      setPlaybackStatus(nextPlaybackStatus);
      setAudioStatus(nextAudioStatus);
      const nextTrackId = nextPlaybackStatus.currentTrackId ?? nextAudioStatus.currentTrackId ?? null;
      if (nextTrackId) {
        queue.setCurrentTrackId(nextTrackId);
      }
      setError(nextAudioStatus.error);
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : String(statusError));
    }
  }, [queue]);

  useEffect(() => {
    void refreshStatus();
    const timer = window.setInterval(() => {
      void refreshStatus();
    }, pollIntervalMs);

    return () => window.clearInterval(timer);
  }, [pollIntervalMs, refreshStatus]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        window.dispatchEvent(new Event('app:navigate:lyrics-back'));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleLyricSeek = useCallback(async (timeMs: number): Promise<void> => {
    const playback = window.echo?.playback;

    if (!playback) {
      setError('Desktop bridge unavailable');
      return;
    }

    const nextSeconds = Math.max(0, timeMs / 1000);
    try {
      setSeekPreviewSeconds(nextSeconds);
      setPlaybackStatus(await playback.seek(nextSeconds));
      await refreshStatus();
    } catch (seekError) {
      setError(seekError instanceof Error ? seekError.message : String(seekError));
    } finally {
      setSeekPreviewSeconds(null);
    }
  }, [refreshStatus]);

  if (!currentTrack && !filePath) {
    return (
      <div className="lyrics-page lyrics-page--empty">
        <button className="lyrics-back-button" type="button" aria-label="Back" title="Back" onClick={() => window.dispatchEvent(new Event('app:navigate:lyrics-back'))}>
          <ArrowLeft size={17} />
        </button>
        <section className="lyrics-no-track">
          <Music2 size={34} />
          <h1>Nothing is playing</h1>
          <p>Start a song from the library, then return here for lyrics and immersive playback.</p>
        </section>
      </div>
    );
  }

  return (
    <div className="lyrics-page" style={coverUrl ? ({ '--lyrics-cover': `url("${coverUrl}")` } as CSSProperties) : undefined}>
      <div className="lyrics-backdrop" aria-hidden="true" />

      <section className="lyrics-left-panel">
        <button className="lyrics-back-button" type="button" aria-label="Back" title="Back" onClick={() => window.dispatchEvent(new Event('app:navigate:lyrics-back'))}>
          <ArrowLeft size={17} />
        </button>

        <header className="lyrics-track-header">
          <div className="lyrics-track-cover" data-empty={!headerCoverUrl}>
            {headerCoverUrl ? <img alt="" draggable={false} src={headerCoverUrl} /> : <Disc3 size={26} />}
          </div>
          <div className="lyrics-track-copy">
            <span className="lyrics-kicker">Now Playing</span>
            <h1>{title}</h1>
            <p>{artist}</p>
          </div>
        </header>

        <LyricsView lyrics={lyrics} positionMs={positionSeconds * 1000} onSeek={(timeMs) => void handleLyricSeek(timeMs)} />
      </section>

      <MvPanel title={title} artist={artist} coverUrl={coverUrl} />

      {error ? <div className="lyrics-error" role="status">{error}</div> : null}
    </div>
  );
};
