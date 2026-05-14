// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { LyricsLine } from './LyricsLine';

afterEach(() => {
  cleanup();
});

describe('LyricsLine', () => {
  const line = { timeMs: 1000, text: 'さくら', romanization: 'sakura', translation: '樱花' };

  it('shows romanization when enabled', () => {
    render(<LyricsLine active={false} line={line} past={false} onSeek={vi.fn()} />);

    expect(screen.getByText('sakura')).toBeTruthy();
  });

  it('hides romanization when disabled', () => {
    render(<LyricsLine active={false} line={line} past={false} showRomanization={false} onSeek={vi.fn()} />);

    expect(screen.queryByText('sakura')).toBeNull();
    expect(screen.getByText('さくら')).toBeTruthy();
  });

  it('shows translation when enabled', () => {
    render(<LyricsLine active={false} line={line} past={false} onSeek={vi.fn()} />);

    expect(screen.getByText('樱花')).toBeTruthy();
  });

  it('hides translation when disabled', () => {
    render(<LyricsLine active={false} line={line} past={false} showTranslation={false} onSeek={vi.fn()} />);

    expect(screen.queryByText('樱花')).toBeNull();
  });

  it('marks how many secondary lyric rows are visible', () => {
    const { container, rerender } = render(<LyricsLine active line={line} past={false} onSeek={vi.fn()} />);

    expect(container.querySelector('.lyrics-line')?.getAttribute('data-secondary-lines')).toBe('2');

    rerender(<LyricsLine active line={line} past={false} showTranslation={false} onSeek={vi.fn()} />);

    expect(container.querySelector('.lyrics-line')?.getAttribute('data-secondary-lines')).toBe('1');
  });
});
