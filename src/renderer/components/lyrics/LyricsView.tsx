import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Music2 } from 'lucide-react';
import { LyricsLine } from './LyricsLine';
import type { LyricsState } from './lyricsTypes';

type LyricScrollMode = 'animated' | 'instant' | 'recenter';

type LyricsViewProps = {
  lyrics: LyricsState;
  durationMs?: number | null;
  positionMs: number;
  onSeek: (timeMs: number) => void;
  hideEmptyState?: boolean;
  showRomanization?: boolean;
  showTranslation?: boolean;
};

export const getActiveLyricIndex = (lines: LyricsState['lines'], positionMs: number, offsetMs: number): number => {
  if (lines.length === 0 || lines.every((line) => line.timeMs < 0)) {
    return -1;
  }

  const adjustedPositionMs = Math.max(0, positionMs + offsetMs);
  let activeIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const timeMs = lines[index].timeMs;
    if (timeMs < 0) {
      continue;
    }

    if (timeMs > adjustedPositionMs) {
      break;
    }

    activeIndex = index;
  }

  return activeIndex;
};

export const getEstimatedPlainLyricIndex = (
  lines: LyricsState['lines'],
  positionMs: number,
  durationMs?: number | null,
): number => {
  if (lines.length === 0 || !durationMs || durationMs <= 0 || !Number.isFinite(durationMs)) {
    return lines.length > 0 ? 0 : -1;
  }

  const progress = Math.max(0, Math.min(0.999999, positionMs / durationMs));
  return Math.max(0, Math.min(lines.length - 1, Math.floor(progress * lines.length)));
};

const easeInOutCubic = (progress: number): number =>
  progress < 0.5
    ? 4 * progress ** 3
    : 1 - ((-2 * progress + 2) ** 3) / 2;

const getAnimationNow = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

const requestLyricAnimationFrame = (callback: FrameRequestCallback): number => {
  if (typeof window.requestAnimationFrame === 'function') {
    return window.requestAnimationFrame(callback);
  }

  return window.setTimeout(() => {
    callback(getAnimationNow());
  }, 16);
};

const cancelLyricAnimationFrame = (frameId: number): void => {
  if (typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(frameId);
    return;
  }

  window.clearTimeout(frameId);
};

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export const LyricsView = ({
  durationMs,
  hideEmptyState = false,
  lyrics,
  onSeek,
  positionMs,
  showRomanization = true,
  showTranslation = true,
}: LyricsViewProps): JSX.Element | null => {
  const scrollRef = useRef<HTMLElement | null>(null);
  const scrollAnimationFrameRef = useRef<number | null>(null);
  const activeCenterFrameRef = useRef<number | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const isSynced = lyrics.kind === 'synced';
  const isPlain = lyrics.kind === 'plain';
  const activeIndex = useMemo(
    () =>
      isSynced
        ? getActiveLyricIndex(lyrics.lines, positionMs, lyrics.offsetMs)
        : isPlain
          ? getEstimatedPlainLyricIndex(lyrics.lines, positionMs, durationMs)
          : -1,
    [durationMs, isPlain, isSynced, lyrics.lines, lyrics.offsetMs, positionMs],
  );

  const stopScrollAnimation = useCallback((): void => {
    if (scrollAnimationFrameRef.current !== null) {
      cancelLyricAnimationFrame(scrollAnimationFrameRef.current);
      scrollAnimationFrameRef.current = null;
    }
  }, []);

  const animateScrollTop = useCallback(
    (scrollContainer: HTMLElement, targetTop: number, durationMs: number): void => {
      stopScrollAnimation();

      const startTop = scrollContainer.scrollTop;
      const distance = targetTop - startTop;
      if (Math.abs(distance) < 1 || durationMs <= 0 || prefersReducedMotion()) {
        scrollContainer.scrollTop = targetTop;
        return;
      }

      const startedAt = getAnimationNow();
      const tick = (now: number): void => {
        const elapsed = now - startedAt;
        const progress = Math.min(1, elapsed / durationMs);
        scrollContainer.scrollTop = startTop + distance * easeInOutCubic(progress);

        if (progress < 1) {
          scrollAnimationFrameRef.current = requestLyricAnimationFrame(tick);
          return;
        }

        scrollAnimationFrameRef.current = null;
        scrollContainer.scrollTop = targetTop;
      };

      scrollAnimationFrameRef.current = requestLyricAnimationFrame(tick);
    },
    [stopScrollAnimation],
  );

  const centerActiveLyric = useCallback((mode: LyricScrollMode = 'animated'): void => {
    if (activeIndex < 0) {
      return;
    }

    const scrollContainer = scrollRef.current;
    const activeLine = scrollContainer?.querySelector<HTMLButtonElement>('.lyrics-line[data-active="true"]');
    if (!scrollContainer || !activeLine) {
      return;
    }

    const containerRect = scrollContainer.getBoundingClientRect();
    const activeRect = activeLine.getBoundingClientRect();
    const activeCenter = activeRect.top - containerRect.top + scrollContainer.scrollTop + activeRect.height / 2;
    const targetCenter = scrollContainer.clientHeight * 0.52;
    const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
    const nextScrollTop = Math.max(0, Math.min(maxScrollTop, activeCenter - targetCenter));

    if (mode === 'instant') {
      stopScrollAnimation();
      scrollContainer.scrollTop = nextScrollTop;
      return;
    }

    animateScrollTop(scrollContainer, nextScrollTop, mode === 'recenter' ? 260 : 880);
  }, [activeIndex, animateScrollTop, stopScrollAnimation]);

  useEffect(() => {
    if (activeCenterFrameRef.current !== null) {
      cancelLyricAnimationFrame(activeCenterFrameRef.current);
    }

    activeCenterFrameRef.current = requestLyricAnimationFrame(() => {
      activeCenterFrameRef.current = null;
      centerActiveLyric('animated');
    });

    return () => {
      if (activeCenterFrameRef.current !== null) {
        cancelLyricAnimationFrame(activeCenterFrameRef.current);
        activeCenterFrameRef.current = null;
      }
    };
  }, [centerActiveLyric]);

  useEffect(() => {
    const scrollContainer = scrollRef.current;
    if (!scrollContainer || activeIndex < 0) {
      return undefined;
    }

    const scheduleRecenter = (): void => {
      if (resizeFrameRef.current !== null) {
        cancelLyricAnimationFrame(resizeFrameRef.current);
      }

      resizeFrameRef.current = requestLyricAnimationFrame(() => {
        resizeFrameRef.current = null;
        centerActiveLyric('recenter');
      });
    };

    const observer =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(scheduleRecenter)
        : null;
    observer?.observe(scrollContainer);
    window.addEventListener('resize', scheduleRecenter);

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', scheduleRecenter);
      if (resizeFrameRef.current !== null) {
        cancelLyricAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
    };
  }, [activeIndex, centerActiveLyric]);

  useEffect(
    () => () => {
      stopScrollAnimation();
      if (activeCenterFrameRef.current !== null) {
        cancelLyricAnimationFrame(activeCenterFrameRef.current);
        activeCenterFrameRef.current = null;
      }
      if (resizeFrameRef.current !== null) {
        cancelLyricAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
    },
    [stopScrollAnimation],
  );

  if (lyrics.lines.length === 0) {
    if (hideEmptyState) {
      return null;
    }

    return (
      <section className="lyrics-empty" aria-label="Lyrics">
        <Music2 size={26} />
        <strong>{lyrics.kind === 'instrumental' ? '纯音乐，请欣赏' : '暂无歌词'}</strong>
        {lyrics.kind === 'instrumental' ? <span>Instrumental track</span> : null}
      </section>
    );
  }

  return (
    <section className="lyrics-scroll" aria-label="Lyrics" data-kind={lyrics.kind} ref={scrollRef}>
      {lyrics.lines.map((line, index) => (
        <LyricsLine
          active={index === activeIndex}
          focusDistance={activeIndex >= 0 ? Math.abs(index - activeIndex) : 4}
          key={`${line.timeMs}-${index}`}
          line={line}
          past={activeIndex >= 0 && index < activeIndex}
          showRomanization={showRomanization}
          showTranslation={showTranslation}
          onSeek={onSeek}
          seekable={isSynced && line.timeMs >= 0}
        />
      ))}
    </section>
  );
};
