import type { LyricLine as LyricLineType } from './lyricsTypes';

type LyricsLineProps = {
  line: LyricLineType;
  active: boolean;
  past: boolean;
  onSeek: (timeMs: number) => void;
};

export const LyricsLine = ({ active, line, onSeek, past }: LyricsLineProps): JSX.Element => (
  <button
    className="lyrics-line"
    data-active={active}
    data-past={past}
    type="button"
    onClick={() => onSeek(line.timeMs)}
  >
    <span>{line.text}</span>
    {line.translation ? <em>{line.translation}</em> : null}
    {line.romanization ? <small>{line.romanization}</small> : null}
  </button>
);

