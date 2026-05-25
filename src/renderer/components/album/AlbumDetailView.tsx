import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Disc3, ExternalLink, Heart, Info, Loader2, MoreHorizontal, Play, RefreshCw, Users } from 'lucide-react';
import type { AlbumOnlineInfo, EditableTrackTags, LibraryAlbum, LibraryPlaylist, LibraryTrack } from '../../../shared/types/library';
import { likedAlbumsChangedEvent, likedChangedEvent, likedTracksChangedEvent, useLikedTrackIds } from '../../hooks/useLikedMedia';
import { useAnimatedBackNavigation } from '../../hooks/useAnimatedBackNavigation';
import { usePlaybackQueue } from '../../stores/PlaybackQueueProvider';
import { openArtistDetailByName } from '../../utils/artistNavigation';
import { openAlbumDetailForTrack } from '../../utils/albumNavigation';
import { resolvePlaylistForTrackAdd } from '../../utils/appPrompt';
import { getLibraryBridge } from '../../utils/echoBridge';
import { OsuTimingPanel } from '../library/OsuTimingPanel';
import { TrackContextMenu } from '../library/TrackContextMenu';
import type { TrackMenuAction } from '../library/TrackContextMenu';
import { TrackTagEditorDrawer } from '../library/TrackTagEditorDrawer';
import { AlbumTrackList } from './AlbumTrackList';

type AlbumDetailViewProps = {
  album: LibraryAlbum;
  onBack: () => void;
};

const formatDuration = (duration: number): string | null => {
  if (!Number.isFinite(duration) || duration <= 0) {
    return null;
  }

  const totalMinutes = Math.round(duration / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return hours > 0 ? `${hours} hr ${minutes} min` : `${totalMinutes} min`;
};

const formatSampleRate = (sampleRate: number | null): string | null => {
  if (!sampleRate) {
    return null;
  }

  if (sampleRate >= 1000) {
    const khz = sampleRate / 1000;
    return `${Number.isInteger(khz) ? khz : khz.toFixed(1)}kHz`;
  }

  return `${sampleRate}Hz`;
};

const formatBitrate = (bitrate: number | null): string | null => {
  if (!bitrate || !Number.isFinite(bitrate)) {
    return null;
  }

  return bitrate >= 1000000 ? `${(bitrate / 1000000).toFixed(1)}Mbps` : `${Math.round(bitrate / 1000)}kbps`;
};

const formatTechnicalSummary = (track: LibraryTrack | null): string | null => {
  if (!track) {
    return null;
  }

  return [
    track.codec?.toUpperCase() ?? null,
    track.bitDepth ? `${track.bitDepth}bit` : null,
    formatSampleRate(track.sampleRate),
  ]
    .filter(Boolean)
    .join(' / ') || null;
};

const uniqueValues = (values: Array<string | null | undefined>): string[] =>
  Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));

const formatTrackCount = (count: number): string => `${count} ${count === 1 ? 'track' : 'tracks'}`;

type TrackMenuState = {
  track: LibraryTrack;
  position: { x: number; y: number };
};

type AlbumDetailTab = 'tracks' | 'credits' | 'information';

type OnlineInfoState = {
  loading: boolean;
  info: AlbumOnlineInfo | null;
  error: string | null;
  loadedForAlbumId: string | null;
};

const emptyOnlineInfoState = (): OnlineInfoState => ({
  loading: false,
  info: null,
  error: null,
  loadedForAlbumId: null,
});

const formatConfidence = (value: number): string => `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;

const creditRoleTitle = (role: string): string => {
  switch (role) {
    case 'Vocal':
      return 'Vocal & voices';
    case 'Performer':
      return 'Performance';
    case 'Composer':
      return 'Composition';
    case 'Lyrics':
      return 'Lyrics & words';
    case 'Arrangement':
      return 'Arrangement';
    case 'Production':
      return 'Production';
    case 'Engineering':
      return 'Engineering';
    case 'Label':
      return 'Release & label';
    default:
      return role || 'Other credits';
  }
};

const creditRoleSummary = (role: string): string => {
  switch (role) {
    case 'Vocal':
      return 'Lead vocals, featured voices, and credited vocal roles.';
    case 'Performer':
      return 'Instrumental and performance credits attached to the release or individual recordings.';
    case 'Composer':
      return 'Music-writing credits from release, recording, or work relationships.';
    case 'Lyrics':
      return 'Lyric, words, libretto, and related writing credits.';
    case 'Arrangement':
      return 'Arrangement, orchestration, and adaptation credits.';
    case 'Production':
      return 'Producer and production-side credits.';
    case 'Engineering':
      return 'Recording, mix, mastering, and sound engineering credits.';
    case 'Label':
      return 'Label and catalog information tied to the release.';
    default:
      return 'Additional credits found in the online metadata match.';
  }
};

const creditSourceLabel = (source: string): string => {
  switch (source) {
    case 'recording':
      return 'track credit';
    case 'work':
      return 'work credit';
    case 'label':
      return 'label';
    default:
      return 'album credit';
  }
};

export const AlbumDetailView = ({ album, onBack }: AlbumDetailViewProps): JSX.Element => {
  const { appendToQueue, currentTrackId, playTrack, playTrackNext, removeTrackFromQueue, replaceQueue, updateTrackSnapshot } = usePlaybackQueue();
  const { isReturning, returnBack } = useAnimatedBackNavigation(onBack);
  const [firstTrack, setFirstTrack] = useState<LibraryTrack | null>(null);
  const [loadedTracks, setLoadedTracks] = useState<LibraryTrack[]>([]);
  const [loadedTotal, setLoadedTotal] = useState(0);
  const [isLoadingFirstTrack, setIsLoadingFirstTrack] = useState(false);
  const [playError, setPlayError] = useState<string | null>(null);
  const [coverLarge, setCoverLarge] = useState<string | null>(null);
  const [failedLargeCover, setFailedLargeCover] = useState(false);
  const [failedThumbCover, setFailedThumbCover] = useState(false);
  const [isAlbumLiked, setIsAlbumLiked] = useState(false);
  const [trackMenu, setTrackMenu] = useState<TrackMenuState | null>(null);
  const [trackActionMessage, setTrackActionMessage] = useState<string | null>(null);
  const [osuTimingTrack, setOsuTimingTrack] = useState<LibraryTrack | null>(null);
  const [editingTrack, setEditingTrack] = useState<LibraryTrack | null>(null);
  const [isTagEditorOpen, setIsTagEditorOpen] = useState(false);
  const [tagEditorError, setTagEditorError] = useState<string | null>(null);
  const [isSavingTags, setIsSavingTags] = useState(false);
  const [activeTab, setActiveTab] = useState<AlbumDetailTab>('tracks');
  const [onlineInfoState, setOnlineInfoState] = useState<OnlineInfoState>(() => emptyOnlineInfoState());
  const tagEditorCloseTimerRef = useRef<number | null>(null);
  const onlineInfoRequestRef = useRef(0);
  const likedTrackIds = useLikedTrackIds(loadedTracks.map((track) => track.id));
  const duration = formatDuration(album.duration);
  const formatSummary = formatTechnicalSummary(firstTrack);
  const albumMetadata = useMemo(
    () =>
      [
        album.year ? String(album.year) : null,
        formatTrackCount(album.trackCount),
        duration,
        formatSummary,
      ].filter((item): item is string => Boolean(item)),
    [album.trackCount, album.year, duration, formatSummary],
  );
  const signalItems = useMemo(
    () =>
      firstTrack
        ? [
            firstTrack.codec?.toUpperCase() ?? null,
            firstTrack.bitDepth ? `${firstTrack.bitDepth}bit` : null,
            formatSampleRate(firstTrack.sampleRate),
            formatBitrate(firstTrack.bitrate),
          ].filter((item): item is string => Boolean(item))
        : [],
    [firstTrack],
  );
  const textureItems = useMemo(() => {
    const genres = uniqueValues(loadedTracks.map((track) => track.genre)).slice(0, 3);
    const discs = new Set(loadedTracks.map((track) => track.discNo).filter((discNo): discNo is number => Boolean(discNo && discNo > 0)));

    return [
      ...genres,
      discs.size > 1 ? `${discs.size} discs` : null,
      loadedTotal > loadedTracks.length ? `${loadedTracks.length} loaded` : null,
    ].filter((item): item is string => Boolean(item));
  }, [loadedTotal, loadedTracks]);
  const albumFacts = useMemo(
    () => [
      { label: 'Format', value: signalItems.join(' / ') || 'Reading signal' },
      { label: 'Genre', value: textureItems[0] ?? 'Unknown genre' },
      { label: 'Released', value: album.year ? String(album.year) : 'Unknown year' },
      { label: 'Library', value: `${loadedTotal > 0 ? `${loadedTracks.length}/${loadedTotal}` : formatTrackCount(album.trackCount)} ready` },
    ],
    [album.trackCount, album.year, loadedTotal, loadedTracks.length, signalItems, textureItems],
  );
  const albumSource = useMemo(
    () => ({ type: 'album' as const, label: album.title, albumId: album.id }),
    [album.id, album.title],
  );
  const detailCoverSrc = coverLarge && !failedLargeCover ? coverLarge : failedThumbCover ? null : album.coverThumb;

  const loadOnlineInfo = useCallback(
    async (force = false): Promise<void> => {
      const bridge = getLibraryBridge();
      if (!bridge?.getAlbumOnlineInfo) {
        setOnlineInfoState((current) => ({
          ...current,
          loading: false,
          error: 'Online album info is not available in this build.',
        }));
        return;
      }

      setOnlineInfoState((current) => ({
        ...current,
        loading: true,
        error: null,
      }));
      const requestId = onlineInfoRequestRef.current + 1;
      onlineInfoRequestRef.current = requestId;

      try {
        const info = await bridge.getAlbumOnlineInfo(album.id, { force });
        if (onlineInfoRequestRef.current !== requestId) {
          return;
        }
        setOnlineInfoState({
          loading: false,
          info,
          error: null,
          loadedForAlbumId: album.id,
        });
      } catch (error) {
        if (onlineInfoRequestRef.current !== requestId) {
          return;
        }
        setOnlineInfoState((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
          loadedForAlbumId: album.id,
        }));
      }
    },
    [album.id],
  );

  useEffect(() => {
    setActiveTab('tracks');
    setOnlineInfoState(emptyOnlineInfoState());
    void loadOnlineInfo(false);
  }, [album.id, loadOnlineInfo]);

  const refreshAlbumLiked = useCallback(async (): Promise<void> => {
    try {
      const result = await window.echo?.library?.getLikedAlbumIds([album.id]);
      setIsAlbumLiked(result?.[album.id] === true);
    } catch {
      setIsAlbumLiked(false);
    }
  }, [album.id]);

  useEffect(() => {
    let isMounted = true;

    setCoverLarge(null);
    setFailedLargeCover(false);
    setFailedThumbCover(false);

    window.echo.library
      .getAlbum(album.id)
      .then((detail) => {
        if (isMounted) {
          setCoverLarge(detail?.coverLarge ?? null);
        }
      })
      .catch(() => {
        if (isMounted) {
          setCoverLarge(null);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [album.id]);

  useEffect(() => {
    void refreshAlbumLiked();
    window.addEventListener(likedAlbumsChangedEvent, refreshAlbumLiked);
    return () => window.removeEventListener(likedAlbumsChangedEvent, refreshAlbumLiked);
  }, [refreshAlbumLiked]);

  const handleFirstTrackChange = useCallback((track: LibraryTrack | null, isLoading: boolean): void => {
    setFirstTrack(track);
    setIsLoadingFirstTrack(isLoading);
  }, []);

  const handleLoadedTracksChange = useCallback((tracks: LibraryTrack[], total: number, isLoading: boolean): void => {
    setLoadedTracks(tracks);
    setLoadedTotal(total);
    setFirstTrack(tracks[0] ?? null);
    setIsLoadingFirstTrack(isLoading && tracks.length === 0);
  }, []);

  const withAlbumCoverFallback = useCallback(
    (track: LibraryTrack): LibraryTrack => (track.coverThumb || !album.coverThumb ? track : { ...track, coverThumb: album.coverThumb }),
    [album.coverThumb],
  );

  const handlePlayTrack = useCallback(
    async (track: LibraryTrack): Promise<void> => {
      try {
        setPlayError(null);
        const playableTracks = (loadedTracks.length > 0 ? loadedTracks : [track]).map(withAlbumCoverFallback);
        await playTrack(withAlbumCoverFallback(track), {
          replaceQueueWith: playableTracks,
          source: albumSource,
        });
      } catch (error) {
        setPlayError(error instanceof Error ? error.message : String(error));
      }
    },
    [albumSource, loadedTracks, playTrack, withAlbumCoverFallback],
  );

  const handlePlayNow = useCallback((): void => {
    if (firstTrack) {
      // TODO: load the complete album queue through LibraryService once that API can fetch all album tracks at once.
      const playableTracks = loadedTracks.length > 0 ? loadedTracks.map(withAlbumCoverFallback) : [withAlbumCoverFallback(firstTrack)];
      const firstPlayableTrack = playableTracks[0] ?? firstTrack;
      replaceQueue(playableTracks, { startTrackId: firstPlayableTrack.id, source: albumSource });
      void playTrack(firstPlayableTrack, { source: albumSource });
    }
  }, [albumSource, firstTrack, loadedTracks, playTrack, replaceQueue, withAlbumCoverFallback]);

  const handleToggleAlbumLiked = useCallback(async (): Promise<void> => {
    try {
      const previous = isAlbumLiked;
      setIsAlbumLiked(!previous);
      const result = await window.echo.library.toggleAlbumLiked(album.id);
      setIsAlbumLiked(result.liked);
      window.dispatchEvent(new Event(likedAlbumsChangedEvent));
      window.dispatchEvent(new Event(likedChangedEvent));
    } catch (error) {
      setPlayError(error instanceof Error ? error.message : String(error));
      void refreshAlbumLiked();
    }
  }, [album.id, isAlbumLiked, refreshAlbumLiked]);

  const handleToggleTrackLiked = useCallback(async (track: LibraryTrack): Promise<void> => {
    try {
      await window.echo.library.toggleTrackLiked(track.id);
      window.dispatchEvent(new Event(likedTracksChangedEvent));
      window.dispatchEvent(new Event(likedChangedEvent));
    } catch (error) {
      setPlayError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const handleOpenTrackMenu = useCallback((track: LibraryTrack, position: { x: number; y: number }): void => {
    setTrackMenu({ track: withAlbumCoverFallback(track), position });
  }, [withAlbumCoverFallback]);

  const closeTagEditor = useCallback((): void => {
    setIsTagEditorOpen(false);
    if (tagEditorCloseTimerRef.current !== null) {
      window.clearTimeout(tagEditorCloseTimerRef.current);
    }
    tagEditorCloseTimerRef.current = window.setTimeout(() => {
      setEditingTrack(null);
      tagEditorCloseTimerRef.current = null;
    }, 280);
  }, []);

  const handleSaveTags = useCallback(
    async (
      track: LibraryTrack,
      tags: EditableTrackTags,
      coverPath: string | null,
      coverUrl: string | null,
      coverMimeType: string | null,
    ): Promise<void> => {
      const library = window.echo?.library;

      if (!library?.updateTrackTags) {
        setTagEditorError('Desktop bridge unavailable. Open ECHO Next in Electron to edit embedded tags.');
        return;
      }

      setIsSavingTags(true);
      setTagEditorError(null);

      try {
        const updatedTrack = await library.updateTrackTags({ trackId: track.id, tags, coverPath, coverUrl, coverMimeType });
        setLoadedTracks((current) => current.map((item) => (item.id === updatedTrack.id ? withAlbumCoverFallback(updatedTrack) : item)));
        setFirstTrack((current) => (current?.id === updatedTrack.id ? withAlbumCoverFallback(updatedTrack) : current));
        updateTrackSnapshot(updatedTrack.id, withAlbumCoverFallback(updatedTrack));
        window.dispatchEvent(new Event('library:changed'));
        closeTagEditor();
      } catch (saveError) {
        setTagEditorError(saveError instanceof Error ? saveError.message : String(saveError));
      } finally {
        setIsSavingTags(false);
      }
    },
    [closeTagEditor, updateTrackSnapshot, withAlbumCoverFallback],
  );

  const handleTrackMenuAction = useCallback(
    async (action: TrackMenuAction, track: LibraryTrack, playlistTarget?: LibraryPlaylist): Promise<void> => {
      const library = window.echo?.library;
      setTrackMenu(null);

      if (!library && action !== 'play-next' && action !== 'add-to-queue' && action !== 'remove-from-queue' && action !== 'open-osu-timing' && action !== 'reload-embedded-tags') {
        setPlayError('Desktop bridge unavailable. Open ECHO Next in Electron to use file actions.');
        return;
      }

      try {
        setPlayError(null);
        setTrackActionMessage(null);

        if (
          track.mediaType === 'remote' &&
          (action === 'edit-tags' ||
            action === 'reload-embedded-tags' ||
            action === 'open-osu-timing' ||
            action === 'show-in-folder' ||
            action === 'copy-path' ||
            action === 'open-system' ||
            action === 'delete-song')
        ) {
          setPlayError('Remote tracks do not support local file actions yet.');
          return;
        }

        switch (action) {
          case 'play-next':
            playTrackNext(withAlbumCoverFallback(track), albumSource);
            return;
          case 'add-to-queue':
            appendToQueue(withAlbumCoverFallback(track), albumSource);
            return;
          case 'toggle-liked':
            await handleToggleTrackLiked(track);
            return;
          case 'remove-from-queue':
            {
              const removedCount = removeTrackFromQueue(track.id);
              setTrackActionMessage(removedCount > 0 ? `Removed from queue: ${track.title}` : `This track is not in the queue: ${track.title}`);
            }
            return;
          case 'open-osu-timing':
            setOsuTimingTrack(withAlbumCoverFallback(track));
            return;
          case 'edit-tags':
            setTagEditorError(null);
            if (tagEditorCloseTimerRef.current !== null) {
              window.clearTimeout(tagEditorCloseTimerRef.current);
              tagEditorCloseTimerRef.current = null;
            }
            setIsTagEditorOpen(false);
            setEditingTrack(track);
            window.requestAnimationFrame(() => setIsTagEditorOpen(true));
            return;
          case 'reload-embedded-tags':
            {
              const result = await library!.loadEmbeddedTrackTags(track.id);
              const nextTrack = withAlbumCoverFallback(result.track);
              setLoadedTracks((current) => current.map((item) => (item.id === nextTrack.id ? nextTrack : item)));
              setFirstTrack((current) => (current?.id === nextTrack.id ? nextTrack : current));
              if (editingTrack?.id === nextTrack.id) {
                setEditingTrack(nextTrack);
              }
              updateTrackSnapshot(nextTrack.id, nextTrack);
              setTrackActionMessage(`已从内嵌标签重新加载：${nextTrack.title}`);
              window.dispatchEvent(new Event('library:changed'));
            }
            return;
          case 'go-to-album':
            if (!(await openAlbumDetailForTrack(track))) {
              setTrackActionMessage(`Already viewing this album: ${album.title}`);
            }
            return;
          case 'show-in-folder':
            await library?.openTrackInFolder(track.id);
            return;
          case 'copy-path':
            await library?.copyTrackPath(track.id);
            return;
          case 'open-system':
            await library?.openTrackWithSystem(track.id);
            return;
          case 'copy-name-artist':
            await library?.copyTrackNameArtist(track.id);
            return;
          case 'copy-cover':
            if (!(await library?.copyTrackCover(track.id))) {
              setPlayError('This track does not have cover art to copy.');
            }
            return;
          case 'save-cover':
            if (!(await library?.saveTrackCover(track.id))) {
              setPlayError('No cover art was saved for this track.');
            }
            return;
          case 'delete-song':
            if (!window.confirm(`Delete the music file?\n${track.title}`)) {
              return;
            }
            await library?.deleteTrackFile(track.id);
            setLoadedTracks((current) => current.filter((item) => item.id !== track.id));
            setLoadedTotal((current) => Math.max(0, current - 1));
            if (firstTrack?.id === track.id) {
              setFirstTrack(loadedTracks.find((item) => item.id !== track.id) ?? null);
            }
            window.dispatchEvent(new Event('library:changed'));
            return;
          case 'add-to-playlist':
            {
              const playlist = playlistTarget ?? (await resolvePlaylistForTrackAdd(library!));
              if (!playlist) {
                return;
              }

              await library!.addTrackToPlaylist(playlist.id, track.id);
              window.dispatchEvent(new Event('library:playlists-changed'));
              setTrackActionMessage(`Added to playlist: ${playlist.name}`);
            }
            return;
          default:
            setPlayError('This track action is not available yet.');
        }
      } catch (actionError) {
        setPlayError(actionError instanceof Error ? actionError.message : String(actionError));
      }
    },
    [
      album.title,
      albumSource,
      appendToQueue,
      editingTrack,
      firstTrack?.id,
      handleToggleTrackLiked,
      loadedTracks,
      playTrackNext,
      removeTrackFromQueue,
      updateTrackSnapshot,
      withAlbumCoverFallback,
    ],
  );

  const handleDetailCoverError = useCallback((): void => {
    if (coverLarge && !failedLargeCover) {
      setFailedLargeCover(true);
      return;
    }

    setFailedThumbCover(true);
  }, [coverLarge, failedLargeCover]);

  const handleOpenAlbumArtist = useCallback((): void => {
    const artistName = album.albumArtist.trim();
    if (!artistName) {
      return;
    }

    void openArtistDetailByName(artistName)
      .then((artist) => {
        if (!artist) {
          setTrackActionMessage(`Artist not found: ${artistName}`);
        }
      })
      .catch((error) => {
        setTrackActionMessage(error instanceof Error ? error.message : String(error));
      });
  }, [album.albumArtist]);

  const renderOnlineState = (section: 'credits' | 'information'): JSX.Element | null => {
    const info = onlineInfoState.info;
    const isEmpty =
      info &&
      (section === 'credits'
        ? info.credits.length === 0
        : !info.information && !info.artistInformation);

    if (onlineInfoState.loading && !info) {
      return (
        <div className="album-online-state">
          <Loader2 className="spinning-icon" size={18} />
          <span>Reading online album info...</span>
        </div>
      );
    }

    if (onlineInfoState.error && !info) {
      return (
        <div className="album-online-state">
          <strong>Online info unavailable</strong>
          <span>{onlineInfoState.error}</span>
          <button type="button" onClick={() => void loadOnlineInfo(true)}>
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>
      );
    }

    if (isEmpty) {
      return (
        <div className="album-online-state">
          <strong>No reliable online info found</strong>
          <span>{info.errors[0] ?? 'MusicBrainz and Wikipedia did not return enough matching data for this album.'}</span>
          <button type="button" onClick={() => void loadOnlineInfo(true)} disabled={onlineInfoState.loading}>
            {onlineInfoState.loading ? <Loader2 className="spinning-icon" size={14} /> : <RefreshCw size={14} />}
            Refresh
          </button>
        </div>
      );
    }

    return null;
  };

  const renderOnlineHeader = (): JSX.Element | null => {
    const info = onlineInfoState.info;
    if (!info) {
      return null;
    }

    return (
      <div className="album-online-header">
        <div>
          <span>Online sources</span>
          <strong>{info.sources.map((source) => source.label).join(' / ') || 'No source matched'}</strong>
          {info.match ? (
            <small>
              {info.match.possible ? 'Possible MusicBrainz match' : 'MusicBrainz match'} - {formatConfidence(info.match.confidence)}
            </small>
          ) : null}
        </div>
        <button type="button" onClick={() => void loadOnlineInfo(true)} disabled={onlineInfoState.loading}>
          {onlineInfoState.loading ? <Loader2 className="spinning-icon" size={14} /> : <RefreshCw size={14} />}
          Refresh
        </button>
      </div>
    );
  };

  const renderCredits = (): JSX.Element => {
    const state = renderOnlineState('credits');
    if (state) {
      return state;
    }

    const info = onlineInfoState.info;
    return (
      <div className="album-online-panel album-credits-panel">
        {renderOnlineHeader()}
        {info?.credits.length ? (
          <section className="album-credit-overview" aria-label="Credit overview">
            <Users size={18} />
            <div>
              <span>Album credits</span>
              <strong>{info.credits.reduce((count, group) => count + group.people.length, 0)} credited people and organizations</strong>
            </div>
          </section>
        ) : null}
        {info?.credits.map((group) => (
          <section className="album-credit-group" key={group.role}>
            <header>
              <div>
                <span>{group.role}</span>
                <h3>{creditRoleTitle(group.role)}</h3>
              </div>
              <small>{group.people.length} entries</small>
            </header>
            <p>{creditRoleSummary(group.role)}</p>
            <div className="album-credit-people">
              {group.people.map((person) => (
                <span className="album-credit-chip" key={`${group.role}-${person.name}-${person.trackTitle ?? ''}-${person.detail ?? ''}`}>
                  <strong>{person.name}</strong>
                  <small>{[person.detail, creditSourceLabel(person.source)].filter(Boolean).join(' - ')}</small>
                  {person.trackTitle ? <em>Track: {person.trackTitle}</em> : null}
                </span>
              ))}
            </div>
          </section>
        ))}
      </div>
    );
  };

  const renderInformation = (): JSX.Element => {
    const state = renderOnlineState('information');
    if (state) {
      return state;
    }

    const info = onlineInfoState.info;
    const renderInformationArticle = (information: NonNullable<AlbumOnlineInfo['information']>, label: string): JSX.Element => (
      <section className="album-information-article" key={label}>
        <div className="album-information-main">
          <span>{label} - {information.language}.wikipedia.org</span>
          <h3>{information.title}</h3>
          {information.description ? <small>{information.description}</small> : null}
          <p>{information.extract}</p>
        </div>
        <div className="album-information-aside">
          {information.thumbnailUrl ? <img alt="" src={information.thumbnailUrl} loading="lazy" decoding="async" /> : null}
          {information.url ? (
            <a href={information.url} target="_blank" rel="noreferrer">
              <ExternalLink size={14} />
              Open source
            </a>
          ) : null}
        </div>
      </section>
    );

    return (
      <div className="album-online-panel album-information-panel">
        {renderOnlineHeader()}
        <section className="album-information-overview" aria-label="Album and artist overview">
          <Info size={18} />
          <div>
            <span>At a glance</span>
            <strong>{album.albumArtist}</strong>
            <small>{[album.title, album.year ? String(album.year) : null, formatTrackCount(album.trackCount)].filter(Boolean).join(' - ')}</small>
          </div>
        </section>
        <div className="album-information-articles">
          {info?.information ? renderInformationArticle(info.information, 'Album profile') : null}
          {info?.artistInformation ? renderInformationArticle(info.artistInformation, 'Artist profile') : null}
        </div>
      </div>
    );
  };

  return (
    <div className={`album-detail-page ${isReturning ? 'is-returning' : ''}`}>
      <button className="album-back-button" type="button" onClick={returnBack}>
        <ArrowLeft size={17} />
        Albums
      </button>

      <section className="album-detail-hero" aria-label={`${album.title} album details`}>
        <div className="album-detail-cover" data-empty={!detailCoverSrc}>
          {detailCoverSrc ? (
            <img alt="" decoding="async" draggable={false} height={320} src={detailCoverSrc} width={320} onError={handleDetailCoverError} />
          ) : (
            <Disc3 size={58} />
          )}
        </div>

        <div className="album-detail-console">
          <div className="album-detail-copy">
            <span className="album-detail-kicker">Album</span>
            <h1>{album.title}</h1>
            <button className="album-detail-artist-link" type="button" aria-label={`Open artist ${album.albumArtist}`} onClick={handleOpenAlbumArtist}>
              {album.albumArtist}
            </button>

            <div className="album-detail-meta" aria-label="Album metadata">
              {albumMetadata.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          </div>

          <div className="album-detail-actions">
            <button className="album-primary-action" type="button" disabled={!firstTrack || isLoadingFirstTrack} onClick={handlePlayNow}>
              <Play size={16} fill="currentColor" />
              {isLoadingFirstTrack ? 'Reading album' : 'Play Now'}
            </button>
            <button
              className={`album-icon-action ${isAlbumLiked ? 'is-liked' : ''}`}
              type="button"
              aria-label={isAlbumLiked ? 'Unlike album' : 'Like album'}
              aria-pressed={isAlbumLiked}
              title={isAlbumLiked ? 'Unlike album' : 'Like album'}
              onClick={() => void handleToggleAlbumLiked()}
            >
              <Heart size={16} fill={isAlbumLiked ? 'currentColor' : 'none'} />
            </button>
            <button className="album-icon-action" type="button" aria-label="More album actions" title="More album actions">
              <MoreHorizontal size={17} />
            </button>
          </div>

          {playError || trackActionMessage ? <p className="album-detail-error">{playError ?? trackActionMessage}</p> : null}
        </div>

        <aside className="album-detail-facts" aria-label="Album info">
          {albumFacts.map((fact) => (
            <div className="album-fact" key={fact.label}>
              <span>{fact.label}</span>
              <strong>{fact.value}</strong>
            </div>
          ))}
        </aside>
      </section>

      <section className="album-detail-track-console" aria-label={`${album.title} track console`}>
        <header className="album-detail-tabs" aria-label="Album sections">
          <button className="album-detail-tab" type="button" aria-current={activeTab === 'tracks' ? 'page' : undefined} onClick={() => setActiveTab('tracks')}>
            Tracks
          </button>
          <button className="album-detail-tab" type="button" aria-current={activeTab === 'credits' ? 'page' : undefined} onClick={() => setActiveTab('credits')}>
            Credits
          </button>
          <button className="album-detail-tab" type="button" aria-current={activeTab === 'information' ? 'page' : undefined} onClick={() => setActiveTab('information')}>
            Information
          </button>
        </header>
        {activeTab === 'tracks' ? (
          <AlbumTrackList
            albumId={album.id}
            currentTrackId={currentTrackId}
            summary={{
              duration: duration ?? 'Unknown length',
              signal: formatSummary ?? 'Reading signal',
              totalLabel: loadedTotal > 0 ? formatTrackCount(loadedTotal) : formatTrackCount(album.trackCount),
            }}
            onFirstTrackChange={handleFirstTrackChange}
            onLoadedTracksChange={handleLoadedTracksChange}
            onOpenTrackMenu={handleOpenTrackMenu}
            onPlayTrack={handlePlayTrack}
            onToggleTrackLiked={handleToggleTrackLiked}
          />
        ) : activeTab === 'credits' ? (
          renderCredits()
        ) : (
          renderInformation()
        )}
      </section>

      {trackMenu ? (
        <TrackContextMenu
          track={trackMenu.track}
          position={trackMenu.position}
          liked={likedTrackIds[trackMenu.track.id] === true}
          onAction={(action, track, playlist) => void handleTrackMenuAction(action, track, playlist)}
          onClose={() => setTrackMenu(null)}
        />
      ) : null}

      <TrackTagEditorDrawer
        track={editingTrack}
        isOpen={isTagEditorOpen}
        isSaving={isSavingTags}
        error={tagEditorError}
        onClose={closeTagEditor}
        onSave={(track, tags, coverPath, coverUrl, coverMimeType) => void handleSaveTags(track, tags, coverPath, coverUrl, coverMimeType)}
        onTrackUpdated={(updatedTrack) => {
          const nextTrack = withAlbumCoverFallback(updatedTrack);
          setEditingTrack(nextTrack);
          setLoadedTracks((current) => current.map((item) => (item.id === nextTrack.id ? nextTrack : item)));
          setFirstTrack((current) => (current?.id === nextTrack.id ? nextTrack : current));
          updateTrackSnapshot(nextTrack.id, nextTrack);
          window.dispatchEvent(new Event('library:changed'));
        }}
      />

      <OsuTimingPanel
        track={osuTimingTrack}
        isOpen={Boolean(osuTimingTrack)}
        onClose={() => setOsuTimingTrack(null)}
        onTrackUpdated={(updatedTrack) => {
          const nextTrack = withAlbumCoverFallback(updatedTrack);
          setOsuTimingTrack(nextTrack);
          setLoadedTracks((current) => current.map((item) => (item.id === nextTrack.id ? nextTrack : item)));
          setFirstTrack((current) => (current?.id === nextTrack.id ? nextTrack : current));
          updateTrackSnapshot(nextTrack.id, nextTrack);
        }}
      />
    </div>
  );
};
