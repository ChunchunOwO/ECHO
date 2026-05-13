import { useCallback, useEffect, useState } from 'react';
import { Disc3, Mic2, Music2 } from 'lucide-react';
import type { AudioStatus } from '../../shared/types/audio';
import type { PlaybackStatus } from '../../shared/types/playback';
import { PlayerStatusChips } from '../components/player/PlayerStatusChips';
import { titleFromPath } from '../components/player/playerFormat';
import { usePlaybackQueue } from '../stores/PlaybackQueueProvider';

const idlePollingStates = new Set(['paused', 'stopped', 'idle', 'error']);

export const NowPlayingPage = (): JSX.Element => {
  const queue = usePlaybackQueue();
  const [playbackStatus, setPlaybackStatus] = useState<PlaybackStatus | null>(null);
  const [audioStatus, setAudioStatus] = useState<AudioStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const state = audioStatus?.state ?? playbackStatus?.state ?? 'idle';
  const pollIntervalMs = idlePollingStates.has(state) ? 1800 : 500;
  const statusTrackId = playbackStatus?.currentTrackId ?? audioStatus?.currentTrackId ?? null;
  const currentTrack =
    queue.currentTrack ??
    (statusTrackId ? queue.tracks.find((track) => track.id === statusTrackId) ?? null : null) ??
    (queue.lastPlayedTrack?.id === statusTrackId ? queue.lastPlayedTrack : null);
  const filePath = currentTrack?.path ?? audioStatus?.currentFilePath ?? playbackStatus?.filePath ?? null;
  const title = currentTrack?.title ?? titleFromPath(filePath);
  const artist = currentTrack?.artist || currentTrack?.albumArtist || (filePath ? 'Local file' : 'Ready');
  const coverUrl = currentTrack?.coverThumb ?? null;

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

  return (
    <div className="page-stack now-playing-page">
      <section className="page-header">
        <div>
          <p className="section-kicker">Now Playing</p>
          <h1>正在播放</h1>
          <p>当前曲目概览。歌词请从底部播放器的麦克风按钮进入独立页面。</p>
        </div>
        <button className="primary-action" type="button" onClick={() => window.dispatchEvent(new Event('app:navigate:lyrics'))}>
          <Mic2 size={17} />
          打开歌词
        </button>
      </section>

      <section className="now-playing-card">
        <div className="now-playing-cover" data-empty={!coverUrl}>
          {coverUrl ? <img alt="" src={coverUrl} /> : <Disc3 size={34} />}
        </div>
        <div className="now-playing-copy">
          <span>{currentTrack || filePath ? 'Playing' : 'Idle'}</span>
          <h2>{currentTrack || filePath ? title : 'Nothing is playing'}</h2>
          <p>{artist}</p>
          <PlayerStatusChips status={audioStatus} state={state} track={currentTrack} />
          {error ? <strong className="now-playing-error">{error}</strong> : null}
        </div>
      </section>

      {!currentTrack && !filePath ? (
        <section className="empty-inline">
          <Music2 size={28} />
          <span>从歌曲列表或专辑开始播放后，这里会显示当前曲目。</span>
        </section>
      ) : null}
    </div>
  );
};
