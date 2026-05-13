import { useMemo } from 'react';
import { Music2 } from 'lucide-react';
import { LyricsLine } from './LyricsLine';
import type { LyricsState } from './lyricsTypes';

type LyricsViewProps = {
  lyrics: LyricsState;
  positionMs: number;
  onSeek: (timeMs: number) => void;
};

export const getActiveLyricIndex = (lines: LyricsState['lines'], positionMs: number, offsetMs: number): number => {
  if (lines.length === 0) {
    return -1;
  }

  const adjustedPositionMs = Math.max(0, positionMs + offsetMs);
  let activeIndex = 0;

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].timeMs > adjustedPositionMs) {
      break;
    }

    activeIndex = index;
  }

  return activeIndex;
};

export const LyricsView = ({ lyrics, onSeek, positionMs }: LyricsViewProps): JSX.Element => {
  const activeIndex = useMemo(
    () => getActiveLyricIndex(lyrics.lines, positionMs, lyrics.offsetMs),
    [lyrics.lines, lyrics.offsetMs, positionMs],
  );

  if (lyrics.lines.length === 0) {
    return (
      <section className="lyrics-empty" aria-label="Lyrics">
        <Music2 size={26} />
        <strong>{lyrics.source === 'none' ? '暂无歌词' : '纯音乐，请欣赏'}</strong>
        <span>Lyrics services are not connected in this phase.</span>
      </section>
    );
  }

  return (
    <section className="lyrics-scroll" aria-label="Lyrics">
      {lyrics.lines.map((line, index) => (
        <LyricsLine
          active={index === activeIndex}
          key={`${line.timeMs}-${index}`}
          line={line}
          past={index < activeIndex}
          onSeek={onSeek}
        />
      ))}
    </section>
  );
};

