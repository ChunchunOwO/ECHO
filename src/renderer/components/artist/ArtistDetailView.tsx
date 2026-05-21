import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CalendarDays, ExternalLink, ListPlus, MapPin, Play, RefreshCw, Shuffle, Ticket } from 'lucide-react';
import type { AppSettings } from '../../../shared/types/appSettings';
import type { ArtistInsights, ArtistInsightEdge, ArtistInsightRelationKind, LibraryAlbum, LibraryArtist, LibraryTrack } from '../../../shared/types/library';
import { useAnimatedBackNavigation } from '../../hooks/useAnimatedBackNavigation';
import { usePlaybackQueue } from '../../stores/PlaybackQueueProvider';
import { requestArtistDetailNavigation } from '../../utils/artistNavigation';
import { AlbumDetailView } from '../album/AlbumDetailView';
import { readPageScrollTop, writePageScrollTop } from '../ui/InfiniteScrollSentinel';
import { ArtistAlbumGrid } from './ArtistAlbumGrid';
import { ArtistTrackList } from './ArtistTrackList';
import { artistMark } from './artistVisual';

type ArtistDetailViewProps = {
  artist: LibraryArtist;
  onBack: () => void;
};

const formatCount = (count: number, singular: string): string => `${count} ${count === 1 ? singular : `${singular}s`}`;

const formatDuration = (tracks: LibraryTrack[]): string => {
  const totalSeconds = tracks.reduce((total, track) => total + (Number.isFinite(track.duration) ? track.duration : 0), 0);

  if (totalSeconds <= 0) {
    return 'Reading length';
  }

  const minutes = Math.round(totalSeconds / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours} hr ${rest} min loaded` : `${minutes} min loaded`;
};

const relationLabels: Record<ArtistInsightRelationKind, string> = {
  same_album: 'Same album',
  collaboration: 'Collaboration',
  same_genre: 'Genre',
  similar_bpm: 'BPM',
  playback_adjacent: 'History',
  online_similar: 'Similar',
  member: 'Member',
  external_url: 'Link',
};

const describeRelation = (edge: ArtistInsightEdge | undefined): string =>
  edge ? `${relationLabels[edge.kind]} · ${edge.evidence}` : 'Local library signal';

const getConfiguredConcertSources = (settings: Partial<AppSettings> | null | undefined): string[] => {
  if (!settings) {
    return [];
  }

  return [
    settings.onlineArtistInfoBandsintownAppId ? 'Bandsintown' : null,
    settings.onlineArtistInfoTicketmasterApiKey ? 'Ticketmaster' : null,
    settings.onlineArtistInfoSeatGeekClientId ? 'SeatGeek' : null,
  ].filter((source): source is string => Boolean(source));
};

const compactBio = (value: string): string => (value.length > 360 ? `${value.slice(0, 357).trim()}...` : value);

const formatEventDate = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

const eventLocation = (event: ArtistInsights['concerts']['events'][number]): string =>
  [event.venueName, event.city, event.region, event.country].filter(Boolean).join(' · ') || 'Venue to be announced';

export const ArtistDetailView = ({ artist, onBack }: ArtistDetailViewProps): JSX.Element => {
  const { appendToQueue, currentTrackId, playTrack, playTrackNext, replaceQueue } = usePlaybackQueue();
  const { isReturning, returnBack } = useAnimatedBackNavigation(onBack);
  const [verifiedArtist, setVerifiedArtist] = useState<LibraryArtist | null>(artist);
  const [isVerifyingArtist, setIsVerifyingArtist] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [loadedTracks, setLoadedTracks] = useState<LibraryTrack[]>([]);
  const [loadedTrackTotal, setLoadedTrackTotal] = useState(artist.trackCount);
  const [areTracksLoading, setAreTracksLoading] = useState(false);
  const [playError, setPlayError] = useState<string | null>(null);
  const [artistInsights, setArtistInsights] = useState<ArtistInsights | null>(null);
  const [areInsightsLoading, setAreInsightsLoading] = useState(false);
  const [insightsError, setInsightsError] = useState<string | null>(null);
  const [onlineRefreshRequest, setOnlineRefreshRequest] = useState(0);
  const [configuredConcertSources, setConfiguredConcertSources] = useState<string[]>([]);
  const [configuredConcertRegion, setConfiguredConcertRegion] = useState<string | null>(null);
  const [selectedAlbum, setSelectedAlbum] = useState<LibraryAlbum | null>(null);
  const [failedHeroImageUrl, setFailedHeroImageUrl] = useState<string | null>(null);
  const detailRootRef = useRef<HTMLDivElement | null>(null);
  const detailScrollTopRef = useRef(0);
  const shouldRestoreDetailScrollRef = useRef(false);
  const source = useMemo(() => ({ type: 'artist' as const, label: artist.name, artistId: artist.id }), [artist.id, artist.name]);
  const displayArtist = verifiedArtist ?? artist;
  const displayedTrackCount = Math.max(displayArtist.trackCount, loadedTrackTotal);
  const artistAvatarUrl = displayArtist.avatarUrl ?? displayArtist.avatarThumbUrl ?? null;
  const heroImageUrl = artistAvatarUrl ?? displayArtist.coverThumb ?? null;
  const shouldShowHeroImage = Boolean(heroImageUrl && failedHeroImageUrl !== heroImageUrl);
  const heroAvatarSrcSet = artistAvatarUrl && displayArtist.avatarThumbUrl && displayArtist.avatarUrl && displayArtist.avatarThumbUrl !== displayArtist.avatarUrl
    ? `${displayArtist.avatarThumbUrl} 192w, ${displayArtist.avatarUrl} 1024w`
    : undefined;

  useEffect(() => {
    setVerifiedArtist(artist);
    setFailedHeroImageUrl(null);
  }, [artist]);

  useEffect(() => {
    let isCancelled = false;

    const verifyArtist = async (): Promise<void> => {
      const library = window.echo?.library;

      if (!library?.getArtist) {
        setVerifyError('Desktop bridge unavailable. Open ECHO Next in Electron to read this artist.');
        return;
      }

      setIsVerifyingArtist(true);
      setVerifyError(null);

      try {
        const result = await library.getArtist(artist.id);

        if (!isCancelled) {
          setVerifiedArtist(result);
        }
      } catch (error) {
        if (!isCancelled) {
          setVerifyError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!isCancelled) {
          setIsVerifyingArtist(false);
        }
      }
    };

    void verifyArtist();

    return () => {
      isCancelled = true;
    };
  }, [artist.id]);

  useEffect(() => {
    setSelectedAlbum(null);
    setFailedHeroImageUrl(null);
  }, [artist.id]);

  useEffect(() => {
    let isCancelled = false;

    const applySettings = (settings: Partial<AppSettings> | null | undefined): void => {
      if (isCancelled) {
        return;
      }

      setConfiguredConcertSources(getConfiguredConcertSources(settings));
      setConfiguredConcertRegion(settings?.onlineArtistInfoRegion?.trim() || null);
    };

    void window.echo?.app?.getSettings?.().then(applySettings).catch(() => applySettings(null));

    const handleSettingsChanged = (event: Event): void => {
      const detail = event instanceof CustomEvent ? event.detail as Partial<AppSettings> : null;
      if (
        detail &&
        (
          Object.prototype.hasOwnProperty.call(detail, 'onlineArtistInfoBandsintownAppId') ||
          Object.prototype.hasOwnProperty.call(detail, 'onlineArtistInfoTicketmasterApiKey') ||
          Object.prototype.hasOwnProperty.call(detail, 'onlineArtistInfoSeatGeekClientId') ||
          Object.prototype.hasOwnProperty.call(detail, 'onlineArtistInfoRegion')
        )
      ) {
        applySettings(detail);
      }
    };

    window.addEventListener('settings:changed', handleSettingsChanged);

    return () => {
      isCancelled = true;
      window.removeEventListener('settings:changed', handleSettingsChanged);
    };
  }, []);

  useEffect(() => {
    let isCancelled = false;

    const loadInsights = async (): Promise<void> => {
      const library = window.echo?.library;
      if (!library?.getArtistInsights) {
        setArtistInsights(null);
        setInsightsError(null);
        return;
      }

      setAreInsightsLoading(true);
      setInsightsError(null);

      try {
        const localResult = await library.getArtistInsights(artist.id, { limit: 12, includeOnline: false });
        if (!isCancelled) {
          setArtistInsights(localResult);
        }

        const result = await library.getArtistInsights(artist.id, {
          limit: 12,
          includeOnline: true,
          forceOnline: onlineRefreshRequest > 0,
          region: configuredConcertRegion,
        });
        if (!isCancelled) {
          setArtistInsights(result);
        }
      } catch (error) {
        if (!isCancelled) {
          setArtistInsights(null);
          setInsightsError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!isCancelled) {
          setAreInsightsLoading(false);
        }
      }
    };

    void loadInsights();

    return () => {
      isCancelled = true;
    };
  }, [artist.id, configuredConcertRegion, configuredConcertSources.length, onlineRefreshRequest]);

  useLayoutEffect(() => {
    if (selectedAlbum || !shouldRestoreDetailScrollRef.current) {
      return;
    }

    writePageScrollTop(detailRootRef.current, detailScrollTopRef.current);
    shouldRestoreDetailScrollRef.current = false;
  }, [selectedAlbum]);

  const handleLoadedTracksChange = useCallback((tracks: LibraryTrack[], total: number, isLoading: boolean): void => {
    setLoadedTracks(tracks);
    setLoadedTrackTotal(total);
    setAreTracksLoading(isLoading);
  }, []);

  const handlePlayTrack = useCallback(
    async (track: LibraryTrack): Promise<void> => {
      try {
        setPlayError(null);
        const contextTracks = loadedTracks.length > 0 ? loadedTracks : [track];
        await playTrack(track, {
          replaceQueueWith: contextTracks,
          source,
        });
      } catch (error) {
        setPlayError(error instanceof Error ? error.message : String(error));
      }
    },
    [loadedTracks, playTrack, source],
  );

  const handlePlayArtist = useCallback(async (): Promise<void> => {
    const firstTrack = loadedTracks[0];

    if (!firstTrack) {
      return;
    }

    try {
      setPlayError(null);
      replaceQueue(loadedTracks, { startTrackId: firstTrack.id, source });
      await playTrack(firstTrack, { source });
    } catch (error) {
      setPlayError(error instanceof Error ? error.message : String(error));
    }
  }, [loadedTracks, playTrack, replaceQueue, source]);

  const handleShuffleArtist = useCallback(async (): Promise<void> => {
    if (loadedTracks.length === 0) {
      return;
    }

    const startTrack = loadedTracks[Math.floor(Math.random() * loadedTracks.length)];

    try {
      setPlayError(null);
      replaceQueue(loadedTracks, { startTrackId: startTrack.id, source });
      await playTrack(startTrack, { source });
    } catch (error) {
      setPlayError(error instanceof Error ? error.message : String(error));
    }
  }, [loadedTracks, playTrack, replaceQueue, source]);

  const handleQueueArtist = useCallback((): void => {
    loadedTracks.forEach((track) => appendToQueue(track, source));
  }, [appendToQueue, loadedTracks, source]);

  const handleAppendTrack = useCallback((track: LibraryTrack): void => appendToQueue(track, source), [appendToQueue, source]);
  const handlePlayTrackNext = useCallback((track: LibraryTrack): void => playTrackNext(track, source), [playTrackNext, source]);
  const handleSelectAlbum = useCallback((album: LibraryAlbum): void => {
    detailScrollTopRef.current = readPageScrollTop(detailRootRef.current);
    shouldRestoreDetailScrollRef.current = true;
    setSelectedAlbum(album);
  }, []);
  const handleRefreshOnlineInfo = useCallback((): void => {
    setOnlineRefreshRequest((current) => current + 1);
  }, []);
  const handleOpenInsightArtist = useCallback((nodeId: string): void => {
    const library = window.echo?.library;
    if (!library?.getArtist) {
      return;
    }

    void library.getArtist(nodeId).then((target) => {
      if (target) {
        requestArtistDetailNavigation(target);
      }
    }).catch(() => undefined);
  }, []);
  const canPlay = loadedTracks.length > 0;
  const insightNodes = artistInsights?.nodes.filter((node) => node.id !== displayArtist.id) ?? [];
  const insightEdges = artistInsights?.edges ?? [];
  const onlineInfo = artistInsights?.onlineInfo ?? null;
  const onlineBio = onlineInfo?.bio ?? null;
  const onlineSources = onlineInfo?.sourceLabels ?? [];
  const externalLinks = onlineInfo?.externalLinks ?? [];
  const concertInfo = artistInsights?.concerts ?? null;
  const concertSourceLabel = concertInfo?.sources.length
    ? concertInfo.sources.join(' / ')
    : configuredConcertSources.length
      ? configuredConcertSources.join(' / ')
      : 'Provider keys required';
  const concertEmptyMessage = configuredConcertSources.length
    ? (concertInfo?.message ?? `No upcoming concerts matched${configuredConcertRegion ? ` ${configuredConcertRegion}` : ''}.`)
    : concertInfo?.message ?? 'Configure Bandsintown, Ticketmaster, or SeatGeek keys in Settings to load upcoming concerts.';

  if (selectedAlbum) {
    return <AlbumDetailView album={selectedAlbum} onBack={() => setSelectedAlbum(null)} />;
  }

  if (!isVerifyingArtist && !verifiedArtist) {
    return (
      <div className={`artist-detail-page ${isReturning ? 'is-returning' : ''}`}>
        <button className="artist-detail-back" type="button" onClick={returnBack}>
          <ArrowLeft size={17} />
          Artists
        </button>
        <section className="artist-detail-missing">
          <h1>艺术家不存在或已从曲库移除。</h1>
          <p>Return to Artists and refresh the library to see the latest catalog.</p>
        </section>
      </div>
    );
  }

  return (
    <div className={`artist-detail-page ${isReturning ? 'is-returning' : ''}`} ref={detailRootRef}>
      <button className="artist-detail-back" type="button" onClick={returnBack}>
        <ArrowLeft size={17} />
        Artists
      </button>

      <section className="artist-hero" data-has-backdrop={shouldShowHeroImage} aria-label={`${displayArtist.name} artist details`}>
        {shouldShowHeroImage && heroImageUrl ? (
          <img
            className="artist-hero-backdrop"
            alt=""
            decoding="async"
            draggable={false}
            src={heroImageUrl}
            onError={() => setFailedHeroImageUrl(heroImageUrl)}
          />
        ) : null}
        <div className="artist-hero-avatar" data-cover={shouldShowHeroImage} aria-hidden="true">
          {shouldShowHeroImage && heroImageUrl ? (
            <img
              alt=""
              decoding="async"
              draggable={false}
              height={512}
              loading="lazy"
              sizes="240px"
              src={heroImageUrl}
              srcSet={heroAvatarSrcSet}
              width={512}
              onError={() => setFailedHeroImageUrl(heroImageUrl)}
            />
          ) : (
            <span>{artistMark(displayArtist.name)}</span>
          )}
        </div>

        <div className="artist-hero-copy">
          <span className="artist-detail-kicker">Artist</span>
          <h1>{displayArtist.name}</h1>
          <div className="artist-hero-meta" aria-label="Artist metadata">
            <span>{formatCount(displayedTrackCount, 'track')}</span>
            <span>{formatCount(displayArtist.albumCount, 'album')}</span>
            <span>{loadedTracks.length > 0 ? `${loadedTracks.length}/${loadedTrackTotal} loaded` : 'Collected locally'}</span>
          </div>
          <p>{onlineBio ? compactBio(onlineBio.extract) : 'Collected from your local library. Online artist information loads quietly in the background.'}</p>

          <div className="artist-hero-actions">
            <button className="artist-primary-action" type="button" disabled={!canPlay || areTracksLoading} onClick={() => void handlePlayArtist()}>
              <Play size={16} fill="currentColor" />
              {areTracksLoading && !canPlay ? 'Reading Artist' : 'Play Artist'}
            </button>
            <button className="artist-secondary-action" type="button" disabled={!canPlay} onClick={() => void handleShuffleArtist()}>
              <Shuffle size={16} />
              Shuffle
            </button>
            <button className="artist-secondary-action" type="button" disabled={!canPlay} onClick={handleQueueArtist}>
              <ListPlus size={16} />
              Add to Queue
            </button>
            <button className="artist-secondary-action" type="button" disabled={areInsightsLoading} onClick={handleRefreshOnlineInfo}>
              <RefreshCw className={areInsightsLoading ? 'spinning-icon' : undefined} size={16} />
              Refresh Info
            </button>
          </div>

          {onlineSources.length || externalLinks.length ? (
            <div className="artist-online-strip" aria-label="Online artist sources">
              {onlineSources.map((sourceLabel) => (
                <span key={sourceLabel}>{sourceLabel}</span>
              ))}
              {externalLinks.slice(0, 3).map((link) => (
                <a href={link.url} key={link.url} rel="noreferrer" target="_blank">
                  <ExternalLink size={13} />
                  {link.label}
                </a>
              ))}
            </div>
          ) : null}

          {playError || verifyError ? <p className="artist-detail-error">{playError ?? verifyError}</p> : null}
        </div>
      </section>

      <section className="artist-stat-grid" aria-label="Artist overview">
        <div>
          <span>Tracks</span>
          <strong>{formatCount(displayedTrackCount, 'track')}</strong>
        </div>
        <div>
          <span>Albums</span>
          <strong>{formatCount(displayArtist.albumCount, 'album')}</strong>
        </div>
        <div>
          <span>Loaded Queue</span>
          <strong>{loadedTracks.length > 0 ? formatDuration(loadedTracks) : 'Ready soon'}</strong>
        </div>
      </section>

      <section className="artist-section artist-insights-section" aria-label="Artist relationship map">
        <header>
          <div>
            <span>Relationship Map</span>
            <h2>Local network</h2>
          </div>
          <small>{areInsightsLoading ? 'Loading local signals' : `${insightNodes.length} linked artists`}</small>
        </header>
        {insightsError ? <p className="artist-detail-error">{insightsError}</p> : null}
        {insightNodes.length > 0 ? (
          <div className="artist-insight-map">
            <div className="artist-insight-node artist-insight-node-root">
              <strong>{displayArtist.name}</strong>
              <span>{formatCount(displayedTrackCount, 'track')}</span>
            </div>
            <div className="artist-insight-links">
              {insightNodes.map((node) => {
                const edge = insightEdges.find((item) => item.targetArtistId === node.id);
                return (
                  <button className="artist-insight-node" type="button" key={node.id} onClick={() => handleOpenInsightArtist(node.id)}>
                    <strong>{node.name}</strong>
                    <span>{describeRelation(edge)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <p className="artist-detail-empty">
            {areInsightsLoading ? 'Reading artist relationships...' : 'No local 1-hop relationships found yet.'}
          </p>
        )}
      </section>

      <section className="artist-section artist-events-section" aria-label="Artist events">
        <header>
          <div>
            <span>Events</span>
            <h2>Concert information</h2>
          </div>
          <small>{concertSourceLabel}</small>
        </header>
        {concertInfo?.events.length ? (
          <div className="artist-event-list">
            {concertInfo.events.map((event) => (
              <a className="artist-event-row" href={event.ticketUrl ?? event.url ?? undefined} key={event.id} rel="noreferrer" target="_blank">
                <span className="artist-event-date">
                  <CalendarDays size={14} />
                  <time dateTime={event.startsAt}>{formatEventDate(event.startsAt)}</time>
                </span>
                <strong>{event.title}</strong>
                <span className="artist-event-location">
                  <MapPin size={14} />
                  {eventLocation(event)}
                </span>
                <span className="artist-event-source">
                  <Ticket size={14} />
                  {event.sourceLabel ?? event.source}
                </span>
              </a>
            ))}
          </div>
        ) : (
          <p className="artist-detail-empty">
            {concertEmptyMessage}
          </p>
        )}
      </section>

      <ArtistAlbumGrid artistId={displayArtist.id} artistName={displayArtist.name} onAlbumSelect={handleSelectAlbum} />

      <ArtistTrackList
        artistId={displayArtist.id}
        artistName={displayArtist.name}
        currentTrackId={currentTrackId}
        onAppendToQueue={handleAppendTrack}
        onLoadedTracksChange={handleLoadedTracksChange}
        onOpenAlbum={handleSelectAlbum}
        onPlayNext={handlePlayTrackNext}
        onPlayTrack={handlePlayTrack}
      />
    </div>
  );
};
