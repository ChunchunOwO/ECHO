import { describe, expect, it, vi } from 'vitest';
import type { EchoDatabase } from '../../database/createDatabase';
import type { LibraryAlbumDetail, LibraryTrack } from '../../../shared/types/library';
import { AlbumOnlineInfoService } from './AlbumOnlineInfoService';

const now = '2026-05-19T00:00:00.000Z';

const album = (): LibraryAlbumDetail => ({
  id: 'album-1',
  albumKey: 'album:key',
  title: 'Cache Album',
  albumArtist: 'Cache Artist',
  year: 2026,
  trackCount: 1,
  duration: 180,
  coverId: null,
  coverThumb: null,
  coverLarge: null,
});

const track = (): LibraryTrack => ({
  id: 'track-1',
  path: 'C:/Music/Cache Song.flac',
  title: 'Cache Song',
  artist: 'Cache Artist',
  album: 'Cache Album',
  albumArtist: 'Cache Artist',
  trackNo: 1,
  discNo: null,
  year: 2026,
  genre: null,
  duration: 180,
  codec: 'FLAC',
  sampleRate: 44100,
  bitDepth: 16,
  bitrate: 900000,
  coverId: null,
  coverThumb: null,
  fieldSources: {},
});

describe('AlbumOnlineInfoService', () => {
  it('returns fresh cache without touching network providers', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const row = {
      status: 'ready',
      credits_json: JSON.stringify([{ role: 'Composer', people: [{ name: 'Cached Person', detail: null, trackTitle: null, source: 'release' }] }]),
      information_json: JSON.stringify({
        version: 2,
        album: null,
        artist: {
          title: 'Cached Artist',
          description: 'Artist profile',
          extract: 'Cached artist biography.',
          url: 'https://example.test/artist',
          language: 'en',
          thumbnailUrl: null,
        },
      }),
      match_json: JSON.stringify(null),
      sources_json: JSON.stringify([{ provider: 'musicbrainz', label: 'MusicBrainz' }]),
      provider_errors_json: JSON.stringify([]),
      fetched_at: now,
      expires_at: '2999-01-01T00:00:00.000Z',
    };
    const database = {
      prepare: vi.fn(() => ({
        get: vi.fn(() => row),
      })),
    } as unknown as EchoDatabase;

    const result = await new AlbumOnlineInfoService(database).getAlbumOnlineInfo({ album: album(), tracks: [track()] });

    expect(result.fromCache).toBe(true);
    expect(result.credits[0]?.people[0]?.name).toBe('Cached Person');
    expect(result.artistInformation?.title).toBe('Cached Artist');
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('keeps writing cache compatible with the legacy related_json column', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ releases: [], pages: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const run = vi.fn();
    const database = {
      prepare: vi.fn((sql: string) => {
        if (sql.startsWith('SELECT *')) {
          return { get: vi.fn(() => null) };
        }
        if (sql.startsWith('PRAGMA')) {
          return {
            all: vi.fn(() => [
              { name: 'cache_key' },
              { name: 'related_json' },
              { name: 'information_json' },
            ]),
          };
        }
        return { run };
      }),
    } as unknown as EchoDatabase;

    await new AlbumOnlineInfoService(database).getAlbumOnlineInfo({ album: album(), tracks: [track()] });

    const insertSql = String((database.prepare as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] ?? '');
    expect(insertSql).toContain('related_json');
    expect(run.mock.calls[0]).toContain(JSON.stringify({}));
    expect(run.mock.calls[0]).toContain(JSON.stringify({ version: 2, album: null, artist: null }));
    vi.unstubAllGlobals();
  });

  it('prefers longer Wikipedia page extracts over short summaries', async () => {
    const run = vi.fn();
    const database = {
      prepare: vi.fn((sql: string) => {
        if (sql.startsWith('SELECT *')) {
          return { get: vi.fn(() => null) };
        }
        if (sql.startsWith('PRAGMA')) {
          return { all: vi.fn(() => [{ name: 'cache_key' }, { name: 'information_json' }]) };
        }
        return { run };
      }),
    } as unknown as EchoDatabase;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.hostname === 'musicbrainz.org') {
        return {
          ok: true,
          json: async () => ({ releases: [] }),
        };
      }
      if (url.pathname.includes('/w/rest.php/v1/search/page')) {
        const query = url.searchParams.get('q') ?? '';
        return {
          ok: true,
          json: async () => ({
            pages: [
              {
                key: query.includes('Cache Album') ? 'Cache_Album' : 'Cache_Artist',
                title: query.includes('Cache Album') ? 'Cache Album' : 'Cache Artist',
              },
            ],
          }),
        };
      }
      if (url.pathname.includes('/api/rest_v1/page/summary/')) {
        const title = decodeURIComponent(url.pathname.split('/').pop() ?? '');
        return {
          ok: true,
          json: async () => ({
            title: title.replace(/_/gu, ' '),
            description: title.includes('Artist') ? 'Artist' : 'Album',
            extract: 'Short summary.',
            content_urls: { desktop: { page: `https://example.test/${title}` } },
            thumbnail: { source: null },
          }),
        };
      }
      if (url.pathname.includes('/w/api.php')) {
        const title = url.searchParams.get('titles') ?? '';
        return {
          ok: true,
          json: async () => ({
            query: {
              pages: {
                1: {
                  extract: title.includes('Artist')
                    ? 'Long artist biography paragraph one.\n\nLong artist biography paragraph two with career details.'
                    : 'Long album background paragraph with release context.',
                },
              },
            },
          }),
        };
      }
      throw new Error(`unexpected_url:${url.toString()}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new AlbumOnlineInfoService(database).getAlbumOnlineInfo({ album: album(), tracks: [track()] }, { locale: 'en-US' });

    expect(result.information?.extract).toBe('Long album background paragraph with release context.');
    expect(result.artistInformation?.extract).toContain('career details');
    expect(result.artistInformation?.extract).toContain('\n\n');
    expect(result.artistInformation?.extract).not.toBe('Short summary.');
    vi.unstubAllGlobals();
  });
});
