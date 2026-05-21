// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ArtistDetailView } from './ArtistDetailView';
import type { AppSettings } from '../../../shared/types/appSettings';
import type { ArtistInsights, LibraryAlbum, LibraryArtist, LibraryTrack } from '../../../shared/types/library';

const queueMock = {
  appendToQueue: vi.fn(),
  currentTrackId: null as string | null,
  playTrack: vi.fn().mockResolvedValue({}),
  playTrackNext: vi.fn(),
  replaceQueue: vi.fn(),
};

let mockTracks: LibraryTrack[] = [];
let mockTotal = 0;
let mockIsLoading = false;

vi.mock('../../stores/PlaybackQueueProvider', () => ({
  usePlaybackQueue: () => queueMock,
}));

vi.mock('../album/AlbumDetailView', () => ({
  AlbumDetailView: ({ album, onBack }: { album: LibraryAlbum; onBack: () => void }) => (
    <section>
      <h1>Album detail: {album.title}</h1>
      <button type="button" onClick={onBack}>
        Back to artist
      </button>
    </section>
  ),
}));

vi.mock('./ArtistAlbumGrid', () => ({
  ArtistAlbumGrid: ({ onAlbumSelect }: { onAlbumSelect: (album: LibraryAlbum) => void }) => (
    <section aria-label="mock albums">
      <button
        type="button"
        onClick={() =>
          onAlbumSelect({
            id: 'album-1',
            albumKey: 'echo/unit',
            title: 'Mock Album',
            albumArtist: 'Echo Unit',
            year: 2026,
            trackCount: 2,
            duration: 360,
            coverId: null,
            coverThumb: null,
          })
        }
      >
        Open mock album
      </button>
    </section>
  ),
}));

vi.mock('./ArtistTrackList', async () => {
  const React = await import('react');

  return {
    ArtistTrackList: ({ onLoadedTracksChange }: { onLoadedTracksChange?: (tracks: LibraryTrack[], total: number, isLoading: boolean) => void }) => {
      React.useEffect(() => {
        onLoadedTracksChange?.(mockTracks, mockTotal, mockIsLoading);
      }, [onLoadedTracksChange]);

      return mockTracks.length === 0 && !mockIsLoading ? <p>这个艺术家还没有可显示的歌曲。</p> : <section>Mock tracks</section>;
    },
  };
});

const artist = (overrides: Partial<LibraryArtist> = {}): LibraryArtist => ({
  id: 'artist-1',
  name: 'Echo Unit',
  sortName: 'echo unit',
  role: 'both',
  trackCount: 3,
  albumCount: 2,
  coverId: null,
  coverThumb: null,
  ...overrides,
});

const track = (id: string): LibraryTrack => ({
  id,
  path: `D:\\Music\\${id}.flac`,
  title: `Track ${id}`,
  artist: 'Echo Unit',
  album: 'Album',
  albumArtist: 'Echo Unit',
  trackNo: 1,
  discNo: 1,
  year: 2026,
  genre: null,
  duration: 180,
  codec: 'flac',
  sampleRate: 96000,
  bitDepth: 24,
  bitrate: 1000,
  coverId: null,
  coverThumb: null,
  embeddedMetadataStatus: 'present',
  embeddedCoverStatus: 'missing',
  networkMetadataStatus: 'none',
  fieldSources: {},
});

const artistInsights = (overrides: Partial<ArtistInsights> = {}): ArtistInsights => ({
  artist: artist(),
  nodes: [{ ...artist(), source: 'local' }],
  edges: [],
  onlineInfo: {
    status: 'empty',
    bio: null,
    imageCredits: [],
    externalLinks: [],
    relatedArtists: [],
    sourceLabels: [],
    fetchedAt: null,
  },
  concerts: { status: 'not_configured', region: null, sources: [], events: [], fetchedAt: null },
  generatedAt: '2026-05-20T00:00:00.000Z',
  ...overrides,
});

const installLibrary = (
  getArtist = vi.fn().mockResolvedValue(artist()),
  appSettings?: Partial<AppSettings>,
  getArtistInsights = vi.fn().mockResolvedValue(artistInsights()),
): void => {
  window.echo = {
    app: appSettings
      ? {
          getSettings: vi.fn().mockResolvedValue(appSettings),
        }
      : undefined,
    library: {
      getArtist,
      getArtistInsights,
    },
  } as unknown as Window['echo'];
};

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.restoreAllMocks();
  queueMock.appendToQueue.mockReset();
  queueMock.playTrack.mockReset();
  queueMock.playTrack.mockResolvedValue({});
  queueMock.playTrackNext.mockReset();
  queueMock.replaceQueue.mockReset();
  mockTracks = [];
  mockTotal = 0;
  mockIsLoading = false;
});

describe('ArtistDetailView', () => {
  it('shows the loading state while artist tracks are being read', async () => {
    mockIsLoading = true;
    installLibrary();

    render(<ArtistDetailView artist={artist()} onBack={vi.fn()} />);

    await screen.findByText('Echo Unit');
    expect((screen.getByRole('button', { name: /Reading Artist/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the empty track state from the artist track section', async () => {
    installLibrary();

    render(<ArtistDetailView artist={artist({ trackCount: 0 })} onBack={vi.fn()} />);

    expect(await screen.findByText('这个艺术家还没有可显示的歌曲。')).toBeTruthy();
  });

  it('renders a round artist avatar in the detail hero when one is cached', async () => {
    installLibrary(vi.fn().mockResolvedValue(artist({
      avatarThumbUrl: 'echo-artist-image://thumb/echo-unit',
      avatarUrl: 'echo-artist-image://large/echo-unit',
      avatarStatus: 'matched',
    })));

    render(<ArtistDetailView artist={artist()} onBack={vi.fn()} />);

    await screen.findByText('Echo Unit');
    const hero = document.querySelector('.artist-hero-avatar') as HTMLElement | null;
    const image = hero?.querySelector('img') as HTMLImageElement | null;
    expect(hero?.dataset.cover).toBe('true');
    expect(image?.getAttribute('src')).toBe('echo-artist-image://large/echo-unit');
    expect(image?.getAttribute('sizes')).toBe('240px');
    expect(image?.getAttribute('srcset')).toBe('echo-artist-image://thumb/echo-unit 192w, echo-artist-image://large/echo-unit 1024w');
    expect(screen.queryByText('EC')).toBeNull();
  });

  it('falls back to the round letter mark when the detail hero image fails', async () => {
    installLibrary(vi.fn().mockResolvedValue(artist({
      avatarUrl: 'echo-artist-image://large/echo-unit',
      avatarStatus: 'matched',
    })));

    render(<ArtistDetailView artist={artist()} onBack={vi.fn()} />);

    await screen.findByText('Echo Unit');
    const image = document.querySelector('.artist-hero-avatar img') as HTMLImageElement;
    fireEvent.error(image);

    expect(document.querySelector('.artist-hero-avatar img')).toBeNull();
    expect(screen.getByText('EC')).toBeTruthy();
  });

  it('updates the detail hero when the same artist receives an avatar', async () => {
    const getArtist = vi.fn().mockResolvedValue(artist());
    installLibrary(getArtist);
    const { rerender } = render(<ArtistDetailView artist={artist()} onBack={vi.fn()} />);

    await screen.findByText('Echo Unit');
    expect(screen.getByText('EC')).toBeTruthy();

    rerender(<ArtistDetailView artist={artist({ avatarUrl: 'echo-artist-image://large/echo-unit', avatarStatus: 'matched' })} onBack={vi.fn()} />);

    await waitFor(() => expect(document.querySelector('.artist-hero-avatar img')?.getAttribute('src')).toBe('echo-artist-image://large/echo-unit'));
    expect(screen.queryByText('EC')).toBeNull();
  });

  it('plays the loaded artist queue from Play Artist', async () => {
    const first = track('1');
    const second = track('2');
    mockTracks = [first, second];
    mockTotal = 2;
    installLibrary();

    render(<ArtistDetailView artist={artist()} onBack={vi.fn()} />);

    await waitFor(() => expect((screen.getByRole('button', { name: /Play Artist/i }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /Play Artist/i }));

    await waitFor(() => expect(queueMock.replaceQueue).toHaveBeenCalledTimes(1));
    expect(queueMock.replaceQueue).toHaveBeenCalledWith(mockTracks, {
      startTrackId: first.id,
      source: { type: 'artist', label: 'Echo Unit', artistId: 'artist-1' },
    });
    expect(queueMock.playTrack).toHaveBeenCalledWith(first, {
      source: { type: 'artist', label: 'Echo Unit', artistId: 'artist-1' },
    });
  });

  it('returns from the artist detail after Escape plays the back animation', async () => {
    installLibrary();
    const onBack = vi.fn();

    render(<ArtistDetailView artist={artist()} onBack={onBack} />);

    await screen.findByText('Echo Unit');
    vi.useFakeTimers();
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onBack).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(180);
    });

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('restores the page surface scroll position after returning from an artist album', async () => {
    installLibrary();

    const { container } = render(
      <main className="page-surface">
        <ArtistDetailView artist={artist()} onBack={vi.fn()} />
      </main>,
    );
    const pageSurface = container.querySelector('.page-surface') as HTMLElement;
    pageSurface.scrollTop = 480;

    fireEvent.click(await screen.findByRole('button', { name: 'Open mock album' }));
    expect(screen.getByText('Album detail: Mock Album')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Back to artist' }));

    expect(pageSurface.scrollTop).toBe(480);
    expect(screen.getByRole('button', { name: 'Open mock album' })).toBeTruthy();
  });

  it('shows configured concert provider status while online events are empty', async () => {
    installLibrary(vi.fn().mockResolvedValue(artist()), {
      onlineArtistInfoBandsintownAppId: 'echo-next',
      onlineArtistInfoRegion: 'HK',
    });

    render(<ArtistDetailView artist={artist()} onBack={vi.fn()} />);

    await screen.findByText('Bandsintown');
    expect(screen.getByText('No upcoming concerts matched HK.')).toBeTruthy();
  });

  it('renders online artist bio links and concert cards after the background insights load', async () => {
    const getArtistInsights = vi.fn()
      .mockResolvedValueOnce(artistInsights())
      .mockResolvedValue(artistInsights({
        onlineInfo: {
          status: 'ready',
          bio: {
            title: 'Echo Unit',
            description: 'Japanese band',
            extract: 'Echo Unit is a fictional test artist with a very polished artist profile.',
            url: 'https://example.wikipedia/Echo_Unit',
            language: 'en',
            thumbnailUrl: 'https://img.example/echo.jpg',
          },
          imageCredits: ['Echo Unit image via en.wikipedia.org'],
          externalLinks: [{ label: 'Echo Unit', url: 'https://example.wikipedia/Echo_Unit', source: 'wikipedia' }],
          relatedArtists: [],
          sourceLabels: ['en.wikipedia.org', 'MusicBrainz'],
          fetchedAt: '2026-05-20T00:00:00.000Z',
        },
        concerts: {
          status: 'ready',
          region: 'HK',
          sources: ['bandsintown'],
          fetchedAt: '2026-05-20T00:00:00.000Z',
          events: [
            {
              id: 'bandsintown:evt-1',
              source: 'bandsintown',
              sourceLabel: 'Bandsintown',
              title: 'Echo Unit Live',
              startsAt: '2026-06-01T20:00:00',
              venueName: 'Echo Arena',
              city: 'Hong Kong',
              region: 'HK',
              country: 'Hong Kong',
              url: 'https://bandsintown.example/events/evt-1',
              ticketUrl: null,
              venueUrl: null,
            },
          ],
        },
      }));
    installLibrary(vi.fn().mockResolvedValue(artist()), { onlineArtistInfoBandsintownAppId: 'echo-next', onlineArtistInfoRegion: 'HK' }, getArtistInsights);

    render(<ArtistDetailView artist={artist()} onBack={vi.fn()} />);

    expect(await screen.findByText(/fictional test artist/)).toBeTruthy();
    expect(screen.getByText('en.wikipedia.org')).toBeTruthy();
    expect(screen.getByText('MusicBrainz')).toBeTruthy();
    expect(screen.getByText('Echo Unit Live')).toBeTruthy();
    await waitFor(() =>
      expect(getArtistInsights).toHaveBeenCalledWith('artist-1', {
        limit: 12,
        includeOnline: true,
        forceOnline: false,
        region: 'HK',
      }),
    );
  });
});
