import { useCallback, useEffect, useRef, useState } from 'react';
import type { WheelEvent } from 'react';
import { Gauge, RotateCcw } from 'lucide-react';
import type { AudioStatus, PlaybackSpeedMode } from '../../../shared/types/audio';

type PlayerSpeedControlProps = {
  status: AudioStatus | null;
  onStatusChange: (status: AudioStatus) => void;
  onError: (message: string) => void;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
};

const clampPlaybackRate = (value: number): number => Math.max(0.5, Math.min(2, value));
const formatSpeed = (value: number): string => `${clampPlaybackRate(value).toFixed(2)}x`;
const speedFromStatus = (status: AudioStatus | null): number => clampPlaybackRate(status?.playbackRate ?? 1);
const modeFromStatus = (status: AudioStatus | null): PlaybackSpeedMode => status?.playbackSpeedMode ?? 'nightcore';

export const PlayerSpeedControl = ({
  status,
  onStatusChange,
  onError,
  isOpen,
  onOpenChange,
}: PlayerSpeedControlProps): JSX.Element => {
  const [playbackRate, setPlaybackRate] = useState(speedFromStatus(status));
  const [mode, setMode] = useState<PlaybackSpeedMode>(modeFromStatus(status));
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pendingCommitRef = useRef<{ playbackRate: number; mode: PlaybackSpeedMode } | null>(null);

  useEffect(() => {
    setPlaybackRate(speedFromStatus(status));
    setMode(modeFromStatus(status));
  }, [status]);

  useEffect(() => {
    const getSettings = window.echo?.app?.getSettings;
    const audio = window.echo?.audio;

    if (typeof getSettings !== 'function' || !audio) {
      return;
    }

    let isCancelled = false;
    void getSettings()
      .then(async (settings) => {
        if (isCancelled) {
          return;
        }

        const nextRate = clampPlaybackRate(settings.playbackSpeed);
        const nextMode = settings.playbackSpeedMode ?? 'nightcore';
        setPlaybackRate(nextRate);
        setMode(nextMode);
        const nextStatus = await audio.setOutput({ playbackRate: nextRate, playbackSpeedMode: nextMode });
        if (!isCancelled) {
          onStatusChange(nextStatus);
        }
      })
      .catch(() => undefined);

    return () => {
      isCancelled = true;
    };
  }, [onStatusChange]);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const handlePointerDown = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node)) {
        return;
      }

      onOpenChange(false);
    };

    window.addEventListener('pointerdown', handlePointerDown, true);
    return () => window.removeEventListener('pointerdown', handlePointerDown, true);
  }, [isOpen, onOpenChange]);

  const commitSpeed = useCallback(
    async (nextPlaybackRate: number): Promise<void> => {
      const audio = window.echo?.audio;
      const safeRate = clampPlaybackRate(nextPlaybackRate);
      setPlaybackRate(safeRate);
      pendingCommitRef.current = { playbackRate: safeRate, mode };

      if (!audio) {
        onError('Desktop bridge unavailable');
        return;
      }

      try {
        const nextStatus = await audio.setOutput({ playbackRate: safeRate, playbackSpeedMode: mode });
        const setSettings = window.echo?.app?.setSettings;
        if (typeof setSettings === 'function') {
          void setSettings({ playbackSpeed: safeRate }).catch(() => undefined);
        }
        const pending = pendingCommitRef.current;
        if (pending?.playbackRate === safeRate && pending.mode === mode) {
          onStatusChange(nextStatus);
        }
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
      }
    },
    [mode, onError, onStatusChange],
  );

  const handleWheel = (event: WheelEvent<HTMLDivElement>): void => {
    event.preventDefault();
    onOpenChange(true);
    const direction = event.deltaY > 0 ? -1 : 1;
    void commitSpeed(playbackRate + direction * 0.05);
  };

  return (
    <div className="speed-control" ref={rootRef} onMouseEnter={() => onOpenChange(true)} onWheel={handleWheel}>
      <button
        className="icon-button"
        type="button"
        aria-label="播放速度"
        title="播放速度"
        onClick={() => onOpenChange(true)}
        onFocus={() => onOpenChange(true)}
      >
        <Gauge size={17} />
      </button>
      {isOpen ? (
        <div className="speed-popover">
          <div className="speed-popover-header">
            <span>{formatSpeed(playbackRate)}</span>
            <button
              className="speed-reset-button"
              type="button"
              aria-label="重置播放速度"
              title="重置播放速度"
              disabled={playbackRate === 1}
              onClick={() => void commitSpeed(1)}
            >
              <RotateCcw size={12} />
            </button>
          </div>
          <input
            aria-label="播放速度"
            max={2}
            min={0.5}
            onChange={(event) => setPlaybackRate(Number(event.currentTarget.value))}
            onKeyUp={(event) => {
              if (event.key === 'Enter' || event.key === ' ' || event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') {
                void commitSpeed(Number(event.currentTarget.value));
              }
            }}
            onPointerUp={(event) => void commitSpeed(Number(event.currentTarget.value))}
            step={0.05}
            type="range"
            value={playbackRate}
          />
        </div>
      ) : null}
    </div>
  );
};
