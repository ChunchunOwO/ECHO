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

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    await waitFor(() => expect(getAlbumTracks).toHaveBeenCalledTimes(2));
    expect(getAlbumTracks).toHaveBeenNthCalledWith(2, 'album-1', { page: 2, pageSize: 100 });
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
});
