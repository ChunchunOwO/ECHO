import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ChangeEvent, PointerEvent } from 'react';
import { Lock, Pause, Play, RotateCcw, SkipBack, SkipForward, Unlock, X } from 'lucide-react';
import type { AudioPlaybackState, AudioStatus } from '../../shared/types/audio';
import type { MiniPlayerState } from '../../shared/types/miniPlayer';
import type { PlaybackStatus } from '../../shared/types/playback';
import { isSpotifyTrack, pauseSpotifyPlayback, resumeSpotifyPlayback, seekSpotifyPlayback } from '../integrations/spotify/spotifyPlayback';
import { usePlaybackQueue } from '../stores/PlaybackQueueProvider';
import { getVisualPlaybackState, refreshPlaybackStatus, setPlaybackStatusSnapshot, useSharedPlaybackStatus } from '../stores/playbackStatusStore';
import { formatTime, titleFromPath } from '../components/player/playerFormat';

type ForwardedAudioStatus = {
  status: AudioStatus;
  updatedAtMs: number;
};

type MiniPlaybackClock = {
  durationSeconds: number;
  playbackRate: number;
  positionSeconds: number;
  sourcePositionSeconds: number;
  state: AudioPlaybackState;
  trackKey: string | null;
  updatedAtMs: number;
};

const progressRenderIntervalMs = 500;
const forwardedSystemStatusMaxAgeMs = 30_000;
const activeStates = new Set<AudioPlaybackState>(['loading', 'playing']);
const restartStates = new Set<AudioPlaybackState>(['idle', 'stopped', 'ended']);

const defaultMiniPlayerState: MiniPlayerState = {
  visible: true,
  locked: false,
  bounds: null,
  settings: {
    miniPlayerEnabled: true,
    miniPlayerLocked: false,
    miniPlayerBounds: null,
  },
};

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const playbackTrackKey = (audioStatus: AudioStatus | null, playbackStatus: PlaybackStatus | null, fallbackTrackId: string | null): string | null =>
  audioStatus?.currentTrackId ?? playbackStatus?.currentTrackId ?? fallbackTrackId ?? audioStatus?.currentFilePath ?? playbackStatus?.filePath ?? null;

const lightweightArtworkUrl = (track: { coverThumb: string | null } | null, audioStatus: AudioStatus | null): string | null =>
  track?.coverThumb ?? audioStatus?.currentTrackCoverUrl ?? null;

export const MiniPlayerApp = (): JSX.Element => {
  const queue = usePlaybackQueue();
  const setQueueCurrentTrackId = queue.setCurrentTrackId;
  const syncQueuePlaybackState = queue.syncPlaybackState;
  const sharedPlaybackStatus = useSharedPlaybackStatus();
  const [miniPlayerState, setMiniPlayerState] = useState<MiniPlayerState>(defaultMiniPlayerState);
  const [forwardedAudioStatus, setForwardedAudioStatus] = useState<ForwardedAudioStatus | null>(null);
  const [realtimePositionSeconds, setRealtimePositionSeconds] = useState(0);
  const [seekPreviewSeconds, setSeekPreviewSeconds] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clockRef = useRef<MiniPlaybackClock>({
    durationSeconds: 0,
    playbackRate: 1,
    positionSeconds: 0,
    sourcePositionSeconds: 0,
    state: 'idle',
    trackKey: null,
    updatedAtMs: performance.now(),
  });

  useEffect(() => {
    let cancelled = false;
    const miniPlayer = window.echo?.miniPlayer;
    if (!miniPlayer) {
      return undefined;
    }

    void miniPlayer.getState().then((state) => {
      if (!cancelled) {
        setMiniPlayerState(state);
      }
    }).catch(() => undefined);

    const unsubscribe = miniPlayer.onStateChanged?.((state) => {
      setMiniPlayerState(state);
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const desktopLyrics = window.echo?.desktopLyrics;
    if (!desktopLyrics) {
      return undefined;
    }

    const getLastAudioStatus = desktopLyrics.getLastAudioStatus;
    if (getLastAudioStatus) {
      void getLastAudioStatus().then((status) => {
        if (!cancelled && status) {
          setForwardedAudioStatus({ status, updatedAtMs: Date.now() });
        }
      }).catch(() => undefined);
    }

    const unsubscribe = desktopLyrics.onAudioStatus?.((status) => {
      setForwardedAudioStatus({ status, updatedAtMs: Date.now() });
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const activeAudioStatus = useMemo(() => {
    const forwarded = forwardedAudioStatus;
    if (
      forwarded?.status.outputMode === 'system' &&
      Date.now() - forwarded.updatedAtMs <= forwardedSystemStatusMaxAgeMs
    ) {
      return forwarded.status;
    }

    return sharedPlaybackStatus.audioStatus;
  }, [forwardedAudioStatus, sharedPlaybackStatus.audioStatus, sharedPlaybackStatus.version]);

  const playbackStatus = sharedPlaybackStatus.playbackStatus;
  const visualState = getVisualPlaybackState({
    audioStatus: activeAudioStatus,
    playbackStatus,
    playbackVisualIntent: sharedPlaybackStatus.playbackVisualIntent,
  });
  const statusTrackId = activeAudioStatus?.currentTrackId ?? playbackStatus?.currentTrackId ?? null;
  const statusFilePath = activeAudioStatus?.currentFilePath ?? playbackStatus?.filePath ?? null;
  const statusMatchedTrack =
    (statusTrackId
      ? queue.tracks.find((track) => track.id === statusTrackId) ??
        (queue.currentTrack?.id === statusTrackId ? queue.currentTrack : null) ??
        (queue.lastPlayedTrack?.id === statusTrackId ? queue.lastPlayedTrack : null)
      : null) ??
    (statusFilePath
      ? queue.tracks.find((track) => track.path === statusFilePath) ??
        (queue.currentTrack?.path === statusFilePath ? queue.currentTrack : null) ??
        (queue.lastPlayedTrack?.path === statusFilePath ? queue.lastPlayedTrack : null)
      : null);
  const trackId = statusTrackId ?? statusMatchedTrack?.id ?? queue.currentTrackId ?? null;
  const currentTrack =
    statusMatchedTrack ??
    (!statusTrackId && !statusFilePath
      ? queue.currentTrack ??
        queue.tracks.find((track) => track.id === trackId) ??
        (queue.lastPlayedTrack?.id === trackId ? queue.lastPlayedTrack : null)
      : null);
  const filePath = currentTrack?.path ?? statusFilePath;
  const title = currentTrack?.title?.trim() || activeAudioStatus?.currentTrackTitle?.trim() || titleFromPath(filePath);
  const artist =
    currentTrack?.artist?.trim() ||
    currentTrack?.albumArtist?.trim() ||
    activeAudioStatus?.currentTrackArtist?.trim() ||
    activeAudioStatus?.currentTrackAlbumArtist?.trim() ||
    (filePath ? 'Unknown Artist' : 'Ready');
  const artworkUrl = lightweightArtworkUrl(currentTrack, activeAudioStatus);
  const isSpotifyCurrentTrack = isSpotifyTrack(currentTrack);
  const playbackRate = activeAudioStatus?.playbackRate ?? 1;
  const durationSeconds = Math.max(
    0,
    activeAudioStatus?.durationSeconds ??
      (playbackStatus?.durationMs ? playbackStatus.durationMs / 1000 : currentTrack?.duration ?? 0),
  );
  const sourcePositionSeconds = Math.max(0, activeAudioStatus?.positionSeconds ?? (playbackStatus?.positionMs ?? 0) / 1000);
  const progressTrackKey = playbackTrackKey(activeAudioStatus, playbackStatus, currentTrack?.id ?? trackId);
  const positionSeconds = seekPreviewSeconds ?? realtimePositionSeconds;
  const progress = durationSeconds > 0 ? clamp(positionSeconds / durationSeconds, 0, 1) : 0;
  const hasPlayableTarget = Boolean(filePath || currentTrack || playbackStatus || activeAudioStatus);

  useEffect(() => {
    if (trackId) {
      setQueueCurrentTrackId(trackId);
    }
  }, [setQueueCurrentTrackId, trackId]);

  useEffect(() => {
    syncQueuePlaybackState(visualState);
  }, [syncQueuePlaybackState, visualState]);

  useEffect(() => {
    const now = performance.now();
    const previous = clockRef.current;
    const samePlayback = previous.trackKey === progressTrackKey;
    const boundedSourcePosition = durationSeconds > 0 ? clamp(sourcePositionSeconds, 0, durationSeconds) : Math.max(0, sourcePositionSeconds);
    let nextPositionSeconds = boundedSourcePosition;

    if (samePlayback && previous.state === 'playing' && visualState === 'playing') {
      const estimatedPositionSeconds = previous.positionSeconds + ((now - previous.updatedAtMs) / 1000) * previous.playbackRate;
      const boundedEstimate = durationSeconds > 0 ? clamp(estimatedPositionSeconds, 0, durationSeconds) : Math.max(0, estimatedPositionSeconds);
      if (boundedSourcePosition + 1.25 < boundedEstimate) {
        nextPositionSeconds = boundedEstimate;
      }
    }

    clockRef.current = {
      durationSeconds,
      playbackRate,
      positionSeconds: nextPositionSeconds,
      sourcePositionSeconds: boundedSourcePosition,
      state: visualState,
      trackKey: progressTrackKey,
      updatedAtMs: now,
    };
    setRealtimePositionSeconds(nextPositionSeconds);
  }, [durationSeconds, playbackRate, progressTrackKey, sourcePositionSeconds, visualState]);

  useEffect(() => {
    if (visualState !== 'playing' || seekPreviewSeconds !== null) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      const clock = clockRef.current;
      if (clock.state !== 'playing') {
        return;
      }
      const elapsedSeconds = ((performance.now() - clock.updatedAtMs) / 1000) * clock.playbackRate;
      const nextPosition = clock.positionSeconds + elapsedSeconds;
      setRealtimePositionSeconds(clock.durationSeconds > 0 ? clamp(nextPosition, 0, clock.durationSeconds) : Math.max(0, nextPosition));
    }, progressRenderIntervalMs);

    return () => window.clearInterval(timer);
  }, [seekPreviewSeconds, visualState]);

  const runPlaybackAction = useCallback(async (action: () => Promise<PlaybackStatus | null | void>): Promise<void> => {
    try {
      setError(null);
      const status = await action();
      if (status) {
        setPlaybackStatusSnapshot({ playbackStatus: status, error: null });
      }
      void refreshPlaybackStatus();
    } catch (actionError) {
      const message = actionError instanceof Error ? actionError.message : String(actionError);
      setError(message);
      setPlaybackStatusSnapshot({ error: message });
    }
  }, []);

  const handlePlayPause = useCallback(async (): Promise<void> => {
    const playback = window.echo?.playback;

    if (queue.hqPlayerTakeoverEnabled) {
      if (activeStates.has(visualState)) {
        setError('HQPlayer 接管中');
        return;
      }

      await runPlaybackAction(queue.activateHqPlayerTakeover);
      return;
    }

    if (isSpotifyCurrentTrack && currentTrack) {
      await runPlaybackAction(() => (activeStates.has(visualState) ? pauseSpotifyPlayback(currentTrack) : resumeSpotifyPlayback(currentTrack)));
      return;
    }

    if (!playback) {
      setError('Desktop bridge unavailable');
      return;
    }

    await runPlaybackAction(async () => {
      if (activeStates.has(visualState)) {
        return playback.pause();
      }

      const latestStatus = await playback.getStatus();
      if (activeStates.has(latestStatus.state)) {
        return playback.pause();
      }
      if (restartStates.has(latestStatus.state) && queue.currentItem) {
        return queue.playQueueItem(queue.currentItem.queueId);
      }
      if (restartStates.has(latestStatus.state) && currentTrack) {
        return queue.playTrack(currentTrack);
      }
      return playback.play();
    });
  }, [currentTrack, isSpotifyCurrentTrack, queue, runPlaybackAction, visualState]);

  const handlePrevious = useCallback((): void => {
    void runPlaybackAction(queue.playPrevious);
  }, [queue.playPrevious, runPlaybackAction]);

  const handleNext = useCallback((): void => {
    void runPlaybackAction(queue.playNext);
  }, [queue.playNext, runPlaybackAction]);

  const commitSeek = useCallback(
    async (nextPositionSeconds: number): Promise<void> => {
      const safePositionSeconds = durationSeconds > 0 ? clamp(nextPositionSeconds, 0, durationSeconds) : Math.max(0, nextPositionSeconds);

      await runPlaybackAction(async () => {
        if (isSpotifyCurrentTrack && currentTrack) {
          return seekSpotifyPlayback(currentTrack, safePositionSeconds);
        }

        if (queue.hqPlayerTakeoverEnabled) {
          const connectStatus = await window.echo?.connect?.seek?.(safePositionSeconds);
          if (connectStatus) {
            return {
              state: connectStatus.state === 'playing' ? 'playing' : connectStatus.state === 'paused' ? 'paused' : 'loading',
              currentTrackId: connectStatus.currentTrackId ?? trackId,
              positionMs: Math.round(Math.max(0, connectStatus.positionSeconds) * 1000),
              durationMs: Math.round(Math.max(0, connectStatus.durationSeconds) * 1000),
              filePath,
            };
          }
        }

        return window.echo?.playback?.seek?.(safePositionSeconds);
      });
      setRealtimePositionSeconds(safePositionSeconds);
      setSeekPreviewSeconds(null);
    },
    [currentTrack, durationSeconds, filePath, isSpotifyCurrentTrack, queue.hqPlayerTakeoverEnabled, runPlaybackAction, trackId],
  );

  const handleProgressChange = (event: ChangeEvent<HTMLInputElement>): void => {
    setSeekPreviewSeconds(Number(event.currentTarget.value));
  };

  const handleProgressPointerUp = (event: PointerEvent<HTMLInputElement>): void => {
    void commitSeek(Number(event.currentTarget.value));
  };

  const handleLockToggle = useCallback((): void => {
    void window.echo?.miniPlayer?.setLocked?.(!miniPlayerState.locked).then(setMiniPlayerState).catch(() => undefined);
  }, [miniPlayerState.locked]);

  const handleResetBounds = useCallback((): void => {
    void window.echo?.miniPlayer?.resetBounds?.().then(setMiniPlayerState).catch(() => undefined);
  }, []);

  const style = {
    '--mini-player-progress': `${progress * 100}%`,
  } as CSSProperties;

  return (
    <main
      className="mini-player-app"
      data-has-artwork={Boolean(artworkUrl)}
      data-locked={miniPlayerState.locked}
      data-playback-state={visualState}
      style={style}
    >
      <section className="mini-player-shell" aria-label="迷你播放器">
        <div className="mini-player-cover" data-empty={!artworkUrl}>
          {artworkUrl ? (
            <img alt="" draggable={false} src={artworkUrl} />
          ) : (
            <span className="mini-player-cover-mark" />
          )}
        </div>

        <div className="mini-player-main">
          <div className="mini-player-title-row">
            <div className="mini-player-copy">
              <strong title={title}>{title}</strong>
              <span title={artist}>{artist}</span>
            </div>
            <div className="mini-player-transport">
              <button
                aria-label="上一首"
                className="mini-player-icon-button mini-player-icon-button--transport"
                disabled={!queue.canGoPrevious}
                title="上一首"
                type="button"
                onClick={handlePrevious}
              >
                <SkipBack size={15} />
              </button>
              <button
                aria-label={activeStates.has(visualState) ? '暂停' : '播放'}
                className="mini-player-icon-button mini-player-icon-button--play"
                disabled={!hasPlayableTarget}
                title={activeStates.has(visualState) ? '暂停' : '播放'}
                type="button"
                onClick={() => void handlePlayPause()}
              >
                {activeStates.has(visualState) ? <Pause size={16} /> : <Play size={16} />}
              </button>
              <button
                aria-label="下一首"
                className="mini-player-icon-button mini-player-icon-button--transport"
                disabled={!queue.canGoNext}
                title="下一首"
                type="button"
                onClick={handleNext}
              >
                <SkipForward size={15} />
              </button>
            </div>
            <div className="mini-player-actions">
              <button
                aria-label={miniPlayerState.locked ? '解除鼠标穿透' : '锁定并开启鼠标穿透'}
                className="mini-player-icon-button"
                title={miniPlayerState.locked ? '解除鼠标穿透' : '锁定并开启鼠标穿透'}
                type="button"
                onClick={handleLockToggle}
              >
                {miniPlayerState.locked ? <Unlock size={13} /> : <Lock size={13} />}
              </button>
              <button
                aria-label="重置位置"
                className="mini-player-icon-button"
                title="重置位置"
                type="button"
                onClick={handleResetBounds}
              >
                <RotateCcw size={13} />
              </button>
              <button
                aria-label="关闭迷你播放器"
                className="mini-player-icon-button"
                title="关闭"
                type="button"
                onClick={() => void window.echo?.miniPlayer?.hide?.()}
              >
                <X size={13} />
              </button>
            </div>
          </div>

          <div className="mini-player-progress-row">
            <span>{formatTime(positionSeconds)}</span>
            <input
              aria-label="播放进度"
              disabled={!durationSeconds || !hasPlayableTarget}
              max={Math.max(1, durationSeconds)}
              min={0}
              step={0.5}
              type="range"
              value={clamp(positionSeconds, 0, Math.max(1, durationSeconds))}
              onChange={handleProgressChange}
              onPointerUp={handleProgressPointerUp}
            />
            <span>{formatTime(durationSeconds)}</span>
          </div>
          {error ? <p className="mini-player-error" title={error}>{error}</p> : null}
        </div>
      </section>
    </main>
  );
};
