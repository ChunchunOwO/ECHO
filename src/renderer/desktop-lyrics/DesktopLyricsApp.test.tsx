// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { shouldShowDesktopLyricsText } from './DesktopLyricsApp';

describe('desktop lyrics text fitting', () => {
  it('hides text that would overflow the desktop lyrics window', () => {
    expect(shouldShowDesktopLyricsText({
      text: '短歌词',
      availableWidthPx: 320,
      fontSizePx: 34,
      fontFamily: '"Microsoft YaHei", sans-serif',
      fontWeight: 700,
      scalePercent: 100,
    })).toBe(true);

    expect(shouldShowDesktopLyricsText({
      text: 'これはとてもとてもとてもとても長いデスクトップ歌詞です',
      availableWidthPx: 320,
      fontSizePx: 34,
      fontFamily: '"Microsoft YaHei", sans-serif',
      fontWeight: 700,
      scalePercent: 100,
    })).toBe(false);
  });
});
