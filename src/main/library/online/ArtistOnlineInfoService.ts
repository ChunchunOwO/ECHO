import type { EchoDatabase } from '../../database/createDatabase';
import type {
  ArtistOnlineInfo,
  ArtistOnlineInfoBio,
  ArtistOnlineInfoExternalLink,
  ArtistOnlineRelation,
  LibraryArtist,
} from '../../../shared/types/library';
import type { AppLocale } from '../../../shared/types/appSettings';
import { fetchWithNetworkProxy } from '../../network/networkFetch';

type DbRow = Record<string, unknown>;

type FetchLike = (url: string, init?: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

type OnlinePayload = {
  bio: ArtistOnlineInfoBio | null;
  imageCredits: string[];
  externalLinks: ArtistOnlineInfoExternalLink[];
  relatedArtists: ArtistOnlineRelation[];
  sourceLabels: string[];
  errors: string[];
};

type CachedArtistOnlineInfo = ArtistOnlineInfo & {
  cacheVersion: number;
};

class AsyncLimiter {
  private activeCount = 0;
  private lastStartedAt = 0;
  private readonly pending: Array<() => void> = [];

  constructor(
    private readonly concurrency: number,
    private readonly minIntervalMs = 0,
  ) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.activeCount -= 1;
      this.pending.shift()?.();
    }
  }

  private async acquire(): Promise<void> {
    if (this.activeCount >= this.concurrency) {
      await new Promise<void>((resolve) => this.pending.push(resolve));
    }

    const waitMs = Math.max(0, this.minIntervalMs - (Date.now() - this.lastStartedAt));
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    this.activeCount += 1;
    this.lastStartedAt = Date.now();
  }
}

const wikipediaLimiter = new AsyncLimiter(2);
const musicBrainzLimiter = new AsyncLimiter(1, 1050);
const successTtlMs = 30 * 24 * 60 * 60 * 1000;
const shortTtlMs = 60 * 60 * 1000;
const maxRelatedArtists = 8;
const maxExternalLinks = 8;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

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

const normalizeText = (value: string | null | undefined): string =>
  (value ?? '')
    .normalize('NFKD')
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim();

const wikipediaLanguageForLocale = (locale: AppLocale | undefined): 'zh' | 'ja' | 'en' => {
  if (locale === 'ja-JP') {
    return 'ja';
  }
  if (locale === 'en-US') {
    return 'en';
  }
  return 'zh';
};

const cacheKeyFor = (artistId: string, artistName: string, language: string, region: string | null): string =>
  `${artistId}:${language}:${normalizeText(region)}:${normalizeText(artistName)}`;

const levenshtein = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  if (!left) {
    return right.length;
  }
  if (!right) {
    return left.length;
  }

  const costs = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let previous = costs[0];
    costs[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const current = costs[j];
      costs[j] = left[i - 1] === right[j - 1] ? previous : Math.min(previous, costs[j - 1], current) + 1;
      previous = current;
    }
  }
  return costs[right.length];
};

const similarity = (left: string | null | undefined, right: string | null | undefined): number => {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b) {
    return 0;
  }
  const maxLength = Math.max(a.length, b.length);
  return maxLength === 0 ? 0 : Math.max(0, 1 - levenshtein(a, b) / maxLength);
};

const uniqueByUrl = (links: ArtistOnlineInfoExternalLink[]): ArtistOnlineInfoExternalLink[] => {
  const seen = new Set<string>();
  const result: ArtistOnlineInfoExternalLink[] = [];
  for (const link of links) {
    const key = link.url.trim().toLocaleLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(link);
  }
  return result.slice(0, maxExternalLinks);
};

const fetchJson = async (url: string, fetcher: FetchLike, headers: Record<string, string>, timeoutMs = 7000): Promise<unknown> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...headers,
      },
    });
    if (!response.ok) {
      throw new Error(`request_failed:${response.status}`);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
};

const defaultHeaders = {
  'Api-User-Agent': 'ECHO-Next/26.5.20 (https://github.com/moekotori/echo)',
  'User-Agent': 'ECHO-Next/26.5.20 (https://github.com/moekotori/echo)',
};

const statusFrom = (value: unknown): ArtistOnlineInfo['status'] => {
  if (value === 'ready' || value === 'partial' || value === 'empty' || value === 'unavailable') {
    return value;
  }
  return 'empty';
};

export const emptyArtistOnlineInfo = (message?: string): ArtistOnlineInfo => ({
  status: 'empty',
  bio: null,
  imageCredits: [],
  externalLinks: [],
  relatedArtists: [],
  sourceLabels: [],
  fetchedAt: null,
  expiresAt: null,
  fromCache: false,
  errors: [],
  message,
});

export class ArtistOnlineInfoService {
  constructor(
    private readonly database: EchoDatabase,
    private readonly fetcher: FetchLike = fetchWithNetworkProxy as FetchLike,
  ) {}

  async getArtistOnlineInfo(
    artist: LibraryArtist,
    options: { force?: boolean; locale?: AppLocale; region?: string | null; now?: Date } = {},
  ): Promise<ArtistOnlineInfo> {
    const artistName = artist.name.trim();
    if (!artistName) {
      return emptyArtistOnlineInfo('Artist name is empty.');
    }

    const language = wikipediaLanguageForLocale(options.locale);
    const region = options.region?.trim() || null;
    const normalizedName = normalizeText(artistName);
    const cacheKey = cacheKeyFor(artist.id, artistName, language, region);
    const now = options.now ?? new Date();

    if (options.force !== true) {
      const cached = this.readCache(cacheKey);
      if (cached && Date.parse(cached.expiresAt ?? '') > now.getTime()) {
        return cached;
      }
    }

    const payload = await this.fetchOnlineInfo(artistName, language);
    const hasData = Boolean(payload.bio) || payload.externalLinks.length > 0 || payload.relatedArtists.length > 0;
    const status: ArtistOnlineInfo['status'] = hasData
      ? payload.errors.length > 0
        ? 'partial'
        : 'ready'
      : payload.errors.length > 0
        ? 'unavailable'
        : 'empty';
    const fetchedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + (hasData ? successTtlMs : shortTtlMs)).toISOString();
    const info: ArtistOnlineInfo = {
      status,
      bio: payload.bio,
      imageCredits: payload.imageCredits,
      externalLinks: uniqueByUrl(payload.externalLinks),
      relatedArtists: payload.relatedArtists.slice(0, maxRelatedArtists),
      sourceLabels: [...new Set(payload.sourceLabels)],
      fetchedAt,
      expiresAt,
      fromCache: false,
      errors: payload.errors,
      message: hasData ? undefined : 'No online artist information matched this artist yet.',
    };

    this.writeCache(cacheKey, artist.id, normalizedName, language, region, info);
    return info;
  }

  clearCache(): { removedRows: number } {
    const removedRows = Number(this.database.prepare('DELETE FROM artist_online_info_cache').run().changes ?? 0);
    return { removedRows };
  }

  private async fetchOnlineInfo(artistName: string, language: string): Promise<OnlinePayload> {
    const errors: string[] = [];
    const [bio, musicBrainz] = await Promise.all([
      this.fetchWikipediaBio(artistName, language).catch((error: unknown) => {
        errors.push(`Wikipedia: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }),
      this.fetchMusicBrainzArtist(artistName).catch((error: unknown) => {
        errors.push(`MusicBrainz: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }),
    ]);

    const externalLinks: ArtistOnlineInfoExternalLink[] = [];
    const sourceLabels: string[] = [];
    const imageCredits: string[] = [];
    if (bio) {
      sourceLabels.push(`${language}.wikipedia.org`);
      if (bio.url) {
        externalLinks.push({ label: bio.title, url: bio.url, source: 'wikipedia' });
      }
      if (bio.thumbnailUrl) {
        imageCredits.push(`${bio.title} image via ${language}.wikipedia.org`);
      }
    }
    if (musicBrainz) {
      sourceLabels.push('MusicBrainz');
      externalLinks.push(...musicBrainz.externalLinks);
    }

    return {
      bio,
      imageCredits,
      externalLinks,
      relatedArtists: musicBrainz?.relatedArtists ?? [],
      sourceLabels,
      errors,
    };
  }

  private async fetchWikipediaBio(artistName: string, language: string): Promise<ArtistOnlineInfoBio | null> {
    const queries = [
      artistName,
      `${artistName} musician`,
      `${artistName} band`,
      `${artistName} singer`,
    ].filter((value, index, values) => value.trim() && values.indexOf(value) === index);
    let lastError: unknown = null;

    for (const query of queries) {
      try {
        const searchData = asRecord(await wikipediaLimiter.run(() =>
          fetchJson(
            `https://${language}.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=4`,
            this.fetcher,
            defaultHeaders,
          ),
        ));
        const pages = Array.isArray(searchData.pages) ? searchData.pages.map(asRecord) : [];
        const best = pages
          .map((page) => ({
            key: text(page.key),
            title: text(page.title),
            score: Math.max(similarity(artistName, text(page.title)), similarity(query, text(page.title))),
          }))
          .filter((page): page is { key: string; title: string; score: number } => Boolean(page.key && page.title))
          .sort((left, right) => right.score - left.score)[0];

        if (!best || best.score < 0.34) {
          continue;
        }

        const data = asRecord(await wikipediaLimiter.run(() =>
          fetchJson(
            `https://${language}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(best.key)}`,
            this.fetcher,
            defaultHeaders,
          ),
        ));
        const extract = text(data.extract);
        const title = text(data.title);
        if (!extract || !title) {
          continue;
        }
        return {
          title,
          description: text(data.description),
          extract: extract.length > 900 ? `${extract.slice(0, 897).trim()}...` : extract,
          url: text(asRecord(asRecord(data.content_urls).desktop).page),
          language,
          thumbnailUrl: text(asRecord(data.thumbnail).source),
        };
      } catch (error) {
        lastError = error;
        continue;
      }
    }

    if (lastError) {
      throw lastError;
    }
    return null;
  }

  private async fetchMusicBrainzArtist(artistName: string): Promise<{
    externalLinks: ArtistOnlineInfoExternalLink[];
    relatedArtists: ArtistOnlineRelation[];
  } | null> {
    const searchUrl = `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(`artist:"${artistName}"`)}&fmt=json&limit=5`;
    const searchData = asRecord(await musicBrainzLimiter.run(() => fetchJson(searchUrl, this.fetcher, defaultHeaders)));
    const artists = Array.isArray(searchData.artists) ? searchData.artists.map(asRecord) : [];
    const best = artists
      .map((artist) => {
        const name = text(artist.name);
        const id = text(artist.id);
        const disambiguation = text(artist.disambiguation);
        const score = Math.max(similarity(artistName, name), Number(artist.score ?? 0) / 100);
        return id && name ? { id, name, disambiguation, score } : null;
      })
      .filter((artist): artist is { id: string; name: string; disambiguation: string | null; score: number } => Boolean(artist))
      .sort((left, right) => right.score - left.score)[0];

    if (!best || best.score < 0.45) {
      return null;
    }

    const lookupUrl = `https://musicbrainz.org/ws/2/artist/${encodeURIComponent(best.id)}?fmt=json&inc=artist-rels+url-rels+tags`;
    const lookup = asRecord(await musicBrainzLimiter.run(() => fetchJson(lookupUrl, this.fetcher, defaultHeaders)));
    const externalLinks: ArtistOnlineInfoExternalLink[] = [
      {
        label: 'MusicBrainz',
        url: `https://musicbrainz.org/artist/${best.id}`,
        source: 'musicbrainz',
      },
    ];
    const relatedArtists: ArtistOnlineRelation[] = [];
    const relations = Array.isArray(lookup.relations) ? lookup.relations.map(asRecord) : [];

    for (const relation of relations) {
      const type = text(relation.type);
      const url = asRecord(relation.url);
      const resource = text(url.resource);
      if (resource) {
        const source = resource.includes('wikidata.org')
          ? 'wikidata'
          : resource.includes('musicbrainz.org')
            ? 'musicbrainz'
            : 'other';
        externalLinks.push({
          label: type ? type.replace(/_/g, ' ') : 'External link',
          url: resource,
          source,
        });
      }

      const relatedArtist = asRecord(relation.artist);
      const relatedName = text(relatedArtist.name);
      const relatedId = text(relatedArtist.id);
      if (relatedName && normalizeText(relatedName) !== normalizeText(best.name)) {
        relatedArtists.push({
          name: relatedName,
          type,
          url: relatedId ? `https://musicbrainz.org/artist/${relatedId}` : null,
          source: 'musicbrainz',
        });
      }
    }

    return {
      externalLinks: uniqueByUrl(externalLinks),
      relatedArtists: relatedArtists.slice(0, maxRelatedArtists),
    };
  }

  private readCache(cacheKey: string): CachedArtistOnlineInfo | null {
    const row = this.database.prepare<[string], DbRow>('SELECT * FROM artist_online_info_cache WHERE cache_key = ?').get(cacheKey);
    if (!row) {
      return null;
    }
    return {
      status: statusFrom(row.status),
      bio: parseJson<ArtistOnlineInfoBio | null>(row.bio_json, null),
      imageCredits: parseJson<string[]>(row.image_credits_json, []),
      externalLinks: parseJson<ArtistOnlineInfoExternalLink[]>(row.external_links_json, []),
      relatedArtists: parseJson<ArtistOnlineRelation[]>(row.related_artists_json, []),
      sourceLabels: parseJson<string[]>(row.source_labels_json, []),
      fetchedAt: text(row.fetched_at),
      expiresAt: text(row.expires_at),
      fromCache: true,
      errors: parseJson<string[]>(row.provider_errors_json, []),
      cacheVersion: 1,
    };
  }

  private writeCache(cacheKey: string, artistId: string, normalizedName: string, locale: string, region: string | null, info: ArtistOnlineInfo): void {
    this.database
      .prepare(
        `INSERT INTO artist_online_info_cache (
          cache_key, artist_id, normalized_name, locale, region, bio_json, image_credits_json, external_links_json,
          related_artists_json, source_labels_json, provider_errors_json, status, fetched_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET
          artist_id = excluded.artist_id,
          normalized_name = excluded.normalized_name,
          locale = excluded.locale,
          region = excluded.region,
          bio_json = excluded.bio_json,
          image_credits_json = excluded.image_credits_json,
          external_links_json = excluded.external_links_json,
          related_artists_json = excluded.related_artists_json,
          source_labels_json = excluded.source_labels_json,
          provider_errors_json = excluded.provider_errors_json,
          status = excluded.status,
          fetched_at = excluded.fetched_at,
          expires_at = excluded.expires_at`,
      )
      .run(
        cacheKey,
        artistId,
        normalizedName,
        locale,
        region,
        info.bio ? JSON.stringify(info.bio) : null,
        JSON.stringify(info.imageCredits),
        JSON.stringify(info.externalLinks),
        JSON.stringify(info.relatedArtists ?? []),
        JSON.stringify(info.sourceLabels),
        JSON.stringify(info.errors ?? []),
        info.status,
        info.fetchedAt ?? new Date().toISOString(),
        info.expiresAt ?? new Date(Date.now() + shortTtlMs).toISOString(),
      );
  }
}
