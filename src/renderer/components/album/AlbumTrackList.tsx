import { useCallback, useEffect, useRef, useState } from 'react';
import type { LibraryPage, LibraryTrack } from '../../../shared/types/library';

type AlbumTrackListProps = {
  albumId: string;
  currentTrackId: string | null;
  onFirstTrackChange?: (track: LibraryTrack | null, isLoading: boolean) => void;
  onPlayTrack: (track: LibraryTrack) => void | Promise<void>;
};

const pageSize = 100;

const formatDuration = (duration: number): string => {
  if (!Number.isFinite(duration) || duration <= 0) {
    return '--:--';
  }

  const totalSeconds = Math.round(duration);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

const formatSampleRate = (sampleRate: number | null): string | null => {
  if (!sampleRate) {
    return null;
  }

  return sampleRate >= 1000 ? `${Math.round(sampleRate / 1000)}kHz` : `${sampleRate}Hz`;
};

const technicalTags = (track: LibraryTrack): string[] =>
  [
    track.codec?.toUpperCase() ?? null,
    track.bitDepth ? `${track.bitDepth}bit` : null,
    formatSampleRate(track.sampleRate),
  ].filter((tag): tag is string => Boolean(tag));

export const AlbumTrackList = ({
  albumId,
  currentTrackId,
  onFirstTrackChange,
  onPlayTrack,
}: AlbumTrackListProps): JSX.Element => {
  const [tracks, setTracks] = useState<LibraryTrack[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const isLoadingRef = useRef(false);

  const loadTracks = useCallback(
    async (nextPage: number, mode: 'replace' | 'append'): Promise<void> => {
      if (mode === 'append' && isLoadingRef.current) {
        return;
      }

      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      isLoadingRef.current = true;
      setIsLoading(true);
      setError(null);

      try {
        const library = window.echo?.library;

        if (!library) {
          setTracks([]);
          setPage(1);
          setTotal(0);
          setHasMore(false);
          setError('Desktop bridge unavailable. Open ECHO Next in Electron to read album tracks.');
          return;
        }

        const result: LibraryPage<LibraryTrack> = await library.getAlbumTracks(albumId, {
          page: nextPage,
          pageSize,
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
          isLoadingRef.current = false;
          setIsLoading(false);
        }
      }
    },
    [albumId],
  );

  useEffect(() => {
    setTracks([]);
    setPage(1);
    setTotal(0);
    setHasMore(false);
    void loadTracks(1, 'replace');
  }, [loadTracks]);

  useEffect(() => {
    onFirstTrackChange?.(tracks[0] ?? null, isLoading && tracks.length === 0);
  }, [isLoading, onFirstTrackChange, tracks]);

  const handleLoadMore = useCallback((): void => {
    if (!isLoadingRef.current && hasMore) {
      void loadTracks(page + 1, 'append');
    }
  }, [hasMore, loadTracks, page]);

  return (
    <section className="album-track-section" aria-label="Album tracks">
      <div className="album-track-toolbar">
        <span>{total} tracks</span>
      </div>

      <div className="album-track-list" role="list">
        {tracks.map((track, index) => {
          const isPlaying = track.id === currentTrackId;
          const trackNumber = track.trackNo ?? index + 1;
          const tags = technicalTags(track);

          return (
            <button
              className="album-track-row"
              data-playing={isPlaying}
              key={track.id}
              role="listitem"
              type="button"
              onClick={() => void onPlayTrack(track)}
            >
              <span className="album-track-number">{trackNumber}</span>
              <span className="album-track-copy">
                <strong>{track.title}</strong>
                <small>{track.artist}</small>
              </span>
              <span className="album-track-tags" aria-label="Track format">
                {tags.map((tag) => (
                  <em key={`${track.id}-${tag}`}>{tag}</em>
                ))}
              </span>
              <span className="album-track-duration">{formatDuration(track.duration)}</span>
            </button>
          );
        })}
      </div>

      {hasMore ? (
        <button className="album-load-more" type="button" disabled={isLoading} onClick={handleLoadMore}>
          {isLoading ? 'Loading...' : 'Load more'}
        </button>
      ) : null}

      {error ? <p className="album-detail-error">{error}</p> : null}
      {!isLoading && tracks.length === 0 && !error ? <p className="album-detail-empty">No tracks found for this album.</p> : null}
    </section>
  );
};
