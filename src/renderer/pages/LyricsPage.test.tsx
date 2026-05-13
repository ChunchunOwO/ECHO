// @vitest-environment jsdom
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AudioStatus } from '../../shared/types/audio';
import type { LibraryTrack } from '../../shared/types/library';
import { PlaybackQueueProvider, usePlaybackQueue } from '../stores/PlaybackQueueProvider';
import { LyricsPage } from './LyricsPage';
import type { LyricLine } from '../components/lyrics/lyricsTypes';

const makeTrack = (overrides: Partial<LibraryTrack> = {}): LibraryTrack => ({
  id: 'track-1',
  path: 'D:\\Music\\song.flac',
  title: 'Test Song',
  artist: 'Test Artist',
  album: 'Test Album',
  albumArtist: 'Test Album Artist',
  trackNo: 1,
  discNo: 1,
  year: 2026,
  genre: null,
  duration: 180,
  codec: 'flac',
  sampleRate: 96000,
  bitDepth: 24,
  bitrate: 2400000,
  coverId: null,
  coverThumb: 'echo-cover://thumb/test',
  embeddedMetadataStatus: 'present',
  embeddedCoverStatus: 'present',
  networkMetadataStatus: 'none',
  fieldSources: {},
  ...overrides,
});

const makeAudioStatus = (track: LibraryTrack | null, positionSeconds = 0): AudioStatus => ({
  host: 'ready',
  state: track ? 'playing' : 'idle',
  outputDeviceId: null,
  outputDeviceName: null,
  outputDeviceType: null,
  outputBackend: 'wasapi-shared',
  outputMode: 'shared',
  volume: 1,
  playbackRate: 1,
  playbackSpeedMode: 'nightcore',
  currentFilePath: track?.path ?? null,
  currentTrackId: track?.id ?? null,
  durationSeconds: track?.duration ?? 0,
  positionSeconds,
  channels: 2,
  codec: track?.codec ?? null,
  bitDepth: track?.bitDepth ?? null,
  bitrate: track?.bitrate ?? null,
  fileSampleRate: track?.sampleRate ?? null,
  decoderOutputSampleRate: track?.sampleRate ?? null,
  requestedOutputSampleRate: track?.sampleRate ?? null,
  actualDeviceSampleRate: track?.sampleRate ?? null,
  sharedDeviceSampleRate: track?.sampleRate ?? null,
  resampling: false,
  bitPerfectCandidate: false,
  sampleRateMismatch: false,
  eqEnabled: false,
  channelBalanceEnabled: false,
  dspActive: false,
  preampDb: 0,
  eqPresetName: 'Flat',
  clippingRisk: false,
  bitPerfectDisabledReason: null,
  warnings: [],
  error: null,
});

const lyrics: LyricLine[] = [
  { timeMs: 0, text: 'First line' },
  { timeMs: 10000, text: 'Second line' },
  { timeMs: 20000, text: 'Third line' },
];

const QueueSeed = ({ children, track }: { children: JSX.Element; track: LibraryTrack }): JSX.Element => {
  const { replaceQueue, setCurrentTrackId } = usePlaybackQueue();

  useEffect(() => {
    replaceQueue([track]);
    setCurrentTrackId(track.id);
  }, [replaceQueue, setCurrentTrackId, track]);

  return children;
};

const mockEcho = (track: LibraryTrack | null, positionSeconds = 0): { seek: ReturnType<typeof vi.fn> } => {
  const seek = vi.fn().mockResolvedValue({
    state: 'playing',
    currentTrackId: track?.id ?? null,
    positionMs: positionSeconds * 1000,
    durationMs: (track?.duration ?? 0) * 1000,
    filePath: track?.path ?? null,
  });

  window.echo = {
    playback: {
      getStatus: vi.fn().mockResolvedValue({
        state: track ? 'playing' : 'idle',
        currentTrackId: track?.id ?? null,
        positionMs: positionSeconds * 1000,
        durationMs: (track?.duration ?? 0) * 1000,
        filePath: track?.path ?? null,
      }),
      playLocalFile: vi.fn(),
      play: vi.fn(),
      pause: vi.fn(),
      stop: vi.fn(),
      seek,
      openLocalAudioFile: vi.fn(),
    },
    audio: {
      getStatus: vi.fn().mockResolvedValue(makeAudioStatus(track, positionSeconds)),
      listDevices: vi.fn(),
      setOutput: vi.fn().mockResolvedValue(makeAudioStatus(track, positionSeconds)),
    },
  } as unknown as Window['echo'];

  return { seek };
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('LyricsPage', () => {
  it('shows current song information when a track is playing', async () => {
    const track = makeTrack();
    mockEcho(track);

    render(
      <PlaybackQueueProvider>
        <QueueSeed track={track}>
          <LyricsPage initialLyrics={lyrics} />
        </QueueSeed>
      </PlaybackQueueProvider>,
    );

    expect(await screen.findByRole('heading', { name: 'Test Song' })).toBeTruthy();
    expect(screen.getAllByText('Test Artist').length).toBeGreaterThan(0);
    expect(screen.queryByText(/FLAC \/ 2400 kbps \/ 96 kHz/)).toBeNull();
  });

  it('shows an empty state when no song is playing', async () => {
    mockEcho(null);

    render(
      <PlaybackQueueProvider>
        <LyricsPage />
      </PlaybackQueueProvider>,
    );

    expect(await screen.findByText('Nothing is playing')).toBeTruthy();
  });

  it('highlights the current lyric line from playback position', async () => {
    const track = makeTrack();
    mockEcho(track, 12);
    const { container } = render(
      <PlaybackQueueProvider>
        <QueueSeed track={track}>
          <LyricsPage initialLyrics={lyrics} />
        </QueueSeed>
      </PlaybackQueueProvider>,
    );

    await screen.findByText('Second line');
    expect(container.querySelector('.lyrics-line[data-active="true"]')?.textContent).toContain('Second line');
  });

  it('seeks when a synced lyric line is clicked', async () => {
    const track = makeTrack();
    const { seek } = mockEcho(track, 0);
    render(
      <PlaybackQueueProvider>
        <QueueSeed track={track}>
          <LyricsPage initialLyrics={lyrics} />
        </QueueSeed>
      </PlaybackQueueProvider>,
    );

    fireEvent.click(await screen.findByText('Second line'));

    await waitFor(() => expect(seek).toHaveBeenCalledWith(10));
  });

  it('uses album artwork as the MV fallback and shows a default visual without cover art', async () => {
    const track = makeTrack();
    mockEcho(track);
    const { container, rerender } = render(
      <PlaybackQueueProvider>
        <QueueSeed track={track}>
          <LyricsPage initialLyrics={lyrics} />
        </QueueSeed>
      </PlaybackQueueProvider>,
    );

    await screen.findByRole('heading', { name: 'Test Song' });
    expect(container.querySelector('.lyrics-track-cover img')?.getAttribute('src')).toBe('echo-cover://thumb/test');
    expect(container.querySelector('.lyrics-mv-card[data-cover="true"] img')?.getAttribute('src')).toBe('echo-cover://thumb/test');

    const noCoverTrack = makeTrack({ coverThumb: null });
    mockEcho(noCoverTrack);
    rerender(
      <PlaybackQueueProvider>
        <QueueSeed track={noCoverTrack}>
          <LyricsPage initialLyrics={lyrics} />
        </QueueSeed>
      </PlaybackQueueProvider>,
    );

    await screen.findByRole('heading', { name: 'Test Song' });
    expect(container.querySelector('.lyrics-mv-placeholder')).toBeTruthy();
  });

  it('uses the original cover only for the lyrics header when a cover id is available', async () => {
    const track = makeTrack({ coverId: 'cover 1' });
    mockEcho(track);
    const { container } = render(
      <PlaybackQueueProvider>
        <QueueSeed track={track}>
          <LyricsPage initialLyrics={lyrics} />
        </QueueSeed>
      </PlaybackQueueProvider>,
    );

    await screen.findByRole('heading', { name: 'Test Song' });
    expect(container.querySelector('.lyrics-track-cover img')?.getAttribute('src')).toBe('echo-cover://original/cover%201');
    expect(container.querySelector('.lyrics-mv-card[data-cover="true"] img')?.getAttribute('src')).toBe('echo-cover://large/cover%201');
  });
});
