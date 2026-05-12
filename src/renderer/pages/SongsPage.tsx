import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  Download,
  FolderPlus,
  RefreshCw,
  RotateCw,
  Search,
  Trash2,
} from 'lucide-react';
import type { LibrarySort, LibraryTrack } from '../../shared/types/library';
import { TrackList } from '../components/library/TrackList';
import { usePlaybackQueue } from '../stores/PlaybackQueueProvider';

const pageSize = 100;

export const SongsPage = (): JSX.Element => {
  const [tracks, setTracks] = useState<LibraryTrack[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<LibrarySort>('title');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const { currentTrackId, playTrack, setQueue } = usePlaybackQueue();

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchInput.trim());
    }, 250);

    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const loadTracks = useCallback(
    async (nextPage: number, mode: 'replace' | 'append') => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setIsLoading(true);
      setError(null);

      try {
        const library = window.echo?.library;

        if (!library) {
          setTracks([]);
          setPage(1);
          setTotal(0);
          setHasMore(false);
          setError('Desktop bridge unavailable. Open ECHO Next in Electron to read the library.');
          return;
        }

        const result = await library.getTracks({
          page: nextPage,
          pageSize,
          search,
          sort,
        });

        if (requestIdRef.current !== requestId) {
          return;
        }

        setTracks((current) => (mode === 'append' ? [...current, ...result.items] : result.items));
        setPage(result.page);
        setTotal(result.total);
        setHasMore(result.hasMore);
      } catch (loadError) {
        if (requestIdRef.current === requestId) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        if (requestIdRef.current === requestId) {
          setIsLoading(false);
        }
      }
    },
    [search, sort],
  );

  useEffect(() => {
    void loadTracks(1, 'replace');
  }, [loadTracks]);

  useEffect(() => {
    // Phase 1.2: transport controls operate on the loaded SongsPage window only.
    // Do not expand this into a full playback queue until Library Core owns queue state.
    setQueue(tracks);
  }, [setQueue, tracks]);

  useEffect(() => {
    const handleLibraryChanged = (): void => {
      void loadTracks(1, 'replace');
    };

    window.addEventListener('library:changed', handleLibraryChanged);
    return () => window.removeEventListener('library:changed', handleLibraryChanged);
  }, [loadTracks]);

  const handleLoadMore = useCallback((): void => {
    if (!isLoading && hasMore) {
      void loadTracks(page + 1, 'append');
    }
  }, [hasMore, isLoading, loadTracks, page]);

  const handleRefresh = (): void => {
    void loadTracks(1, 'replace');
  };

  const handleImportFolder = (): void => {
    window.dispatchEvent(new Event('app:navigate:import-folder'));
  };

  const handlePlayTrack = useCallback(
    async (track: LibraryTrack): Promise<void> => {
      const playback = window.echo?.playback;

      if (!playback) {
        setError('Desktop bridge unavailable. Open ECHO Next in Electron to play local files.');
        return;
      }

      try {
        setError(null);
        await playTrack(track);
      } catch (playError) {
        setError(playError instanceof Error ? playError.message : String(playError));
      }
    },
    [playTrack],
  );

  return (
    <div className="songs-page">
      <header className="songs-header">
        <div className="songs-title-group">
          <h1>我的歌曲</h1>
          <span>{total} tracks</span>
        </div>

        <div className="songs-tools" aria-label="歌曲工具">
          <button className="tool-button" type="button" aria-label="导入文件夹" title="导入文件夹" onClick={handleImportFolder}>
            <FolderPlus size={17} />
          </button>
          <button className="tool-button" type="button" aria-label="扫描曲库" title="扫描曲库">
            <RotateCw size={17} />
          </button>
          <button className="tool-button" type="button" aria-label="下载" title="下载">
            <Download size={17} />
          </button>
          <button className="tool-button" type="button" aria-label="刷新" title="刷新" onClick={handleRefresh}>
            <RefreshCw size={17} />
          </button>
          <button className="tool-button danger" type="button" aria-label="删除" title="删除">
            <Trash2 size={17} />
          </button>
        </div>
      </header>

      <div className="songs-control-row">
        <label className="search-box">
          <Search size={18} aria-hidden="true" />
          <input
            type="search"
            placeholder="搜索歌曲 / 艺术家 / 专辑"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </label>

        <label className="sort-button sort-select">
          <select value={sort} onChange={(event) => setSort(event.target.value as LibrarySort)}>
            <option value="title">默认排序</option>
            <option value="artist">按艺术家</option>
            <option value="album">按专辑</option>
            <option value="recent">最近更新</option>
          </select>
          <ChevronDown size={15} />
        </label>
      </div>

      <TrackList
        tracks={tracks}
        currentTrackId={currentTrackId}
        canLoadMore={hasMore && !isLoading}
        onEndReached={handleLoadMore}
        onPlay={handlePlayTrack}
      />

      {error || isLoading ? (
        <div className="list-footer">
          <span>{error ?? '正在读取曲库...'}</span>
        </div>
      ) : null}
    </div>
  );
};
