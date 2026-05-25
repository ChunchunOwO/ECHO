// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ArtistDetailView } from './ArtistDetailView';
import type { AppSettings } from '../../../shared/types/appSettings';
import type { ArtistInsights, LibraryAlbum, LibraryArtist, LibraryTrack } from '../../../shared/types/library';
import { I18nProvider } from '../../i18n/I18nProvider';

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

      return mockTracks.length === 0 && !mockIsLoading ? <p>No songs are grouped under this artist yet.</p> : <section>Mock tracks</section>;
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

const renderDetail = (artistValue: LibraryArtist, onBack = vi.fn()) => {
  window.localStorage.setItem('echo-next.locale', 'en-US');
  return render(
    <I18nProvider>
      <ArtistDetailView artist={artistValue} onBack={onBack} />
    </I18nProvider>,
  );
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

    renderDetail(artist());

    await screen.findByText('Echo Unit');
    expect((screen.getByRole('button', { name: /Reading Artist/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the empty track state from the artist track section', async () => {
    installLibrary();

    renderDetail(artist({ trackCount: 0 }));

    expect(await screen.findByText('No songs are grouped under this artist yet.')).toBeTruthy();
  });

  it('renders a panoramic artist image in the detail hero when one is cached', async () => {
    installLibrary(vi.fn().mockResolvedValue(artist({
      avatarThumbUrl: 'echo-artist-image://thumb/echo-unit',
      avatarUrl: 'echo-artist-image://large/echo-unit',
      avatarStatus: 'matched',
    })));

    renderDetail(artist());

    await screen.findByText('Echo Unit');
    const hero = document.querySelector('.artist-hero') as HTMLElement | null;
    const image = document.querySelector('.artist-hero-backdrop') as HTMLImageElement | null;
    expect(hero?.dataset.hasBackdrop).toBe('true');
    expect(image?.getAttribute('src')).toBe('echo-artist-image://large/echo-unit');
    expect(image?.getAttribute('sizes')).toBeNull();
    expect(image?.getAttribute('srcset')).toBeNull();
    expect(screen.queryByText('EC')).toBeNull();
  });

  it('uses the original album cover for the panoramic fallback instead of the compressed thumb', async () => {
    installLibrary(vi.fn().mockResolvedValue(artist({
      coverId: 'cover 1',
      coverThumb: 'echo-cover://album/cover%201',
    })));

    renderDetail(artist());

    await screen.findByText('Echo Unit');
    const image = document.querySelector('.artist-hero-backdrop') as HTMLImageElement | null;
    expect(image?.getAttribute('src')).toBe('echo-cover://original/cover%201');
  });

  it('falls back to the letter mark when the detail hero image fails', async () => {
    installLibrary(vi.fn().mockResolvedValue(artist({
      avatarUrl: 'echo-artist-image://large/echo-unit',
      avatarStatus: 'matched',
    })));

    renderDetail(artist());

    await screen.findByText('Echo Unit');
    const image = document.querySelector('.artist-hero-backdrop') as HTMLImageElement;
    fireEvent.error(image);

    expect(document.querySelector('.artist-hero-backdrop')).toBeNull();
    expect(screen.getByText('EC')).toBeTruthy();
  });

  it('updates the detail hero when the same artist receives an avatar', async () => {
    const getArtist = vi.fn().mockResolvedValue(artist());
    installLibrary(getArtist);
    const { rerender } = renderDetail(artist());

    await screen.findByText('Echo Unit');
    expect(screen.getByText('EC')).toBeTruthy();

    rerender(
      <I18nProvider>
        <ArtistDetailView artist={artist({ avatarUrl: 'echo-artist-image://large/echo-unit', avatarStatus: 'matched' })} onBack={vi.fn()} />
      </I18nProvider>,
    );

    await waitFor(() => expect(document.querySelector('.artist-hero-backdrop')?.getAttribute('src')).toBe('echo-artist-image://large/echo-unit'));
    expect(screen.queryByText('EC')).toBeNull();
  });

  it('plays the loaded artist queue from Play Artist', async () => {
    const first = track('1');
    const second = track('2');
    mockTracks = [first, second];
    mockTotal = 2;
    installLibrary();

    renderDetail(artist());

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

    renderDetail(artist(), onBack);

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

    window.localStorage.setItem('echo-next.locale', 'en-US');
    const { container } = render(
      <I18nProvider>
        <main className="page-surface">
          <ArtistDetailView artist={artist()} onBack={vi.fn()} />
        </main>
      </I18nProvider>,
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

    renderDetail(artist());

    await screen.findByText('Bandsintown');
    expect(screen.getByText('No upcoming concerts matched HK.')).toBeTruthy();
  });

  it('uses the localized concert setup copy when no concert provider is configured', async () => {
    installLibrary(
      vi.fn().mockResolvedValue(artist()),
      {},
      vi.fn().mockResolvedValue(artistInsights({
        concerts: {
          status: 'not_configured',
          region: null,
          sources: [],
          events: [],
          fetchedAt: null,
          message: 'Configure Bandsintown app_id in Settings to load upcoming concerts.',
        },
      })),
    );

    renderDetail(artist());

    expect(await screen.findByText(/Concert info needs Bandsintown/)).toBeTruthy();
    expect(screen.queryByText(/app_id/)).toBeNull();
  });

  it('does not show a Bandsintown setup message after Ticketmaster is configured', async () => {
    installLibrary(
      vi.fn().mockResolvedValue(artist()),
      { onlineArtistInfoTicketmasterApiKey: 'ticketmaster-key' },
      vi.fn().mockResolvedValue(artistInsights({
        concerts: {
          status: 'not_configured',
          region: null,
          sources: [],
          events: [],
          fetchedAt: null,
          message: 'Configure Bandsintown app_id in Settings to load upcoming concerts.',
        },
      })),
    );

    renderDetail(artist());

    expect(await screen.findByText('Ticketmaster')).toBeTruthy();
    expect(screen.getByText('No upcoming concerts matched.')).toBeTruthy();
    expect(screen.queryByText(/Bandsintown app_id/)).toBeNull();
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
              imageUrl: 'https://img.example/event.jpg',
            },
          ],
        },
      }));
    installLibrary(vi.fn().mockResolvedValue(artist()), { onlineArtistInfoBandsintownAppId: 'echo-next', onlineArtistInfoRegion: 'HK' }, getArtistInsights);

    renderDetail(artist());

    expect(await screen.findByText(/fictional test artist/)).toBeTruthy();
    expect(screen.getByText('en.wikipedia.org')).toBeTruthy();
    expect(screen.getByText('MusicBrainz')).toBeTruthy();
    expect(screen.getByText('1 concerts found. Expand to view dates, venues, and ticket links.')).toBeTruthy();
    expect(screen.queryByText('Echo Unit Live')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Expand/ }));
    expect(screen.getByText('Echo Unit Live')).toBeTruthy();
    expect(document.querySelector('.artist-event-cover img')?.getAttribute('src')).toBe('https://img.example/event.jpg');
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
