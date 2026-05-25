import { describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../../database/createDatabase';
import { ArtistOnlineInfoService } from './ArtistOnlineInfoService';
import type { LibraryArtist } from '../../../shared/types/library';

const artist = (overrides: Partial<LibraryArtist> = {}): LibraryArtist => ({
  id: 'artist-1',
  name: 'Echo Unit',
  sortName: 'echo unit',
  role: 'both',
  trackCount: 3,
  albumCount: 1,
  coverId: null,
  coverThumb: null,
  ...overrides,
});

describe('ArtistOnlineInfoService', () => {
  it('maps Wikimedia and MusicBrainz data into cached artist online info', async () => {
    const database = createDatabase(':memory:');
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('/w/rest.php/v1/search/page')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ pages: [{ key: 'Echo_Unit', title: 'Echo Unit' }] }),
        };
      }
      if (url.includes('/api/rest_v1/page/summary/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            title: 'Echo Unit',
            description: 'Japanese band',
            extract: 'Echo Unit is a fictional test artist.',
            thumbnail: { source: 'https://img.example/echo.jpg' },
            content_urls: { desktop: { page: 'https://example.wikipedia/Echo_Unit' } },
          }),
        };
      }
      if (url.includes('/ws/2/artist/?query=')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ artists: [{ id: 'mbid-1', name: 'Echo Unit', score: 100 }] }),
        };
      }
      if (url.includes('/ws/2/artist/mbid-1')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            relations: [
              { type: 'official homepage', url: { resource: 'https://echo.example' } },
              { type: 'member of band', artist: { id: 'mbid-2', name: 'Echo Sister' } },
            ],
          }),
        };
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const service = new ArtistOnlineInfoService(database, fetcher);

    const result = await service.getArtistOnlineInfo(artist(), {
      locale: 'en-US',
      now: new Date('2026-05-20T00:00:00.000Z'),
    });
    const cached = await service.getArtistOnlineInfo(artist(), {
      locale: 'en-US',
      now: new Date('2026-05-20T00:05:00.000Z'),
    });

    expect(result.status).toBe('ready');
    expect(result.bio?.title).toBe('Echo Unit');
    expect(result.bio?.extract).toContain('fictional test artist');
    expect(result.sourceLabels).toEqual(['en.wikipedia.org', 'MusicBrainz']);
    expect(result.externalLinks.map((link) => link.url)).toEqual([
      'https://example.wikipedia/Echo_Unit',
      'https://musicbrainz.org/artist/mbid-1',
      'https://echo.example',
    ]);
    expect(result.relatedArtists?.[0]?.name).toBe('Echo Sister');
    expect(cached.fromCache).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(4);
    database.close();
  });

  it('falls back to Japanese Wikipedia when the current locale has no artist page', async () => {
    const database = createDatabase(':memory:');
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('zh.wikipedia.org/w/rest.php/v1/search/page')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ pages: [] }),
        };
      }
      if (url.includes('ja.wikipedia.org/w/rest.php/v1/search/page')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ pages: [{ key: 'Aiobahn', title: 'Aiobahn' }] }),
        };
      }
      if (url.includes('ja.wikipedia.org/api/rest_v1/page/summary/Aiobahn')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            title: 'Aiobahn',
            description: '韓国の音楽家',
            extract: 'Aiobahn は韓国の電子音楽家、DJ、音楽プロデューサー。',
            content_urls: { desktop: { page: 'https://ja.wikipedia.org/wiki/Aiobahn' } },
          }),
        };
      }
      if (url.includes('/ws/2/artist/?query=')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ artists: [] }),
        };
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const service = new ArtistOnlineInfoService(database, fetcher);

    const result = await service.getArtistOnlineInfo(artist({ name: 'Aiobahn' }), {
      locale: 'zh-CN',
      now: new Date('2026-05-20T00:00:00.000Z'),
    });

    expect(result.status).toBe('ready');
    expect(result.bio?.language).toBe('ja');
    expect(result.bio?.extract).toContain('電子音楽家');
    expect(result.sourceLabels).toEqual(['ja.wikipedia.org']);
    expect(result.externalLinks.map((link) => link.url)).toEqual(['https://ja.wikipedia.org/wiki/Aiobahn']);
    database.close();
  });

  it('degrades to unavailable and short-caches provider failures', async () => {
    const database = createDatabase(':memory:');
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    });
    const service = new ArtistOnlineInfoService(database, fetcher);

    const result = await service.getArtistOnlineInfo(artist(), {
      locale: 'en-US',
      now: new Date('2026-05-20T00:00:00.000Z'),
    });

    expect(result.status).toBe('unavailable');
    expect(result.bio).toBeNull();
    expect(result.errors?.join('\n')).toContain('MusicBrainz');
    expect(result.errors?.join('\n')).toContain('Wikipedia');
    database.close();
  });
});
