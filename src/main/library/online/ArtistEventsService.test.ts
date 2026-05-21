import { describe, expect, it, vi } from 'vitest';
import { ArtistEventsService } from './ArtistEventsService';
import { createDatabase } from '../../database/createDatabase';

describe('ArtistEventsService', () => {
  it('does not fetch Bandsintown events without an app_id', async () => {
    const fetcher = vi.fn();

    const result = await new ArtistEventsService(fetcher).getBandsintownEvents({
      artistName: 'Echo Unit',
      appId: null,
      region: 'HK',
    });

    expect(result.status).toBe('not_configured');
    expect(result.events).toEqual([]);
    expect(result.region).toBe('HK');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps Bandsintown event payloads into the shared concert event shape', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        {
          id: 'evt-2',
          title: 'Echo Unit Live',
          datetime: '2026-06-02T20:00:00',
          url: 'https://bandsintown.example/events/evt-2',
          venue: {
            name: 'Second Hall',
            city: 'Tokyo',
            region: 'Tokyo',
            country: 'Japan',
          },
        },
        {
          id: 'evt-1',
          datetime: '2026-06-01T20:00:00',
          venue: {
            name: 'Echo Arena',
            city: 'Hong Kong',
            region: 'HK',
            country: 'Hong Kong',
          },
        },
      ],
    });

    const result = await new ArtistEventsService(fetcher).getBandsintownEvents({
      artistName: 'Echo Unit',
      appId: 'echo-next',
      now: new Date('2026-05-20T00:00:00.000Z'),
    });

    expect(result.status).toBe('ready');
    expect(result.sources).toEqual(['bandsintown']);
    expect(result.fetchedAt).toBe('2026-05-20T00:00:00.000Z');
    expect(result.events).toEqual([
      {
        id: 'bandsintown:evt-1',
        source: 'bandsintown',
        sourceLabel: 'Bandsintown',
        title: 'Echo Arena - Hong Kong',
        startsAt: '2026-06-01T20:00:00',
        timezone: null,
        timeTbd: false,
        venueName: 'Echo Arena',
        city: 'Hong Kong',
        region: 'HK',
        country: 'Hong Kong',
        url: null,
        ticketUrl: null,
        venueUrl: null,
      },
      {
        id: 'bandsintown:evt-2',
        source: 'bandsintown',
        sourceLabel: 'Bandsintown',
        title: 'Echo Unit Live',
        startsAt: '2026-06-02T20:00:00',
        timezone: null,
        timeTbd: false,
        venueName: 'Second Hall',
        city: 'Tokyo',
        region: 'Tokyo',
        country: 'Japan',
        url: 'https://bandsintown.example/events/evt-2',
        ticketUrl: null,
        venueUrl: null,
      },
    ]);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('https://rest.bandsintown.com/artists/Echo%20Unit/events?');
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('app_id=echo-next');
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('date=upcoming');
  });

  it('filters Bandsintown events by manual region text', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        {
          id: 'hk',
          datetime: '2026-06-01T20:00:00',
          venue: { name: 'Echo Arena', city: 'Hong Kong', region: 'HK', country: 'Hong Kong' },
        },
        {
          id: 'jp',
          datetime: '2026-06-02T20:00:00',
          venue: { name: 'Second Hall', city: 'Tokyo', region: 'Tokyo', country: 'Japan' },
        },
      ],
    });

    const result = await new ArtistEventsService(fetcher).getBandsintownEvents({
      artistName: 'Echo Unit',
      appId: 'echo-next',
      region: 'tokyo',
    });

    expect(result.events.map((event) => event.id)).toEqual(['bandsintown:jp']);
  });

  it('degrades to unavailable when Bandsintown fails', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({}),
    });

    const result = await new ArtistEventsService(fetcher).getBandsintownEvents({
      artistName: 'Echo Unit',
      appId: 'echo-next',
      region: 'HK',
      now: new Date('2026-05-20T00:00:00.000Z'),
    });

    expect(result.status).toBe('unavailable');
    expect(result.sources).toEqual(['bandsintown']);
    expect(result.events).toEqual([]);
    expect(result.fetchedAt).toBe('2026-05-20T00:00:00.000Z');
    expect(result.message).toBe('bandsintown_request_failed:429');
  });

  it('reuses cached Bandsintown events for the same artist and region', async () => {
    const database = createDatabase(':memory:');
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        {
          id: 'hk',
          datetime: '2026-06-01T20:00:00',
          venue: { name: 'Echo Arena', city: 'Hong Kong', region: 'HK', country: 'Hong Kong' },
        },
      ],
    });
    const service = new ArtistEventsService(fetcher, database);

    const first = await service.getBandsintownEvents({
      artistId: 'artist-1',
      artistName: 'Echo Unit',
      appId: 'echo-next',
      region: 'HK',
      now: new Date('2026-05-20T00:00:00.000Z'),
    });
    const second = await service.getBandsintownEvents({
      artistId: 'artist-1',
      artistName: 'Echo Unit',
      appId: 'echo-next',
      region: 'HK',
      now: new Date('2026-05-20T00:10:00.000Z'),
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first.events).toHaveLength(1);
    expect(second.events).toEqual(first.events);
    database.close();
  });
});
