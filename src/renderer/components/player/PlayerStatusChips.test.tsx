// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PlayerStatusChips } from './PlayerStatusChips';
import type { LibraryTrack } from '../../../shared/types/library';

const track = (overrides: Partial<LibraryTrack> = {}): LibraryTrack => ({
  id: 'track-1',
  path: 'D:\\Music\\song.flac',
  title: 'Song',
  artist: 'Artist',
  album: 'Album',
  albumArtist: 'Artist',
  trackNo: 1,
  discNo: 1,
  year: 2026,
  genre: null,
  duration: 180,
  codec: 'flac',
  sampleRate: 48000,
  bitDepth: 24,
  bitrate: 1884000,
  bpm: null,
  bpmConfidence: null,
  beatOffsetMs: null,
  analysisStatus: 'none',
  coverId: null,
  coverThumb: null,
  embeddedMetadataStatus: 'present',
  embeddedCoverStatus: 'missing',
  networkMetadataStatus: 'none',
  fieldSources: {},
  ...overrides,
});

afterEach(() => {
  cleanup();
});

describe('PlayerStatusChips', () => {
  it('shows detected BPM in the player tags even when confidence is low', () => {
    const { rerender } = render(
      <PlayerStatusChips
        status={null}
        state="playing"
        track={track({ bpm: 128, bpmConfidence: 0.2, analysisStatus: 'low_confidence' })}
      />,
    );

    expect(screen.getByText('128 BPM')).toBeTruthy();

    rerender(<PlayerStatusChips status={null} state="playing" track={track({ bpm: 128, analysisStatus: 'analyzing' })} />);

    expect(screen.queryByText('128 BPM')).toBeNull();
  });

  it('labels AirPlay receiver temporary tracks', () => {
    render(
      <PlayerStatusChips
        status={null}
        state="playing"
        track={track({
          id: 'airplay-receiver:session-1',
          mediaType: 'remote',
          isTemporary: true,
          codec: null,
          fieldSources: { title: 'airplay' },
        })}
      />,
    );

    expect(screen.getByText('AIRPLAY')).toBeTruthy();
  });
});
