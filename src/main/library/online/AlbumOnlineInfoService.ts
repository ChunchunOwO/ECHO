import type { EchoDatabase } from '../../database/createDatabase';
import type {
  AlbumCreditGroup,
  AlbumCreditPerson,
  AlbumInformationSummary,
  AlbumOnlineInfo,
  AlbumOnlineInfoMatch,
  AlbumOnlineInfoSource,
  LibraryAlbumDetail,
  LibraryTrack,
} from '../../../shared/types/library';
import type { AppLocale } from '../../../shared/types/appSettings';

type DbRow = Record<string, unknown>;

type AlbumSnapshot = {
  album: LibraryAlbumDetail;
  tracks: LibraryTrack[];
};

type OnlinePayload = {
  credits: AlbumCreditGroup[];
  information: AlbumInformationSummary | null;
  match: AlbumOnlineInfoMatch | null;
  sources: AlbumOnlineInfoSource[];
  errors: string[];
};

type MusicBrainzReleaseSearchResult = {
  id: string;
  title: string;
  artist: string;
  artistId: string | null;
  date: string | null;
  trackCount: number | null;
  score: number;
};

type MusicBrainzReleasePayload = {
  release: Record<string, unknown>;
  search: MusicBrainzReleaseSearchResult;
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

const musicBrainzLimiter = new AsyncLimiter(1, 1050);
const wikipediaLimiter = new AsyncLimiter(2);

const successTtlMs = 30 * 24 * 60 * 60 * 1000;
const shortTtlMs = 60 * 60 * 1000;
const maxCreditGroups = 12;
const maxPeoplePerGroup = 12;

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
const yearFromDate = (value: string | null): number | null => {
  const year = value?.slice(0, 4);
  return year && /^\d{4}$/u.test(year) ? Number(year) : null;
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

const cacheKeyFor = (albumId: string, title: string, artist: string, language: string): string =>
  `${albumId}:${language}:${normalizeText(title)}:${normalizeText(artist)}`;

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

const fetchJson = async (url: string, headers: Record<string, string>, timeoutMs = 7000): Promise<unknown> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...headers,
      },
    });
    if (!response.ok) {
      throw new Error(`request_failed:${response.status}`);
    }
    return response.json() as Promise<unknown>;
  } finally {
    clearTimeout(timer);
  }
};

const musicBrainzJson = (url: string): Promise<unknown> =>
  musicBrainzLimiter.run(() =>
    fetchJson(url, {
      'User-Agent': 'ECHO-Next/26.5.19 (https://github.com/moekotori/echo)',
    }),
  );

const wikipediaJson = (language: string, title: string): Promise<unknown> =>
  wikipediaLimiter.run(() =>
    fetchJson(`https://${language}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, {
      'Api-User-Agent': 'ECHO-Next/26.5.19 (https://github.com/moekotori/echo)',
      'User-Agent': 'ECHO-Next/26.5.19 (https://github.com/moekotori/echo)',
    }),
  );

const wikipediaSearchJson = (language: string, query: string): Promise<unknown> =>
  wikipediaLimiter.run(() =>
    fetchJson(`https://${language}.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=3`, {
      'Api-User-Agent': 'ECHO-Next/26.5.19 (https://github.com/moekotori/echo)',
      'User-Agent': 'ECHO-Next/26.5.19 (https://github.com/moekotori/echo)',
    }),
  );

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

const pickArtistCredit = (value: unknown): { name: string | null; id: string | null } => {
  const credits = Array.isArray(value) ? value.map(asRecord) : [];
  const first = credits[0] ?? {};
  const artist = asRecord(first.artist);
  return {
    name: text(artist.name) ?? text(first.name),
    id: text(artist.id),
  };
};

const roleForRelation = (type: string | null, attributes: string[]): string => {
  const haystack = [type ?? '', ...attributes].join(' ').toLocaleLowerCase();
  if (/(vocal|voice|singer|performer|instrument|guitar|bass|drum|piano|keyboard|violin|cello|sax|trumpet)/u.test(haystack)) {
    return haystack.includes('vocal') || haystack.includes('voice') || haystack.includes('singer') ? 'Vocal' : 'Performer';
  }
  if (/(composer|writer|music)/u.test(haystack)) {
    return 'Composer';
  }
  if (/(lyric|libretto|words)/u.test(haystack)) {
    return 'Lyrics';
  }
  if (/(arrang|orchestrat)/u.test(haystack)) {
    return 'Arrangement';
  }
  if (/(producer|production|executive)/u.test(haystack)) {
    return 'Production';
  }
  if (/(mix|master|engineer|recording|sound)/u.test(haystack)) {
    return 'Engineering';
  }
  if (/(label|phonographic|copyright)/u.test(haystack)) {
    return 'Label';
  }
  return 'Other';
};

const addCredit = (groups: Map<string, AlbumCreditPerson[]>, role: string, person: AlbumCreditPerson): void => {
  const people = groups.get(role) ?? [];
  const key = `${person.name}::${person.detail ?? ''}::${person.trackTitle ?? ''}::${person.source}`;
  if (!people.some((item) => `${item.name}::${item.detail ?? ''}::${item.trackTitle ?? ''}::${item.source}` === key)) {
    people.push(person);
  }
  groups.set(role, people);
};

const groupsFromMap = (groups: Map<string, AlbumCreditPerson[]>): AlbumCreditGroup[] => {
  const order = ['Vocal', 'Performer', 'Composer', 'Lyrics', 'Arrangement', 'Production', 'Engineering', 'Label', 'Other'];
  return [...groups.entries()]
    .sort(([left], [right]) => order.indexOf(left) - order.indexOf(right))
    .slice(0, maxCreditGroups)
    .map(([role, people]) => ({ role, people: people.slice(0, maxPeoplePerGroup) }));
};

export class AlbumOnlineInfoService {
  constructor(private readonly database: EchoDatabase) {}

  async getAlbumOnlineInfo(snapshot: AlbumSnapshot, options: { force?: boolean; locale?: AppLocale } = {}): Promise<AlbumOnlineInfo> {
    const normalizedTitle = normalizeText(snapshot.album.title);
    const normalizedArtist = normalizeText(snapshot.album.albumArtist);
    const language = wikipediaLanguageForLocale(options.locale);
    const cacheKey = cacheKeyFor(snapshot.album.id, snapshot.album.title, snapshot.album.albumArtist, language);
    const now = new Date();

    if (options.force !== true) {
      const cached = this.readCache(cacheKey, snapshot.album.id);
      if (cached && Date.parse(cached.expiresAt ?? '') > now.getTime()) {
        return cached;
      }
    }

    const payload = await this.fetchOnlineInfo(snapshot, language);
    const hasData =
      payload.credits.length > 0 ||
      Boolean(payload.information);
    const status = hasData ? (payload.errors.length > 0 ? 'partial' : 'ready') : payload.errors.length > 0 ? 'error' : 'empty';
    const fetchedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + (hasData ? successTtlMs : shortTtlMs)).toISOString();
    const info: AlbumOnlineInfo = {
      albumId: snapshot.album.id,
      status,
      sources: payload.sources,
      match: payload.match,
      credits: payload.credits,
      information: payload.information,
      fetchedAt,
      expiresAt,
      fromCache: false,
      errors: payload.errors,
    };

    this.writeCache(cacheKey, snapshot.album.id, normalizedTitle, normalizedArtist, info);
    return info;
  }

  private async fetchOnlineInfo(snapshot: AlbumSnapshot, language: string): Promise<OnlinePayload> {
    const errors: string[] = [];
    let musicBrainz: MusicBrainzReleasePayload | null = null;

    try {
      musicBrainz = await this.fetchMusicBrainzRelease(snapshot);
    } catch (error) {
      errors.push(`MusicBrainz: ${error instanceof Error ? error.message : String(error)}`);
    }

    const information = await this.fetchWikipediaInformation(snapshot, language).catch((error: unknown) => {
      errors.push(`Wikipedia: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });

    const credits = musicBrainz ? this.extractCredits(musicBrainz.release) : [];
    const match = musicBrainz ? this.toMatch(musicBrainz.search) : null;
    const sources: AlbumOnlineInfoSource[] = [];
    if (musicBrainz) {
      sources.push({ provider: 'musicbrainz', label: 'MusicBrainz' });
    }
    if (information) {
      sources.push({ provider: 'wikipedia', label: `${language}.wikipedia.org` });
    }

    return {
      credits,
      information,
      match,
      sources,
      errors,
    };
  }

  private async fetchMusicBrainzRelease(snapshot: AlbumSnapshot): Promise<MusicBrainzReleasePayload | null> {
    const queryParts = [`release:"${snapshot.album.title}"`];
    if (snapshot.album.albumArtist && snapshot.album.albumArtist !== 'Unknown Artist') {
      queryParts.push(`artist:"${snapshot.album.albumArtist}"`);
    }
    const searchUrl = `https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(queryParts.join(' AND '))}&fmt=json&limit=5`;
    const searchData = asRecord(await musicBrainzJson(searchUrl));
    const releases = Array.isArray(searchData.releases) ? searchData.releases.map(asRecord) : [];
    const scored = releases
      .map((release) => this.scoreMusicBrainzRelease(release, snapshot))
      .filter((release): release is MusicBrainzReleaseSearchResult => Boolean(release))
      .sort((left, right) => right.score - left.score);
    const best = scored[0] ?? null;
    if (!best || best.score < 0.45) {
      return null;
    }

    const lookupUrl =
      `https://musicbrainz.org/ws/2/release/${encodeURIComponent(best.id)}` +
      '?fmt=json&inc=recordings+artist-credits+labels+artist-rels+recording-rels+work-rels+release-groups';
    const release = asRecord(await musicBrainzJson(lookupUrl));
    return { release, search: best };
  }

  private scoreMusicBrainzRelease(release: Record<string, unknown>, snapshot: AlbumSnapshot): MusicBrainzReleaseSearchResult | null {
    const id = text(release.id);
    const title = text(release.title);
    if (!id || !title) {
      return null;
    }

    const artist = pickArtistCredit(release['artist-credit']);
    const media = Array.isArray(release.media) ? release.media.map(asRecord) : [];
    const mediumTrackCount = media.reduce((sum, item) => sum + Math.max(0, Number(item['track-count'] ?? 0)), 0);
    const year = yearFromDate(text(release.date));
    let score = similarity(snapshot.album.title, title) * 0.45 + similarity(snapshot.album.albumArtist, artist.name) * 0.3;
    if (year && snapshot.album.year && year === snapshot.album.year) {
      score += 0.1;
    }
    if (mediumTrackCount > 0 && snapshot.album.trackCount > 0) {
      score += Math.max(0, 1 - Math.abs(mediumTrackCount - snapshot.album.trackCount) / Math.max(mediumTrackCount, snapshot.album.trackCount)) * 0.15;
    }

    return {
      id,
      title,
      artist: artist.name ?? snapshot.album.albumArtist,
      artistId: artist.id,
      date: text(release.date),
      trackCount: mediumTrackCount || null,
      score: Math.min(1, score),
    };
  }

  private extractCredits(release: Record<string, unknown>): AlbumCreditGroup[] {
    const groups = new Map<string, AlbumCreditPerson[]>();
    const labels = Array.isArray(release['label-info']) ? release['label-info'].map(asRecord) : [];
    for (const labelInfo of labels) {
      const label = asRecord(labelInfo.label);
      const name = text(label.name);
      if (name) {
        addCredit(groups, 'Label', { name, detail: text(labelInfo['catalog-number']), trackTitle: null, source: 'label' });
      }
    }

    this.extractRelations(groups, Array.isArray(release.relations) ? release.relations.map(asRecord) : [], null, 'release');
    const media = Array.isArray(release.media) ? release.media.map(asRecord) : [];
    for (const medium of media) {
      const tracks = Array.isArray(medium.tracks) ? medium.tracks.map(asRecord) : [];
      for (const track of tracks) {
        const title = text(track.title);
        const recording = asRecord(track.recording);
        this.extractRelations(groups, Array.isArray(recording.relations) ? recording.relations.map(asRecord) : [], title, 'recording');
      }
    }

    return groupsFromMap(groups);
  }

  private extractRelations(
    groups: Map<string, AlbumCreditPerson[]>,
    relations: Record<string, unknown>[],
    trackTitle: string | null,
    source: AlbumCreditPerson['source'],
  ): void {
    for (const relation of relations) {
      const artist = asRecord(relation.artist);
      const work = asRecord(relation.work);
      const targetName = text(artist.name) ?? text(work.title);
      if (!targetName) {
        continue;
      }
      const attributes = Array.isArray(relation.attributes) ? relation.attributes.map((value) => String(value)) : [];
      const role = roleForRelation(text(relation.type), attributes);
      addCredit(groups, role, {
        name: targetName,
        detail: attributes.length ? attributes.join(', ') : text(relation.type),
        trackTitle,
        source: text(work.title) ? 'work' : source,
      });
    }
  }

  private async fetchWikipediaInformation(snapshot: AlbumSnapshot, language: string): Promise<AlbumInformationSummary | null> {
    const queries = [
      `${snapshot.album.title} ${snapshot.album.albumArtist}`,
      snapshot.album.title,
    ].filter((value, index, values) => value.trim() && values.indexOf(value) === index);

    for (const query of queries) {
      try {
        const searchData = asRecord(await wikipediaSearchJson(language, query));
        const pages = Array.isArray(searchData.pages) ? searchData.pages.map(asRecord) : [];
        const best = pages
          .map((page) => ({
            key: text(page.key),
            title: text(page.title),
            score: Math.max(similarity(snapshot.album.title, text(page.title)), similarity(query, text(page.title))),
          }))
          .filter((page): page is { key: string; title: string; score: number } => Boolean(page.key && page.title))
          .sort((left, right) => right.score - left.score)[0];
        const pageTitle = best?.key ?? query;
        const data = asRecord(await wikipediaJson(language, pageTitle));
        const extract = text(data.extract);
        const title = text(data.title);
        if (!extract || !title) {
          continue;
        }
        return {
          title,
          description: text(data.description),
          extract: extract.length > 1300 ? `${extract.slice(0, 1297).trim()}...` : extract,
          url: text(asRecord(asRecord(data.content_urls).desktop).page),
          language,
          thumbnailUrl: text(asRecord(data.thumbnail).source),
        };
      } catch {
        continue;
      }
    }

    return null;
  }

  private toMatch(search: MusicBrainzReleaseSearchResult): AlbumOnlineInfoMatch {
    return {
      provider: 'musicbrainz',
      providerItemId: search.id,
      title: search.title,
      artist: search.artist,
      year: yearFromDate(search.date),
      confidence: Number(search.score.toFixed(2)),
      url: `https://musicbrainz.org/release/${search.id}`,
      possible: search.score < 0.72,
    };
  }

  private readCache(cacheKey: string, albumId: string): AlbumOnlineInfo | null {
    const row = this.database.prepare<[string], DbRow>('SELECT * FROM album_online_info_cache WHERE cache_key = ?').get(cacheKey);
    if (!row) {
      return null;
    }
    return {
      albumId,
      status: row.status === 'ready' || row.status === 'partial' || row.status === 'empty' || row.status === 'error' ? row.status : 'empty',
      sources: parseJson<AlbumOnlineInfoSource[]>(row.sources_json, []),
      match: parseJson<AlbumOnlineInfoMatch | null>(row.match_json, null),
      credits: parseJson<AlbumCreditGroup[]>(row.credits_json, []),
      information: parseJson<AlbumInformationSummary | null>(row.information_json, null),
      fetchedAt: text(row.fetched_at),
      expiresAt: text(row.expires_at),
      fromCache: true,
      errors: parseJson<string[]>(row.provider_errors_json, []),
    };
  }

  private writeCache(cacheKey: string, albumId: string, normalizedTitle: string, normalizedArtist: string, info: AlbumOnlineInfo): void {
    const columns = new Set(
      this.database
        .prepare<[], DbRow>('PRAGMA table_info(album_online_info_cache)')
        .all()
        .map((row) => text(row.name))
        .filter((name): name is string => Boolean(name)),
    );
    const hasLegacyRelatedJson = columns.has('related_json');

    if (hasLegacyRelatedJson) {
      this.database
        .prepare(
          `INSERT INTO album_online_info_cache (
            cache_key, album_id, normalized_title, normalized_artist, credits_json, related_json, information_json,
            match_json, sources_json, provider_errors_json, status, fetched_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(cache_key) DO UPDATE SET
            credits_json = excluded.credits_json,
            related_json = excluded.related_json,
            information_json = excluded.information_json,
            match_json = excluded.match_json,
            sources_json = excluded.sources_json,
            provider_errors_json = excluded.provider_errors_json,
            status = excluded.status,
            fetched_at = excluded.fetched_at,
            expires_at = excluded.expires_at`,
        )
        .run(
          cacheKey,
          albumId,
          normalizedTitle,
          normalizedArtist,
          JSON.stringify(info.credits),
          JSON.stringify({}),
          JSON.stringify(info.information),
          JSON.stringify(info.match),
          JSON.stringify(info.sources),
          JSON.stringify(info.errors),
          info.status,
          info.fetchedAt,
          info.expiresAt,
        );
      return;
    }

    this.database
      .prepare(
        `INSERT INTO album_online_info_cache (
          cache_key, album_id, normalized_title, normalized_artist, credits_json, information_json,
          match_json, sources_json, provider_errors_json, status, fetched_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET
          credits_json = excluded.credits_json,
          information_json = excluded.information_json,
          match_json = excluded.match_json,
          sources_json = excluded.sources_json,
          provider_errors_json = excluded.provider_errors_json,
          status = excluded.status,
          fetched_at = excluded.fetched_at,
          expires_at = excluded.expires_at`,
      )
      .run(
        cacheKey,
        albumId,
        normalizedTitle,
        normalizedArtist,
        JSON.stringify(info.credits),
        JSON.stringify(info.information),
        JSON.stringify(info.match),
        JSON.stringify(info.sources),
        JSON.stringify(info.errors),
        info.status,
        info.fetchedAt,
        info.expiresAt,
      );
  }
}
