// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AlbumOnlineInfo, LibraryAlbum, LibraryArtist, LibraryTrack } from '../../../shared/types/library';
import { AlbumDetailView } from './AlbumDetailView';

const queueMock = {
  currentTrackId: null as string | null,
  playTrack: vi.fn().mockResolvedValue({}),
  replaceQueue: vi.fn(),
};

vi.mock('../../stores/PlaybackQueueProvider', () => ({
  usePlaybackQueue: () => queueMock,
}));

vi.mock('./AlbumTrackList', async () => {
  const React = await import('react');

  return {
    AlbumTrackList: ({ onFirstTrackChange, onLoadedTracksChange }: {
      onFirstTrackChange?: (track: LibraryTrack | null, isLoading: boolean) => void;
      onLoadedTracksChange?: (tracks: LibraryTrack[], total: number, isLoading: boolean) => void;
    }) => {
      React.useEffect(() => {
        const loadedTrack = track();
        onFirstTrackChange?.(loadedTrack, false);
        onLoadedTracksChange?.([loadedTrack], 1, false);
      }, [onFirstTrackChange, onLoadedTracksChange]);

      return <section>Mock album tracks</section>;
    },
  };
});

const album = (): LibraryAlbum => ({
  id: 'album-1',
  albumKey: 'echo/unit',
  title: 'Mock Album',
  albumArtist: 'Echo Unit',
  year: 2026,
  trackCount: 1,
  duration: 180,
  coverId: null,
  coverThumb: null,
});

const track = (): LibraryTrack => ({
  id: 'track-1',
  path: 'D:\\Music\\track-1.flac',
  title: 'Mock Track',
  artist: 'Echo Unit',
  album: 'Mock Album',
  albumArtist: 'Echo Unit',
  trackNo: 1,
  discNo: 1,
  year: 2026,
  genre: null,
  duration: 180,
  codec: 'flac',
  sampleRate: 44100,
  bitDepth: 16,
  bitrate: 1000000,
  coverId: null,
  coverThumb: null,
  embeddedMetadataStatus: 'present',
  embeddedCoverStatus: 'missing',
  networkMetadataStatus: 'none',
  fieldSources: {},
});

const artist = (): LibraryArtist => ({
  id: 'artist-1',
  name: 'Echo Unit',
  sortName: 'Echo Unit',
  role: 'both',
  trackCount: 1,
  albumCount: 1,
  coverId: null,
  coverThumb: null,
  avatarUrl: null,
  avatarThumbUrl: null,
  avatarStatus: null,
});

const onlineInfo = (): AlbumOnlineInfo => ({
  albumId: 'album-1',
  status: 'ready',
  sources: [{ provider: 'wikipedia', label: 'en.wikipedia.org' }],
  match: null,
  credits: [
    {
      role: 'Composer',
      people: [{ name: 'Mock Composer', detail: 'music', trackTitle: null, source: 'work' }],
    },
  ],
  information: {
    title: 'Mock Album',
    description: 'Album',
    extract: 'Mock album overview.',
    url: 'https://example.test/album',
    language: 'en',
    thumbnailUrl: null,
  },
  artistInformation: {
    title: 'Echo Unit',
    description: 'Artist',
    extract: 'Echo Unit artist overview.',
    url: 'https://example.test/artist',
    language: 'en',
    thumbnailUrl: null,
  },
  fetchedAt: '2026-05-21T00:00:00.000Z',
  expiresAt: '2026-06-21T00:00:00.000Z',
  fromCache: false,
  errors: [],
});

const installLibrary = (): { getAlbumOnlineInfo: ReturnType<typeof vi.fn>; getArtists: ReturnType<typeof vi.fn> } => {
  const getAlbumOnlineInfo = vi.fn().mockResolvedValue(onlineInfo());
  const getArtists = vi.fn().mockResolvedValue({
    items: [artist()],
    page: 1,
    pageSize: 50,
    total: 1,
    hasMore: false,
  });
  window.echo = {
    library: {
      getAlbum: vi.fn().mockResolvedValue({ coverLarge: null }),
      getAlbumOnlineInfo,
      getArtists,
      getLikedAlbumIds: vi.fn().mockResolvedValue({}),
    },
  } as unknown as Window['echo'];
  return { getAlbumOnlineInfo, getArtists };
};

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.restoreAllMocks();
  queueMock.playTrack.mockReset();
  queueMock.playTrack.mockResolvedValue({});
  queueMock.replaceQueue.mockReset();
});

describe('AlbumDetailView', () => {
  it('returns from the album detail after Escape plays the back animation', async () => {
    vi.useFakeTimers();
    installLibrary();
    const onBack = vi.fn();

    render(<AlbumDetailView album={album()} onBack={onBack} />);

    expect(screen.getByText('Mock Album')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onBack).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(180);
    });

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('starts reading online album info when the detail opens and shows artist information', async () => {
    const { getAlbumOnlineInfo } = installLibrary();

    render(<AlbumDetailView album={album()} onBack={vi.fn()} />);

    await waitFor(() => expect(getAlbumOnlineInfo).toHaveBeenCalledWith('album-1', { force: false }));

    fireEvent.click(screen.getByRole('button', { name: 'Information' }));

    expect(await screen.findByText('Artist profile - en.wikipedia.org')).toBeTruthy();
    expect(screen.getByText('Echo Unit artist overview.')).toBeTruthy();
  });

  it('opens the album artist detail from the hero artist name', async () => {
    const { getArtists } = installLibrary();
    const navigate = vi.fn();
    window.addEventListener('app:navigate:artist-detail', navigate);

    render(<AlbumDetailView album={album()} onBack={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open artist Echo Unit' }));

    await waitFor(() => expect(getArtists).toHaveBeenCalledWith({ page: 1, pageSize: 50, search: 'Echo Unit', sort: 'default' }));
    expect(navigate).toHaveBeenCalledTimes(1);
    expect((navigate.mock.calls[0]?.[0] as CustomEvent).detail.artist.id).toBe('artist-1');

    window.removeEventListener('app:navigate:artist-detail', navigate);
  });
});
