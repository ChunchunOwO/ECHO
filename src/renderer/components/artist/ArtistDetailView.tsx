import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CalendarDays, ChevronDown, ExternalLink, ListPlus, MapPin, Play, RefreshCw, Shuffle, Ticket } from 'lucide-react';
import type { AppSettings } from '../../../shared/types/appSettings';
import type { ArtistInsights, LibraryAlbum, LibraryArtist, LibraryTrack } from '../../../shared/types/library';
import { useAnimatedBackNavigation } from '../../hooks/useAnimatedBackNavigation';
import { useI18n } from '../../i18n/I18nProvider';
import { usePlaybackQueue } from '../../stores/PlaybackQueueProvider';
import { AlbumDetailView } from '../album/AlbumDetailView';
import { readPageScrollTop, writePageScrollTop } from '../ui/InfiniteScrollSentinel';
import { ArtistAlbumGrid } from './ArtistAlbumGrid';
import { ArtistTrackList } from './ArtistTrackList';
import { artistMark } from './artistVisual';

type ArtistDetailViewProps = {
  artist: LibraryArtist;
  onBack: () => void;
};

type Translate = ReturnType<typeof useI18n>['t'];

const formatDuration = (tracks: LibraryTrack[], t: Translate): string => {
  const totalSeconds = tracks.reduce((total, track) => total + (Number.isFinite(track.duration) ? track.duration : 0), 0);

  if (totalSeconds <= 0) {
    return t('artistDetail.duration.reading');
  }

  const minutes = Math.round(totalSeconds / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? t('artistDetail.duration.hours', { hours, minutes: rest }) : t('artistDetail.duration.minutes', { minutes });
};

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

const maxOverviewBioLength = 900;

const overviewBioParagraphs = (value: string): string[] => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  const limited = normalized.length > maxOverviewBioLength ? `${normalized.slice(0, maxOverviewBioLength - 3).trim()}...` : normalized;
  if (!limited) {
    return [];
  }

  const sentences = limited.match(/[^。！？.!?]+[。！？.!?]?/gu)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [limited];
  const paragraphs: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    const next = current ? `${current}${sentence}` : sentence;
    if (current && next.length > 280) {
      paragraphs.push(current);
      current = sentence;
    } else {
      current = next;
    }
  }

  if (current) {
    paragraphs.push(current);
  }

  return paragraphs.slice(0, 4);
};

const aroundWebHost = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./iu, '');
  } catch {
    return url;
  }
};

const aroundWebLabel = (label: string, url: string): string => {
  const host = aroundWebHost(url);
  const lower = `${label} ${host}`.toLocaleLowerCase();
  if (lower.includes('youtube')) {
    return 'YouTube';
  }
  if (lower.includes('instagram')) {
    return 'Instagram';
  }
  if (lower.includes('twitter') || lower.includes('x.com')) {
    return 'X';
  }
  if (lower.includes('spotify')) {
    return 'Spotify';
  }
  if (lower.includes('facebook')) {
    return 'Facebook';
  }
  if (lower.includes('official') || lower.includes('homepage') || lower.includes('site')) {
    return 'Official';
  }
  return label || host;
};

const isAroundWebLink = (label: string, url: string): boolean => {
  const value = `${label} ${url}`.toLocaleLowerCase();
  return /official|homepage|site|youtube|instagram|twitter|x\.com|spotify|facebook|tiktok|soundcloud|linkfire|bandcamp/u.test(value);
};

const formatEventDate = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

const eventLocation = (event: ArtistInsights['concerts']['events'][number], t: Translate): string =>
  [event.venueName, event.city, event.region, event.country].filter(Boolean).join(' / ') || t('artistDetail.events.venuePending');

export const ArtistDetailView = ({ artist, onBack }: ArtistDetailViewProps): JSX.Element => {
  const { t } = useI18n();
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
  const [onlineRefreshRequest, setOnlineRefreshRequest] = useState(0);
  const [configuredConcertSources, setConfiguredConcertSources] = useState<string[]>([]);
  const [configuredConcertRegion, setConfiguredConcertRegion] = useState<string | null>(null);
  const [areConcertsExpanded, setAreConcertsExpanded] = useState(false);
  const [selectedAlbum, setSelectedAlbum] = useState<LibraryAlbum | null>(null);
  const [failedHeroImageUrl, setFailedHeroImageUrl] = useState<string | null>(null);
  const detailRootRef = useRef<HTMLDivElement | null>(null);
  const detailScrollTopRef = useRef(0);
  const shouldRestoreDetailScrollRef = useRef(false);
  const source = useMemo(() => ({ type: 'artist' as const, label: artist.name, artistId: artist.id }), [artist.id, artist.name]);
  const displayArtist = verifiedArtist ?? artist;
  const displayedTrackCount = Math.max(displayArtist.trackCount, loadedTrackTotal);
  const heroImageUrl = displayArtist.avatarUrl ?? (displayArtist.coverId ? `echo-cover://original/${encodeURIComponent(displayArtist.coverId)}` : null);
  const shouldShowHeroImage = Boolean(heroImageUrl && failedHeroImageUrl !== heroImageUrl);

  useEffect(() => {
    setVerifiedArtist(artist);
    setFailedHeroImageUrl(null);
  }, [artist]);

  useEffect(() => {
    let isCancelled = false;

    const verifyArtist = async (): Promise<void> => {
      const library = window.echo?.library;

      if (!library?.getArtist) {
        setVerifyError(t('artistDetail.error.desktopBridgeRead'));
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
  }, [artist.id, t]);

  useEffect(() => {
    setSelectedAlbum(null);
    setFailedHeroImageUrl(null);
    setAreConcertsExpanded(false);
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
        return;
      }

      setAreInsightsLoading(true);

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
  const canPlay = loadedTracks.length > 0;
  const onlineInfo = artistInsights?.onlineInfo ?? null;
  const onlineBio = onlineInfo?.bio ?? null;
  const onlineSources = onlineInfo?.sourceLabels ?? [];
  const externalLinks = onlineInfo?.externalLinks ?? [];
  const concertInfo = artistInsights?.concerts ?? null;
  const concertEvents = concertInfo?.events ?? [];
  const concertCountLabel = concertEvents.length > 0 ? t('artistDetail.events.count', { count: concertEvents.length }) : null;
  const concertSourceLabel = concertInfo?.sources.length
    ? concertInfo.sources.join(' / ')
    : configuredConcertSources.length
      ? configuredConcertSources.join(' / ')
      : t('artistDetail.events.providerKeysRequired');
  const concertEmptyMessage = configuredConcertSources.length
    ? (concertInfo?.status === 'unavailable' && concertInfo.message
      ? concertInfo.message
      : (configuredConcertRegion ? t('artistDetail.events.noConcertsRegion', { region: configuredConcertRegion }) : t('artistDetail.events.noConcerts')))
    : t('artistDetail.events.configureProviders');
  const overviewBio = onlineBio
    ? overviewBioParagraphs(onlineBio.extract)
    : [t('artistDetail.overview.bioFallback')];
  const overviewFacts = [
    { label: t('artistDetail.fact.tracks'), value: t('artistDetail.meta.tracks', { count: displayedTrackCount }) },
    { label: t('artistDetail.fact.albums'), value: t('artistDetail.meta.albums', { count: displayArtist.albumCount }) },
    { label: t('artistDetail.fact.loaded'), value: loadedTracks.length > 0 ? formatDuration(loadedTracks, t) : t('artistDetail.status.readySoon') },
    { label: t('artistDetail.fact.sources'), value: onlineSources.length ? onlineSources.join(' / ') : t('artistDetail.status.localLibrary') },
  ];
  const aroundWebLinks = externalLinks
    .filter((link) => isAroundWebLink(link.label, link.url))
    .map((link) => ({ ...link, label: aroundWebLabel(link.label, link.url), host: aroundWebHost(link.url) }))
    .slice(0, 8);

  if (selectedAlbum) {
    return <AlbumDetailView album={selectedAlbum} onBack={() => setSelectedAlbum(null)} />;
  }

  if (!isVerifyingArtist && !verifiedArtist) {
    return (
      <div className={`artist-detail-page ${isReturning ? 'is-returning' : ''}`}>
        <button className="artist-detail-back" type="button" onClick={returnBack}>
          <ArrowLeft size={17} />
          {t('artistDetail.action.back')}
        </button>
        <section className="artist-detail-missing">
          <h1>{t('artistDetail.missing.title')}</h1>
          <p>{t('artistDetail.missing.description')}</p>
        </section>
      </div>
    );
  }

  return (
    <div className={`artist-detail-page ${isReturning ? 'is-returning' : ''}`} ref={detailRootRef}>
      <button className="artist-detail-back" type="button" onClick={returnBack}>
        <ArrowLeft size={17} />
        {t('artistDetail.action.back')}
      </button>

      <section className="artist-hero" data-has-backdrop={shouldShowHeroImage} aria-label={t('artistDetail.aria.details', { artist: displayArtist.name })}>
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
        {!shouldShowHeroImage ? (
          <div className="artist-hero-art" aria-hidden="true">
            <span>{artistMark(displayArtist.name)}</span>
          </div>
        ) : null}

        <div className="artist-hero-copy">
          <span className="artist-detail-kicker">{t('artistDetail.label.artist')}</span>
          <h1>{displayArtist.name}</h1>
          <div className="artist-hero-meta" aria-label={t('artistDetail.aria.metadata')}>
            <span>{t('artistDetail.meta.tracks', { count: displayedTrackCount })}</span>
            <span>{t('artistDetail.meta.albums', { count: displayArtist.albumCount })}</span>
            <span>{loadedTracks.length > 0 ? t('artistDetail.meta.loadedTracks', { loaded: loadedTracks.length, total: loadedTrackTotal }) : t('artistDetail.status.collectedLocally')}</span>
          </div>
          <div className="artist-hero-actions">
            <button className="artist-primary-action" type="button" disabled={!canPlay || areTracksLoading} onClick={() => void handlePlayArtist()}>
              <Play size={16} fill="currentColor" />
              {areTracksLoading && !canPlay ? t('artistDetail.action.readingArtist') : t('artistDetail.action.playArtist')}
            </button>
            <button className="artist-secondary-action" type="button" disabled={!canPlay} onClick={() => void handleShuffleArtist()}>
              <Shuffle size={16} />
              {t('artistDetail.action.shuffle')}
            </button>
            <button className="artist-secondary-action" type="button" disabled={!canPlay} onClick={handleQueueArtist}>
              <ListPlus size={16} />
              {t('artistDetail.action.addToQueue')}
            </button>
            <button className="artist-secondary-action" type="button" disabled={areInsightsLoading} onClick={handleRefreshOnlineInfo}>
              <RefreshCw className={areInsightsLoading ? 'spinning-icon' : undefined} size={16} />
              {t('artistDetail.action.refreshInfo')}
            </button>
          </div>

          {onlineSources.length || externalLinks.length ? (
            <div className="artist-online-strip" aria-label={t('artistDetail.aria.onlineSources')}>
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

      <nav className="artist-detail-tabs" aria-label={t('artistDetail.aria.sections', { artist: displayArtist.name })}>
        <a aria-current="page" href="#artist-overview">{t('artistDetail.tab.overview')}</a>
        <a href="#artist-albums">{t('artistDetail.tab.albums')}</a>
        <a href="#artist-songs">{t('artistDetail.tab.songs')}</a>
      </nav>

      <section className="artist-overview-grid" id="artist-overview" aria-label={t('artistDetail.aria.overview')}>
        <article className="artist-overview-copy">
          <span>{t('artistDetail.label.overview')}</span>
          <h2>{t('artistDetail.overview.about', { artist: displayArtist.name })}</h2>
          {overviewBio.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </article>
        <aside className="artist-overview-sidebar" aria-label={t('artistDetail.aria.facts')}>
          <div className="artist-sidebar-facts">
            {overviewFacts.map((fact) => (
              <div key={fact.label}>
                <span>{fact.label}</span>
                <strong>{fact.value}</strong>
              </div>
            ))}
          </div>
          {aroundWebLinks.length > 0 ? (
            <section className="artist-around-web" aria-label={t('artistDetail.aroundWeb.aria')}>
              <span>{t('artistDetail.aroundWeb.heading')}</span>
              <div>
                {aroundWebLinks.map((link) => (
                  <a href={link.url} key={link.url} rel="noreferrer" target="_blank" title={`${link.label} / ${link.host}`}>
                    <ExternalLink size={14} />
                    {link.label}
                  </a>
                ))}
              </div>
            </section>
          ) : null}
        </aside>
      </section>

      <section className="artist-section artist-events-section" aria-label={t('artistDetail.aria.events')}>
        <header>
          <div>
            <span>{t('artistDetail.section.events')}</span>
            <h2>{t('artistDetail.section.concertInfo')}</h2>
          </div>
          <div className="artist-events-header-actions">
            <small>{concertCountLabel ? `${concertCountLabel} / ${concertSourceLabel}` : concertSourceLabel}</small>
            {concertEvents.length > 0 ? (
              <button
                className="artist-events-toggle"
                type="button"
                aria-expanded={areConcertsExpanded}
                onClick={() => setAreConcertsExpanded((current) => !current)}
              >
                <ChevronDown size={15} />
                {areConcertsExpanded ? t('artistDetail.events.collapse') : t('artistDetail.events.expand')}
              </button>
            ) : null}
          </div>
        </header>
        {concertEvents.length > 0 && !areConcertsExpanded ? (
          <p className="artist-detail-empty artist-events-collapsed">
            {t('artistDetail.events.collapsedHint', { count: concertEvents.length })}
          </p>
        ) : null}
        {concertEvents.length > 0 && areConcertsExpanded ? (
          <div className="artist-event-list">
            {concertEvents.map((event) => (
              <a className="artist-event-row" href={event.ticketUrl ?? event.url ?? undefined} key={event.id} rel="noreferrer" target="_blank">
                <span className="artist-event-cover" data-empty={!event.imageUrl}>
                  {event.imageUrl ? <img alt="" loading="lazy" decoding="async" draggable={false} src={event.imageUrl} /> : <Ticket size={22} />}
                </span>
                <span className="artist-event-date">
                  <CalendarDays size={14} />
                  <time dateTime={event.startsAt}>{formatEventDate(event.startsAt)}</time>
                </span>
                <strong>{event.title}</strong>
                <span className="artist-event-location">
                  <MapPin size={14} />
                  {eventLocation(event, t)}
                </span>
                <span className="artist-event-source">
                  <Ticket size={14} />
                  {event.sourceLabel ?? event.source}
                </span>
              </a>
            ))}
          </div>
        ) : null}
        {concertEvents.length === 0 ? (
          <p className="artist-detail-empty">
            {concertEmptyMessage}
          </p>
        ) : null}
      </section>

      <div className="artist-anchor" id="artist-albums">
        <ArtistAlbumGrid artistId={displayArtist.id} artistName={displayArtist.name} onAlbumSelect={handleSelectAlbum} />
      </div>

      <div className="artist-anchor" id="artist-songs">
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
    </div>
  );
};
