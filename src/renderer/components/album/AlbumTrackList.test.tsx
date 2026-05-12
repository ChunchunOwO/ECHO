// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AlbumTrackList } from './AlbumTrackList';
import type { LibraryPage, LibraryTrack } from '../../../shared/types/library';

const track = (id: string, overrides: Partial<LibraryTrack> = {}): LibraryTrack => ({
  id,
  path: `D:\\Music\\${id}.flac`,
  title: `Track ${id}`,
  artist: 'Artist',
  album: 'Album',
  albumArtist: 'Artist',
  trackNo: Number(id.replace(/\D/g, '')) || 1,
  discNo: 1,
  year: 2026,
  genre: null,
  duration: 180,
  codec: 'flac',
  sampleRate: 96000,
  bitDepth: 24,
  bitrate: 900000,
  coverId: null,
  coverThumb: null,
  embeddedMetadataStatus: 'present',
  embeddedCoverStatus: 'missing',
  networkMetadataStatus: 'none',
  fieldSources: {},
  ...overrides,
});

const page = (items: LibraryTrack[], overrides: Partial<LibraryPage<LibraryTrack>> = {}): LibraryPage<LibraryTrack> => ({
  items,
  page: 1,
  pageSize: 100,
  total: items.length,
  hasMore: false,
  ...overrides,
});

const installLibrary = (getAlbumTracks: ReturnType<typeof vi.fn>): void => {
  window.echo = {
    library: {
      getAlbumTracks,
    },
  } as unknown as Window['echo'];
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AlbumTrackList', () => {
  it('initially requests only page 1 and loads more on demand', async () => {
    const getAlbumTracks = vi
      .fn()
      .mockResolvedValueOnce(page([track('1')], { page: 1, total: 2, hasMore: true }))
      .mockResolvedValueOnce(page([track('2')], { page: 2, total: 2, hasMore: false }));
    installLibrary(getAlbumTracks);

    render(<AlbumTrackList albumId="album-1" currentTrackId={null} onPlayTrack={vi.fn()} />);

    await waitFor(() => expect(getAlbumTracks).toHaveBeenCalledTimes(1));
    expect(getAlbumTracks).toHaveBeenNthCalledWith(1, 'album-1', { page: 1, pageSize: 100 });

    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));

    await waitFor(() => expect(getAlbumTracks).toHaveBeenCalledTimes(2));
    expect(getAlbumTracks).toHaveBeenNthCalledWith(2, 'album-1', { page: 2, pageSize: 100 });
  });

  it('reports loaded tracks, total count, and loading state to the detail console', async () => {
    const first = track('1', { genre: 'Future Bass' });
    const second = track('2', { discNo: 2, genre: 'Future Bass' });
    const getAlbumTracks = vi
      .fn()
      .mockResolvedValueOnce(page([first], { page: 1, total: 2, hasMore: true }))
      .mockResolvedValueOnce(page([second], { page: 2, total: 2, hasMore: false }));
    const onLoadedTracksChange = vi.fn();
    const onFirstTrackChange = vi.fn();
    installLibrary(getAlbumTracks);

    render(
      <AlbumTrackList
        albumId="album-1"
        currentTrackId={null}
        onFirstTrackChange={onFirstTrackChange}
        onLoadedTracksChange={onLoadedTracksChange}
        onPlayTrack={vi.fn()}
      />,
    );

    await waitFor(() => expect(onLoadedTracksChange).toHaveBeenLastCalledWith([first], 2, false));
    expect(onFirstTrackChange).toHaveBeenLastCalledWith(first, false);

    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));

    await waitFor(() => expect(onLoadedTracksChange).toHaveBeenLastCalledWith([first, second], 2, false));
  });

  it('plays a track once from row click', async () => {
    const getAlbumTracks = vi.fn().mockResolvedValue(page([track('1')]));
    const onPlayTrack = vi.fn();
    installLibrary(getAlbumTracks);

    render(<AlbumTrackList albumId="album-1" currentTrackId={null} onPlayTrack={onPlayTrack} />);

    await screen.findByText('Track 1');
    fireEvent.click(screen.getByRole('listitem'));

    expect(onPlayTrack).toHaveBeenCalledTimes(1);
    expect(onPlayTrack).toHaveBeenCalledWith(expect.objectContaining({ id: '1' }));
  });

  it('renders the compact album summary and empty state', async () => {
    const getAlbumTracks = vi.fn().mockResolvedValue(page([]));
    installLibrary(getAlbumTracks);

    render(
      <AlbumTrackList
        albumId="album-1"
        currentTrackId={null}
        summary={{ duration: '42 min', signal: 'DSF / 1bit / 5645kHz', totalLabel: '2 tracks' }}
        onPlayTrack={vi.fn()}
      />,
    );

    const summary = await screen.findByLabelText('Track summary');
    expect(summary.textContent).toContain('2 tracks');
    expect(summary.textContent).toContain('42 min');
    expect(summary.textContent).toContain('DSF / 1bit / 5645kHz');
    expect(await screen.findByText('No tracks found for this album.')).toBeTruthy();
  });
});
