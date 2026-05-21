import type { ArtistConcertEvent, ArtistConcertInfo } from '../../../shared/types/library';
import type { EchoDatabase } from '../../database/createDatabase';
import { fetchWithNetworkProxy } from '../../network/networkFetch';

type FetchLike = (url: string, init?: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export type BandsintownEventsRequest = {
  artistId?: string | null;
  artistName: string;
  appId: string | null | undefined;
  region?: string | null;
  force?: boolean;
  timeoutMs?: number;
  fetcher?: FetchLike;
  now?: Date;
};

type BandsintownVenue = {
  name?: unknown;
  city?: unknown;
  region?: unknown;
  country?: unknown;
};

type BandsintownEvent = {
  id?: unknown;
  title?: unknown;
  datetime?: unknown;
  timezone?: unknown;
  url?: unknown;
  offers?: unknown;
  venue?: unknown;
};

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const normalizeFilterText = (value: string): string => value.trim().toLocaleLowerCase();
const successTtlMs = 30 * 24 * 60 * 60 * 1000;
const shortTtlMs = 60 * 60 * 1000;

const normalizeCacheText = (value: string | null | undefined): string =>
  (value ?? '')
    .normalize('NFKD')
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim();

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string') {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const cacheKeyFor = (source: ArtistConcertEvent['source'], artistId: string | null | undefined, artistName: string, region: string | null): string =>
  `${source}:${artistId?.trim() || normalizeCacheText(artistName)}:${normalizeCacheText(region)}`;

const matchesRegion = (event: ArtistConcertEvent, region: string | null | undefined): boolean => {
  const filter = normalizeFilterText(region ?? '');
  if (!filter) {
    return true;
  }

  return [event.city, event.region, event.country]
    .filter((part): part is string => Boolean(part))
    .some((part) => normalizeFilterText(part).includes(filter));
};

const buildBandsintownEventsUrl = (artistName: string, appId: string): string => {
  const encodedArtist = encodeURIComponent(artistName.trim());
  const params = new URLSearchParams({
    app_id: appId.trim(),
    date: 'upcoming',
  });
  return `https://rest.bandsintown.com/artists/${encodedArtist}/events?${params.toString()}`;
};

const firstOfferUrl = (value: unknown): string | null => {
  const offers = Array.isArray(value) ? value.map(asRecord) : [];
  for (const offer of offers) {
    const url = text(offer.url);
    if (url) {
      return url;
    }
  }
  return null;
};

const parseBandsintownEvent = (value: unknown): ArtistConcertEvent | null => {
  const event = asRecord(value) as BandsintownEvent;
  const id = text(event.id);
  const startsAt = text(event.datetime);
  if (!id || !startsAt) {
    return null;
  }

  const venue = asRecord(event.venue) as BandsintownVenue;
  const venueName = text(venue.name);
  const city = text(venue.city);
  const region = text(venue.region);
  const country = text(venue.country);
  const fallbackTitle = [venueName, city].filter(Boolean).join(' - ') || 'Bandsintown event';
  const title = text(event.title) ?? fallbackTitle;

  return {
    id: `bandsintown:${id}`,
    source: 'bandsintown',
    sourceLabel: 'Bandsintown',
    title,
    startsAt,
    timezone: text(event.timezone),
    timeTbd: false,
    venueName,
    city,
    region,
    country,
    url: text(event.url),
    ticketUrl: firstOfferUrl(event.offers),
    venueUrl: null,
  };
};

const fetchJsonWithTimeout = async (url: string, fetcher: FetchLike, timeoutMs: number): Promise<unknown> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'ECHO-Next/26.5.19',
      },
    });
    if (!response.ok) {
      throw new Error(`bandsintown_request_failed:${response.status}`);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
};

export class ArtistEventsService {
  constructor(
    private readonly fetcher: FetchLike = fetchWithNetworkProxy as FetchLike,
    private readonly database: EchoDatabase | null = null,
  ) {}

  async getBandsintownEvents(request: BandsintownEventsRequest): Promise<ArtistConcertInfo> {
    const artistName = request.artistName.trim();
    const appId = request.appId?.trim() ?? '';
    const region = request.region?.trim() || null;
    const now = request.now ?? new Date();
    const fetchedAt = now.toISOString();
    const cacheKey = cacheKeyFor('bandsintown', request.artistId, artistName, region);

    if (!artistName || !appId) {
      return {
        status: 'not_configured',
        region,
        sources: [],
        events: [],
        fetchedAt: null,
        message: 'Configure Bandsintown app_id in Settings to load upcoming concerts.',
      };
    }

    if (request.force !== true) {
      const cached = this.readEventCache(cacheKey, now);
      if (cached) {
        return cached;
      }
    }

    try {
      const payload = await fetchJsonWithTimeout(
        buildBandsintownEventsUrl(artistName, appId),
        request.fetcher ?? this.fetcher,
        request.timeoutMs ?? 7000,
      );
      const events = (Array.isArray(payload) ? payload : [])
        .map(parseBandsintownEvent)
        .filter((event): event is ArtistConcertEvent => Boolean(event))
        .filter((event) => matchesRegion(event, region))
        .sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));

      const result: ArtistConcertInfo = {
        status: 'ready',
        region,
        sources: ['bandsintown'],
        events,
        fetchedAt,
        message: events.length ? undefined : 'No upcoming Bandsintown events matched this artist and region.',
      };
      this.writeEventCache(cacheKey, request.artistId ?? null, artistName, region, result, now);
      return result;
    } catch (error) {
      const result: ArtistConcertInfo = {
        status: 'unavailable',
        region,
        sources: ['bandsintown'],
        events: [],
        fetchedAt,
        message: error instanceof Error ? error.message : String(error),
      };
      this.writeEventCache(cacheKey, request.artistId ?? null, artistName, region, result, now);
      return result;
    }
  }

  clearCache(): { removedRows: number } {
    if (!this.database) {
      return { removedRows: 0 };
    }
    const removedRows = Number(this.database.prepare('DELETE FROM artist_event_cache').run().changes ?? 0);
    return { removedRows };
  }

  private readEventCache(cacheKey: string, now: Date): ArtistConcertInfo | null {
    if (!this.database) {
      return null;
    }
    const row = this.database.prepare<[string], Record<string, unknown>>('SELECT * FROM artist_event_cache WHERE cache_key = ?').get(cacheKey);
    if (!row || Date.parse(text(row.expires_at) ?? '') <= now.getTime()) {
      return null;
    }
    const status = row.status === 'ready' || row.status === 'unavailable' ? row.status : 'unavailable';
    return {
      status,
      region: text(row.region),
      sources: parseJson<ArtistConcertInfo['sources']>(row.sources_json, []),
      events: parseJson<ArtistConcertEvent[]>(row.events_json, []),
      fetchedAt: text(row.fetched_at),
      message: text(row.message) ?? undefined,
    };
  }

  private writeEventCache(cacheKey: string, artistId: string | null, artistName: string, region: string | null, info: ArtistConcertInfo, now: Date): void {
    if (!this.database) {
      return;
    }
    const hasData = info.events.length > 0;
    const expiresAt = new Date(now.getTime() + (hasData ? successTtlMs : shortTtlMs)).toISOString();
    this.database
      .prepare(
        `INSERT INTO artist_event_cache (
          cache_key, artist_id, normalized_name, region, source, events_json, sources_json, status, message, fetched_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET
          artist_id = excluded.artist_id,
          normalized_name = excluded.normalized_name,
          region = excluded.region,
          source = excluded.source,
          events_json = excluded.events_json,
          sources_json = excluded.sources_json,
          status = excluded.status,
          message = excluded.message,
          fetched_at = excluded.fetched_at,
          expires_at = excluded.expires_at`,
      )
      .run(
        cacheKey,
        artistId,
        normalizeCacheText(artistName),
        region,
        'bandsintown',
        JSON.stringify(info.events),
        JSON.stringify(info.sources),
        info.status,
        info.message ?? null,
        info.fetchedAt ?? now.toISOString(),
        expiresAt,
      );
  }
}
