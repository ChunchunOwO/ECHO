import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LibraryTrack } from '../../shared/types/library';
import type { MvSettings, TrackVideo } from '../../shared/types/mv';
import { BilibiliMvProvider, YouTubeMvProvider } from './OnlineMvProviders';

const track: LibraryTrack = {
  id: 'track-1',
  path: 'D:\\Music\\Echo Song.flac',
  title: 'Echo Song',
  artist: 'Echo Artist',
  album: 'Echo Album',
  albumArtist: 'Echo Artist',
  trackNo: 1,
  discNo: 1,
  year: 2026,
  genre: null,
  duration: 120,
  codec: 'flac',
  sampleRate: 44100,
  bitDepth: 16,
  bitrate: null,
  coverId: null,
  coverThumb: null,
  fieldSources: {},
};

const settings: MvSettings = {
  autoSearch: true,
  autoPreload: true,
  restartAudioOnLoad: false,
  enabledProviders: ['bilibili', 'youtube'],
  providerOrder: ['bilibili', 'youtube'],
  maxQuality: '1080p',
  allow60fps: true,
};

const video: TrackVideo = {
  id: 'video-1',
  trackId: 'track-1',
  provider: 'bilibili',
  sourceType: 'search_candidate',
  sourceId: 'BV1echo',
  title: 'Echo Song MV',
  artist: 'Echo Artist',
  url: 'https://www.bilibili.com/video/BV1echo',
  providerUrl: 'https://www.bilibili.com/video/BV1echo',
  thumbnailUrl: null,
  filePath: null,
  mediaUrl: null,
  mimeType: null,
  durationSeconds: null,
  width: null,
  height: null,
  selectedQualityId: 'auto',
  qualityLabel: null,
  fps: null,
  score: 0.7,
  selected: true,
  playableInApp: false,
  rawProviderJson: null,
  createdAt: '2026-05-13T00:00:00.000Z',
  updatedAt: '2026-05-13T00:00:00.000Z',
};

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BilibiliMvProvider', () => {
  it('maps search results and sends account cookie only from main dependencies', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: {
          result: [
            {
              bvid: 'BV1echo',
              title: '<em class="keyword">Echo</em> Song MV',
              author: 'Echo Channel',
              pic: '//i.example/echo.jpg',
              play: '12.3万',
            },
          ],
        },
      }),
    ) as typeof fetch;
    const provider = new BilibiliMvProvider({
      fetchImpl,
      getCredentials: () => ({ provider: 'bilibili', cookie: 'SESSDATA=secret' }),
    });

    const candidates = await provider.search(track, settings);

    expect(candidates[0]).toMatchObject({
      provider: 'bilibili',
      sourceType: 'search_candidate',
      title: 'Echo Song MV',
      providerUrl: 'https://www.bilibili.com/video/BV1echo',
      thumbnailUrl: 'https://i.example/echo.jpg',
      uploader: 'Echo Channel',
      viewCount: 123000,
    });
    expect(candidates[0]?.reasons).toContain('播放 123000');
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('api.bilibili.com/x/web-interface/search/type'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Cookie: 'SESSDATA=secret',
          Referer: 'https://search.bilibili.com/video?keyword=Echo%20Song%20Echo%20Artist%20MV',
          Origin: 'https://search.bilibili.com',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,ja;q=0.7',
        }),
      }),
    );
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('order=click'), expect.anything());
  });

  it('uses signed WBI search when Bilibili exposes WBI keys', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/x/web-interface/nav')) {
        return jsonResponse({
          data: {
            wbi_img: {
              img_url: 'https://i0.hdslb.com/bfs/wbi/abcdefghijklmnopqrstuvwxyzABCDEF.png',
              sub_url: 'https://i0.hdslb.com/bfs/wbi/0123456789abcdefghijklmnopqrstuvwxyzABCDEF.png',
            },
          },
        });
      }

      return jsonResponse({
        data: {
          result: [
            {
              bvid: 'BV1wbi',
              title: 'Echo Song Official MV',
              author: 'Echo Channel',
              pic: '//i.example/wbi.jpg',
              play: '1.2万',
            },
          ],
        },
      });
    }) as typeof fetch;
    const provider = new BilibiliMvProvider({
      fetchImpl,
      getCredentials: () => ({ provider: 'bilibili' }),
    });

    const candidates = await provider.search(track, settings);

    expect(candidates[0]).toMatchObject({
      provider: 'bilibili',
      title: 'Echo Song Official MV',
      providerUrl: 'https://www.bilibili.com/video/BV1wbi',
    });
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('/x/web-interface/nav'), expect.anything());
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp('api\\.bilibili\\.com/x/web-interface/wbi/search/type.*w_rid=')),
      expect.objectContaining({
        headers: expect.objectContaining({
          Referer: 'https://search.bilibili.com/video?keyword=Echo%20Song%20Echo%20Artist%20MV',
          Origin: 'https://search.bilibili.com',
        }),
      }),
    );
  });

  it('sorts Bilibili search results by match score first and play count second', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: {
          result: [
            {
              bvid: 'BV1popular',
              title: 'Popular unrelated video',
              author: 'Echo Channel',
              pic: '//i.example/popular.jpg',
              play: '99万',
            },
            {
              bvid: 'BV1low',
              title: 'Echo Song Low Play',
              author: 'Echo Channel',
              pic: '//i.example/low.jpg',
              play: '9000',
            },
            {
              bvid: 'BV1high',
              title: 'Echo Song High Play',
              author: 'Echo Channel',
              pic: '//i.example/high.jpg',
              play: '3.2万',
            },
          ],
        },
      }),
    ) as typeof fetch;
    const provider = new BilibiliMvProvider({
      fetchImpl,
      getCredentials: () => ({ provider: 'bilibili' }),
    });

    const candidates = await provider.search(track, settings);

    expect(candidates.map((candidate) => candidate.id)).toEqual(['bilibili:BV1high', 'bilibili:BV1low', 'bilibili:BV1popular']);
    expect(candidates.map((candidate) => candidate.viewCount)).toEqual([32000, 9000, 990000]);
    expect(candidates[0]?.score).toBe(candidates[1]?.score);
    expect(candidates[1]!.score).toBeGreaterThan(candidates[2]!.score);
  });

  it('sorts Bilibili search results by play count first when popularity matching is enabled', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: {
          result: [
            {
              bvid: 'BV1accurate',
              title: 'Echo Song Official MV',
              author: 'Echo Channel',
              pic: '//i.example/accurate.jpg',
              play: 1200,
            },
            {
              bvid: 'BV1popular',
              title: 'Popular unrelated video',
              author: 'Echo Channel',
              pic: '//i.example/popular.jpg',
              play: 250000,
            },
          ],
        },
      }),
    ) as typeof fetch;
    const provider = new BilibiliMvProvider({
      fetchImpl,
      getCredentials: () => ({ provider: 'bilibili' }),
    });

    const candidates = await provider.search(track, { ...settings, preferHighestViewCount: true }, 'Echo Song Echo Artist');

    expect(candidates.map((candidate) => candidate.id)).toEqual(['bilibili:BV1popular', 'bilibili:BV1accurate']);
    expect(candidates.map((candidate) => candidate.viewCount)).toEqual([250000, 1200]);
  });

  it('resolves direct MP4 stream variants within the quality cap', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/x/web-interface/view')) {
        return jsonResponse({ data: { cid: 123 } });
      }

      if (url.includes('qn=80')) {
        return jsonResponse({ data: { durl: [{ url: 'https://cdn.example/1080.mp4' }] } });
      }

      if (url.includes('qn=64')) {
        return jsonResponse({ data: { durl: [{ url: 'https://cdn.example/720.mp4' }] } });
      }

      return jsonResponse({ code: -1 }, 403);
    }) as typeof fetch;
    const provider = new BilibiliMvProvider({
      fetchImpl,
      getCredentials: () => ({ provider: 'bilibili' }),
    });

    const variants = await provider.resolve(video, settings);

    expect(variants.map((variant) => variant.id)).toEqual(['bilibili-qn-80', 'bilibili-qn-64']);
    expect(variants[0]).toMatchObject({
      label: '1080p',
      qualityTier: '1080p',
      mimeType: 'video/mp4',
      playableInApp: true,
      url: 'https://cdn.example/1080.mp4',
      headers: { Referer: 'https://www.bilibili.com/video/BV1echo' },
    });
  });

  it('uses the WBI playurl endpoint when Bilibili exposes signing keys', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/x/web-interface/view')) {
        return jsonResponse({ data: { cid: 123 } });
      }

      if (url.includes('/x/web-interface/nav')) {
        return jsonResponse({
          data: {
            wbi_img: {
              img_url: 'https://i0.hdslb.com/bfs/wbi/abcdefghijklmnopqrstuvwxyzABCDEF.png',
              sub_url: 'https://i0.hdslb.com/bfs/wbi/0123456789abcdefghijklmnopqrstuvwxyzABCDEF.png',
            },
          },
        });
      }

      if (url.includes('/x/player/wbi/playurl') && url.includes('qn=80')) {
        expect(url).toContain('wts=');
        expect(url).toContain('w_rid=');
        return jsonResponse({ data: { quality: 80, durl: [{ url: 'https://cdn.example/wbi-1080.mp4' }] } });
      }

      if (url.includes('/x/player/playurl')) {
        throw new Error('unsigned playurl endpoint should not be used when WBI keys are available');
      }

      return jsonResponse({ code: -1 }, 403);
    }) as typeof fetch;
    const provider = new BilibiliMvProvider({
      fetchImpl,
      getCredentials: () => ({ provider: 'bilibili', cookie: 'SESSDATA=secret' }),
    });

    const variants = await provider.resolve(video, settings);

    expect(variants[0]).toMatchObject({
      id: 'bilibili-qn-80',
      url: 'https://cdn.example/wbi-1080.mp4',
      rawProviderJson: {
        endpoint: 'wbi-playurl',
      },
    });
  });

  it('resolves Bilibili DASH video streams so logged-in higher quality is not capped at durl-only 720p', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/x/web-interface/view')) {
        return jsonResponse({ data: { cid: 123 } });
      }

      if (url.includes('qn=80')) {
        return jsonResponse({
          data: {
            quality: 80,
            dash: {
              video: [
                {
                  id: 80,
                  baseUrl: 'https://upos.example/1080-video-only.m4s',
                  backupUrl: ['https://upos-backup.example/1080-video-only.m4s'],
                  width: 1920,
                  height: 1080,
                  frameRate: '30',
                  codecs: 'avc1.640032',
                },
              ],
            },
          },
        });
      }

      if (url.includes('qn=64')) {
        return jsonResponse({
          data: {
            quality: 64,
            dash: {
              video: [
                {
                  id: 64,
                  baseUrl: 'https://upos.example/720-video-only.m4s',
                  width: 1280,
                  height: 720,
                  frameRate: '30',
                  codecs: 'avc1.640028',
                },
              ],
            },
          },
        });
      }

      return jsonResponse({ code: -1 }, 403);
    }) as typeof fetch;
    const provider = new BilibiliMvProvider({
      fetchImpl,
      getCredentials: () => ({ provider: 'bilibili', cookie: 'SESSDATA=secret' }),
    });

    const variants = await provider.resolve(video, settings);

    expect(variants.map((variant) => variant.id)).toEqual(['bilibili-qn-80', 'bilibili-qn-64']);
    expect(variants[0]).toMatchObject({
      label: '1080p',
      qualityTier: '1080p',
      width: 1920,
      height: 1080,
      codec: 'avc1.640032',
      url: 'https://upos.example/1080-video-only.m4s',
      headers: {
        Cookie: 'SESSDATA=secret',
        Referer: 'https://www.bilibili.com/video/BV1echo',
      },
    });
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('fnval=4048'), expect.anything());
  });

  it('resolves unrestricted variants when max quality is selected and keeps 60fps variants', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/x/web-interface/view')) {
        return jsonResponse({ data: { cid: 123 } });
      }

      if (url.includes('qn=120')) {
        return jsonResponse({ data: { quality: 120, durl: [{ url: 'https://cdn.example/4k.mp4' }] } });
      }

      if (url.includes('qn=116')) {
        return jsonResponse({ data: { quality: 116, durl: [{ url: 'https://cdn.example/1080-60.mp4' }] } });
      }

      if (url.includes('qn=80')) {
        return jsonResponse({ data: { quality: 80, durl: [{ url: 'https://cdn.example/1080.mp4' }] } });
      }

      return jsonResponse({ code: -1 }, 403);
    }) as typeof fetch;
    const provider = new BilibiliMvProvider({
      fetchImpl,
      getCredentials: () => ({ provider: 'bilibili' }),
    });

    const variants = await provider.resolve(video, { ...settings, maxQuality: 'max', allow60fps: true });

    expect(variants.map((variant) => variant.id)).toEqual(['bilibili-qn-120', 'bilibili-qn-116', 'bilibili-qn-80']);
    expect(variants[0]).toMatchObject({
      id: 'bilibili-qn-120',
      label: '4K',
      rawProviderJson: {
        requestedQn: 120,
        qn: 120,
        qualityRank: 5,
        qualityLimited: false,
      },
    });
    expect(variants.find((variant) => variant.id === 'bilibili-qn-116')).toMatchObject({
      label: '1080p 60fps',
      fps: 60,
      url: 'https://cdn.example/1080-60.mp4',
      rawProviderJson: {
        requestedQn: 116,
        qn: 116,
        qualityRank: 4,
      },
    });
  });

  it('honors the 60fps setting when resolving Bilibili variants', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/x/web-interface/view')) {
        return jsonResponse({ data: { cid: 123 } });
      }

      if (url.includes('qn=116')) {
        return jsonResponse({ data: { quality: 116, durl: [{ url: 'https://cdn.example/1080-60.mp4' }] } });
      }

      if (url.includes('qn=80')) {
        return jsonResponse({ data: { quality: 80, durl: [{ url: 'https://cdn.example/1080.mp4' }] } });
      }

      return jsonResponse({ code: -1 }, 403);
    }) as typeof fetch;
    const provider = new BilibiliMvProvider({
      fetchImpl,
      getCredentials: () => ({ provider: 'bilibili' }),
    });

    const variants = await provider.resolve(video, { ...settings, maxQuality: '1080p', allow60fps: false });

    expect(fetchImpl).not.toHaveBeenCalledWith(expect.stringContaining('qn=116'), expect.anything());
    expect(variants.map((variant) => variant.id)).toEqual(['bilibili-qn-80']);
  });

  it('resolves 4K DASH video streams when the MV quality cap allows 2160p', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/x/web-interface/view')) {
        return jsonResponse({ data: { cid: 123 } });
      }

      if (url.includes('qn=126') || url.includes('qn=125') || url.includes('qn=127')) {
        throw new Error('2160p cap should not request 8K, Dolby Vision, or HDR variants');
      }

      if (url.includes('qn=120')) {
        return jsonResponse({
          data: {
            quality: 120,
            dash: {
              video: [
                {
                  id: 120,
                  baseUrl: 'https://upos.example/4k-video-only.m4s',
                  width: 3840,
                  height: 2160,
                  frameRate: '60',
                  codecs: 'hev1.1.6.L153.90',
                },
              ],
            },
          },
        });
      }

      return jsonResponse({ code: -1 }, 403);
    }) as typeof fetch;
    const provider = new BilibiliMvProvider({
      fetchImpl,
      getCredentials: () => ({ provider: 'bilibili', cookie: 'SESSDATA=secret' }),
    });

    const variants = await provider.resolve(video, { ...settings, maxQuality: '2160p', allow60fps: true });

    expect(variants[0]).toMatchObject({
      id: 'bilibili-qn-120',
      label: '4K 60fps',
      qualityTier: '2160p',
      width: 3840,
      height: 2160,
      fps: 60,
      url: 'https://upos.example/4k-video-only.m4s',
    });
  });

  it('keeps 4K 120fps DASH streams as distinct playable variants', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/x/web-interface/view')) {
        return jsonResponse({ data: { cid: 123 } });
      }

      if (url.includes('qn=120')) {
        return jsonResponse({
          data: {
            quality: 120,
            dash: {
              video: [
                {
                  id: 120,
                  baseUrl: 'https://upos.example/4k-60.m4s',
                  width: 3840,
                  height: 2160,
                  frameRate: '60',
                  codecs: 'hev1.1.6.L153.90',
                },
                {
                  id: 120,
                  baseUrl: 'https://upos.example/4k-120.m4s',
                  width: 3840,
                  height: 2160,
                  frameRate: '120',
                  codecs: 'hev1.1.6.L153.90',
                },
              ],
            },
          },
        });
      }

      return jsonResponse({ code: -1 }, 403);
    }) as typeof fetch;
    const provider = new BilibiliMvProvider({
      fetchImpl,
      getCredentials: () => ({ provider: 'bilibili', cookie: 'SESSDATA=secret' }),
    });

    const variants = await provider.resolve(video, { ...settings, maxQuality: '2160p', allow60fps: true });

    expect(variants.map((variant) => variant.id)).toContain('bilibili-qn-120');
    expect(variants.map((variant) => variant.id)).toContain('bilibili-qn-120-120fps');
    expect(variants.find((variant) => variant.id === 'bilibili-qn-120-120fps')).toMatchObject({
      label: '4K 120fps',
      qualityTier: '2160p',
      width: 3840,
      height: 2160,
      fps: 120,
      url: 'https://upos.example/4k-120.m4s',
    });
  });

  it('labels Bilibili streams with the actual returned quality when the requested quality is downgraded', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/x/web-interface/view')) {
        return jsonResponse({ data: { cid: 123 } });
      }

      if (url.includes('qn=127')) {
        return jsonResponse({ data: { quality: 80, durl: [{ url: 'https://cdn.example/actual-1080.mp4' }] } });
      }

      if (url.includes('qn=80')) {
        return jsonResponse({ data: { quality: 80, durl: [{ url: 'https://cdn.example/actual-1080.mp4' }] } });
      }

      return jsonResponse({ code: -1 }, 403);
    }) as typeof fetch;
    const provider = new BilibiliMvProvider({
      fetchImpl,
      getCredentials: () => ({ provider: 'bilibili' }),
    });

    const variants = await provider.resolve(video, { ...settings, maxQuality: 'max' });

    expect(variants).toHaveLength(1);
    expect(variants[0]).toMatchObject({
      id: 'bilibili-qn-80',
      label: '1080p',
      qualityTier: '1080p',
      height: 1080,
      url: 'https://cdn.example/actual-1080.mp4',
      rawProviderJson: {
        requestedQn: 127,
        qn: 80,
        qualityRank: 2,
        qualityLimited: true,
      },
    });
  });

  it('keeps the Bilibili 1080p60 label when the encoded DASH height is letterboxed', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/x/web-interface/view')) {
        return jsonResponse({ data: { cid: 123 } });
      }

      if (url.includes('qn=116')) {
        return jsonResponse({
          data: {
            quality: 116,
            accept_quality: [116, 80, 64],
            dash: {
              video: [
                {
                  id: 116,
                  baseUrl: 'https://upos.example/1080-60-letterbox.m4s',
                  width: 1920,
                  height: 888,
                  frameRate: '60',
                  codecs: 'avc1.640032',
                },
              ],
            },
          },
        });
      }

      return jsonResponse({ code: -1 }, 403);
    }) as typeof fetch;
    const provider = new BilibiliMvProvider({
      fetchImpl,
      getCredentials: () => ({ provider: 'bilibili', cookie: 'SESSDATA=secret' }),
    });

    const variants = await provider.resolve(video, { ...settings, maxQuality: '1080p', allow60fps: true });

    expect(variants[0]).toMatchObject({
      id: 'bilibili-qn-116',
      label: '1080p 60fps',
      qualityTier: '1080p',
      width: 1920,
      height: 888,
      fps: 60,
      rawProviderJson: {
        requestedQn: 116,
        qn: 116,
        qualityRank: 4,
        availableQn: [116, 80, 64],
      },
    });
  });

  it('does not trust a high requested qn as 8K when Bilibili omits the actual quality', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/x/web-interface/view')) {
        return jsonResponse({ data: { cid: 123 } });
      }

      if (url.includes('qn=127')) {
        return jsonResponse({ data: { durl: [{ url: 'https://cdn.example/no-quality-field.mp4' }] } });
      }

      return jsonResponse({ code: -1 }, 403);
    }) as typeof fetch;
    const provider = new BilibiliMvProvider({
      fetchImpl,
      getCredentials: () => ({ provider: 'bilibili' }),
    });

    const variants = await provider.resolve(video, { ...settings, maxQuality: 'max' });

    expect(variants[0]).toMatchObject({
      id: 'bilibili-qn-120',
      label: '4K',
      qualityTier: '2160p',
      height: 2160,
      url: 'https://cdn.example/no-quality-field.mp4',
    });
  });
});

describe('YouTubeMvProvider', () => {
  it('requests YouTube results ordered by view count when an API key is configured', async () => {
    const originalEchoKey = process.env.ECHO_YOUTUBE_API_KEY;
    process.env.ECHO_YOUTUBE_API_KEY = 'test-key';
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [] })) as typeof fetch;
    const provider = new YouTubeMvProvider({ fetchImpl });

    try {
      await provider.search(track, settings);

      expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('order=viewCount'), expect.anything());
    } finally {
      if (originalEchoKey === undefined) {
        delete process.env.ECHO_YOUTUBE_API_KEY;
      } else {
        process.env.ECHO_YOUTUBE_API_KEY = originalEchoKey;
      }
    }
  });

  it('does not scrape YouTube when no official API key is configured', async () => {
    const originalEchoKey = process.env.ECHO_YOUTUBE_API_KEY;
    const originalYouTubeKey = process.env.YOUTUBE_DATA_API_KEY;
    delete process.env.ECHO_YOUTUBE_API_KEY;
    delete process.env.YOUTUBE_DATA_API_KEY;
    const fetchImpl = vi.fn() as typeof fetch;
    const provider = new YouTubeMvProvider({ fetchImpl });

    try {
      const candidates = await provider.search(track, settings);

      expect(candidates).toEqual([]);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      if (originalEchoKey === undefined) {
        delete process.env.ECHO_YOUTUBE_API_KEY;
      } else {
        process.env.ECHO_YOUTUBE_API_KEY = originalEchoKey;
      }
      if (originalYouTubeKey === undefined) {
        delete process.env.YOUTUBE_DATA_API_KEY;
      } else {
        process.env.YOUTUBE_DATA_API_KEY = originalYouTubeKey;
      }
    }
  });
});
