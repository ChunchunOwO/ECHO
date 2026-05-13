export type LyricLine = {
  timeMs: number;
  text: string;
  translation?: string | null;
  romanization?: string | null;
};

export type LyricsState = {
  kind: 'empty' | 'plain' | 'synced';
  source: 'none' | 'local' | 'online' | 'placeholder';
  lines: LyricLine[];
  offsetMs: number;
};

