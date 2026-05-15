// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { LibraryPage, LibraryPlaylist, LibraryPlaylistItem, LibraryTrack } from '../../shared/types/library';
import { PlaybackQueueProvider } from '../stores/PlaybackQueueProvider';
import { PlaylistsPage } from './PlaylistsPage';

vi.mock('../components/library/TrackList', () => ({
  TrackList: ({
    tracks,
    onOpenTrackMenu,
    onPlay,
  }: {
    tracks: LibraryTrack[];
    onOpenTrackMenu?: (track: LibraryTrack, position: { x: number; y: number }) => void;
    onPlay?: (track: LibraryTrack) => void;
  }) => (
    <div data-testid="playlist-track-list">
      {tracks.map((track) => (
        <div key={track.playlistItemId ?? track.id}>
          <button type="button" onClick={() => onPlay?.(track)}>
            {track.title}
          </button>
          <button type="button" onClick={() => onOpenTrackMenu?.(track, { x: 12, y: 34 })}>
            Open menu for {track.title}
          </button>
        </div>
      ))}
    </div>
  ),
}));

vi.mock('../components/library/TrackContextMenu', () => ({
  TrackContextMenu: ({
    onAction,
    track,
  }: {
    onAction: (action: 'show-in-folder' | 'copy-path' | 'open-system', track: LibraryTrack) => void;
    track: LibraryTrack;
  }) => (
    <div role="menu">
      <button type="button" onClick={() => onAction('show-in-folder', track)}>
        Show in folder
      </button>
      <button type="button" onClick={() => onAction('copy-path', track)}>
        Copy path
      </button>
      <button type="button" onClick={() => onAction('open-system', track)}>
        Open with system
      </button>
    </div>
  ),
}));

const playlist = (overrides: Partial<LibraryPlaylist> = {}): LibraryPlaylist => ({
  id: 'playlist-1',
  name: 'Road Mix',
  description: 'Manual local playlist',
  kind: 'manual',
  sourceProvider: 'local',
  sourcePlaylistId: null,
  coverId: null,
  coverThumb: null,
  sortMode: 'manual',
  itemCount: 1,
  createdAt: '2026-05-14T00:00:00.000Z',
  updatedAt: '2026-05-14T00:00:00.000Z',
  ...overrides,
});

const track = (overrides: Partial<LibraryTrack> = {}): LibraryTrack => ({
  id: 'track-1',
  path: 'D:\\Music\\Song.flac',
  title: 'Song One',
  artist: 'Artist',
  album: 'Album',
  albumArtist: 'Artist',
  trackNo: null,
  discNo: null,
  year: null,
  genre: null,
  duration: 180,
  codec: 'FLAC',
  sampleRate: 44100,
  bitDepth: 16,
  bitrate: 900000,
  coverId: null,
  coverThumb: null,
  fieldSources: {},
  ...overrides,
});

const item = (overrides: Partial<LibraryPlaylistItem> = {}): LibraryPlaylistItem => ({
  id: 'item-1',
  playlistId: 'playlist-1',
  mediaType: 'track',
  mediaId: 'track-1',
  sourceProvider: 'local',
  sourceItemId: null,
  titleSnapshot: 'Song One',
  artistSnapshot: 'Artist',
  albumSnapshot: 'Album',
  durationSnapshot: 180,
  coverId: null,
  coverThumb: null,
  position: 0,
  addedAt: '2026-05-14T00:00:00.000Z',
  addedFrom: 'manual',
  unavailable: false,
  track: track(),
  ...overrides,
});

const page = (items: LibraryPlaylistItem[]): LibraryPage<LibraryPlaylistItem> => ({
  items,
  page: 1,
  pageSize: 100,
  total: items.length,
  hasMore: false,
});

const renderPlaylistsPage = () =>
  render(
    <PlaybackQueueProvider>
      <PlaylistsPage />
    </PlaybackQueueProvider>,
  );

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PlaylistsPage actions menu', () => {
  it('renames the selected playlist from the menu', async () => {
    const renamed = playlist({ name: 'Road Mix 2' });
    window.prompt = vi.fn(() => 'Road Mix 2');
    window.echo = {
      library: {
        getPlaylists: vi.fn().mockResolvedValueOnce([playlist()]).mockResolvedValue([renamed]),
        getPlaylistItems: vi.fn().mockResolvedValue(page([item()])),
        updatePlaylist: vi.fn().mockResolvedValue(renamed),
        getLikedTrackIds: vi.fn().mockResolvedValue({}),
      },
      playback: {
        getStatus: vi.fn().mockResolvedValue({ state: 'idle', currentTrackId: null, positionMs: 0, durationMs: 0, filePath: null }),
      },
    } as unknown as Window['echo'];

    renderPlaylistsPage();

    fireEvent.click(await screen.findByRole('button', { name: '更多歌单操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名歌单' }));

    await waitFor(() =>
      expect(window.echo.library.updatePlaylist).toHaveBeenCalledWith({ playlistId: 'playlist-1', name: 'Road Mix 2' }),
    );
    expect(await screen.findByText('歌单已重命名')).toBeTruthy();
  });

  it('updates sort mode and exports the playlist from the menu', async () => {
    const sorted = playlist({ sortMode: 'titleAsc' });
    window.echo = {
      library: {
        getPlaylists: vi.fn().mockResolvedValueOnce([playlist()]).mockResolvedValue([sorted]),
        getPlaylistItems: vi.fn().mockResolvedValue(page([item()])),
        updatePlaylist: vi.fn().mockResolvedValue(sorted),
        exportPlaylist: vi.fn().mockResolvedValue('D:\\Exports\\Road Mix.json'),
        getLikedTrackIds: vi.fn().mockResolvedValue({}),
      },
      playback: {
        getStatus: vi.fn().mockResolvedValue({ state: 'idle', currentTrackId: null, positionMs: 0, durationMs: 0, filePath: null }),
      },
    } as unknown as Window['echo'];

    renderPlaylistsPage();

    fireEvent.click(await screen.findByRole('button', { name: '更多歌单操作' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: '歌名 A-Z' }));
    await waitFor(() =>
      expect(window.echo.library.updatePlaylist).toHaveBeenCalledWith({ playlistId: 'playlist-1', sortMode: 'titleAsc' }),
    );
    expect(await screen.findByText('排序方式已更新')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '更多歌单操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'JSON' }));

    await waitFor(() =>
      expect(window.echo.library.exportPlaylist).toHaveBeenCalledWith({ playlistId: 'playlist-1', format: 'json' }),
    );
    expect(await screen.findByText('歌单已导出：D:\\Exports\\Road Mix.json')).toBeTruthy();
  });

  it('shows streaming quality only for remote playlists and sends the selected quality to playback', async () => {
    const remoteTrackItem = item({
      mediaType: 'stream_track',
      mediaId: 'streaming:qqmusic:song-mid',
      sourceProvider: 'qqmusic',
      sourceItemId: 'song-mid',
      titleSnapshot: 'Remote Song',
      track: null,
    });
    const playMediaItem = vi.fn().mockResolvedValue({
      state: 'playing',
      currentTrackId: 'streaming:qqmusic:song-mid',
      positionMs: 0,
      durationMs: 180000,
      filePath: null,
    });
    window.echo = {
      library: {
        getPlaylists: vi.fn().mockResolvedValue([playlist({ sourceProvider: 'qqmusic', sourcePlaylistId: '123' })]),
        getPlaylistItems: vi.fn().mockResolvedValue(page([remoteTrackItem])),
        getLikedTrackIds: vi.fn().mockResolvedValue({}),
        startPlaybackHistory: vi.fn().mockResolvedValue({ historyId: 'history-1' }),
      },
      playback: {
        getStatus: vi.fn().mockResolvedValue({ state: 'idle', currentTrackId: null, positionMs: 0, durationMs: 0, filePath: null }),
        playMediaItem,
      },
    } as unknown as Window['echo'];

    renderPlaylistsPage();

    const qualitySelect = await screen.findByLabelText('流媒体音质');
    expect(qualitySelect).toHaveProperty('value', 'hires');

    fireEvent.click(await screen.findByRole('button', { name: 'Remote Song' }));
    await waitFor(() =>
      expect(playMediaItem).toHaveBeenCalledWith({
        item: expect.objectContaining({
          mediaType: 'streaming',
          provider: 'qqmusic',
          providerTrackId: 'song-mid',
          quality: 'hires',
        }),
      }),
    );

    fireEvent.change(qualitySelect, { target: { value: 'standard' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remote Song' }));
    await waitFor(() =>
      expect(playMediaItem).toHaveBeenLastCalledWith({
        item: expect.objectContaining({
          quality: 'standard',
        }),
      }),
    );
  });

  it('hides streaming quality for local playlists', async () => {
    window.echo = {
      library: {
        getPlaylists: vi.fn().mockResolvedValue([playlist()]),
        getPlaylistItems: vi.fn().mockResolvedValue(page([item()])),
        getLikedTrackIds: vi.fn().mockResolvedValue({}),
      },
      playback: {
        getStatus: vi.fn().mockResolvedValue({ state: 'idle', currentTrackId: null, positionMs: 0, durationMs: 0, filePath: null }),
      },
    } as unknown as Window['echo'];

    renderPlaylistsPage();

    await screen.findByRole('button', { name: 'Song One' });
    expect(screen.queryByLabelText('流媒体音质')).toBeNull();
  });

  it('runs local file actions from the track context menu', async () => {
    const openTrackInFolder = vi.fn().mockResolvedValue(undefined);
    const copyTrackPath = vi.fn().mockResolvedValue(undefined);
    const openTrackWithSystem = vi.fn().mockResolvedValue(undefined);
    window.echo = {
      library: {
        getPlaylists: vi.fn().mockResolvedValue([playlist()]),
        getPlaylistItems: vi.fn().mockResolvedValue(page([item()])),
        getLikedTrackIds: vi.fn().mockResolvedValue({}),
        openTrackInFolder,
        copyTrackPath,
        openTrackWithSystem,
      },
      playback: {
        getStatus: vi.fn().mockResolvedValue({ state: 'idle', currentTrackId: null, positionMs: 0, durationMs: 0, filePath: null }),
      },
    } as unknown as Window['echo'];

    renderPlaylistsPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Open menu for Song One' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show in folder' }));
    await waitFor(() => expect(openTrackInFolder).toHaveBeenCalledWith('track-1'));

    fireEvent.click(screen.getByRole('button', { name: 'Open menu for Song One' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy path' }));
    await waitFor(() => expect(copyTrackPath).toHaveBeenCalledWith('track-1'));

    fireEvent.click(screen.getByRole('button', { name: 'Open menu for Song One' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open with system' }));
    await waitFor(() => expect(openTrackWithSystem).toHaveBeenCalledWith('track-1'));
  });

  it('refreshes a remote playlist by re-importing its source playlist', async () => {
    const remotePlaylist = playlist({
      sourceProvider: 'qqmusic',
      sourcePlaylistId: '778899',
      name: 'QQ Mix',
    });
    const importPlaylistFromUrl = vi.fn().mockResolvedValue({
      playlistId: 'playlist-1',
      playlistName: 'QQ Mix',
      importedCount: 2,
      provider: 'qqmusic',
      providerPlaylistId: '778899',
    });
    window.echo = {
      library: {
        getPlaylists: vi.fn().mockResolvedValue([remotePlaylist]),
        getPlaylistItems: vi.fn().mockResolvedValue(page([
          item({
            mediaType: 'stream_track',
            mediaId: 'streaming:qqmusic:song-mid',
            sourceProvider: 'qqmusic',
            sourceItemId: 'song-mid',
            titleSnapshot: 'Untitled',
            track: null,
          }),
        ])),
        getLikedTrackIds: vi.fn().mockResolvedValue({}),
      },
      playback: {
        getStatus: vi.fn().mockResolvedValue({ state: 'idle', currentTrackId: null, positionMs: 0, durationMs: 0, filePath: null }),
      },
      streaming: {
        importPlaylistFromUrl,
      },
    } as unknown as Window['echo'];

    renderPlaylistsPage();

    fireEvent.click(await screen.findByRole('button', { name: '刷新歌单' }));

    await waitFor(() =>
      expect(importPlaylistFromUrl).toHaveBeenCalledWith('https://y.qq.com/n/ryqq/playlist/778899'),
    );
    expect(await screen.findByText('已刷新歌单：QQ Mix，共 2 首')).toBeTruthy();
  });
});
