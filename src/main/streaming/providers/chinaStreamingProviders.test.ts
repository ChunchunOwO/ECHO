import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeteaseStreamingProvider, setNeteaseApiForTests } from './NeteaseStreamingProvider';
import { QQMusicStreamingProvider } from './QQMusicStreamingProvider';

const accountStatus = vi.hoisted(() => ({
  connected: true,
  displayName: 'Tester',
  username: 'tester',
  avatarUrl: null,
}));

vi.mock('../../accounts/AccountService', () => ({
  getAccountService: () => ({
    getStatus: (provider: string) => ({
      provider,
      connected: accountStatus.connected,
      username: accountStatus.username,
      displayName: accountStatus.displayName,
      avatarUrl: accountStatus.avatarUrl,
      lastLoginAt: '2026-01-01T00:00:00.000Z',
      lastCheckedAt: null,
      expiresAt: null,
      error: null,
    }),
    getCredentials: (provider: string) => ({
      provider,
      cookie: provider === 'qqmusic' ? 'uin=o123456; qm_keyst=secret' : 'MUSIC_U=secret; csrf=hidden',
    }),
  }),
}));

const jsonResponse = (value: unknown): Response =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const remoteImageUrl = (url: string, referer: string): string =>
  `echo-image://remote/${encodeURIComponent(url)}?referer=${encodeURIComponent(referer)}`;

afterEach(() => {
  vi.unstubAllGlobals();
  setNeteaseApiForTests(undefined);
  accountStatus.connected = true;
});

describe('China streaming providers', () => {
  it('maps NetEase search results to streaming tracks', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            result: {
              songCount: 1,
              songs: [
                {
                  id: 123,
                  name: '测试歌曲',
                  duration: 181000,
                  artists: [{ id: 1, name: '测试歌手' }],
                  album: { id: 2, name: '测试专辑', picId: 109951 },
                },
              ],
            },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            songs: [
              {
                id: 123,
                album: { picUrl: 'https://p.music.126.net/detail-cover.jpg' },
              },
            ],
          }),
        ),
    );

    const result = await new NeteaseStreamingProvider().search({ provider: 'netease', query: '测试', page: 1, pageSize: 10 });

    expect(result.tracks[0]).toMatchObject({
      provider: 'netease',
      providerTrackId: '123',
      stableKey: 'streaming:netease:123',
      title: '测试歌曲',
      artist: '测试歌手',
      album: '测试专辑',
      duration: 181,
      coverThumb: remoteImageUrl('https://p.music.126.net/detail-cover.jpg?param=160y160', 'https://music.163.com/'),
    });
  });

  it('resolves NetEase playback without returning secret headers', async () => {
    setNeteaseApiForTests(null);
    const fetchRunner = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          {
            id: 123,
            url: 'https://m701.music.126.net/token/song.mp3',
            br: 320000,
            type: 'mp3',
          },
        ],
      }),
    );
    vi.stubGlobal(
      'fetch',
      fetchRunner,
    );

    const source = await new NeteaseStreamingProvider().resolvePlayback({ provider: 'netease', providerTrackId: '123', quality: 'high' });

    expect(String(fetchRunner.mock.calls[0][0])).toContain('csrf_token=hidden');
    expect(String(fetchRunner.mock.calls[0][0])).toContain('os=pc');
    expect(source).toMatchObject({
      provider: 'netease',
      providerTrackId: '123',
      url: 'https://m701.music.126.net/token/song.mp3',
      headers: {},
      requiresProxy: false,
      supportsRange: true,
    });
  });

  it('uses the NetEase enhanced song_url_v1 resolver before the public URL fallback', async () => {
    const songUrlV1 = vi.fn().mockResolvedValue({
      body: {
        data: [
          {
            url: 'https://m701.music.126.net/enhanced/song.flac',
            br: 999000,
            type: 'flac',
            level: 'lossless',
          },
        ],
      },
    });
    const fetchRunner = vi.fn();
    setNeteaseApiForTests({ song_url_v1: songUrlV1 });
    vi.stubGlobal('fetch', fetchRunner);

    const source = await new NeteaseStreamingProvider().resolvePlayback({ provider: 'netease', providerTrackId: '123', quality: 'lossless' });

    expect(songUrlV1).toHaveBeenCalledWith({
      id: 123,
      level: 'lossless',
      cookie: 'MUSIC_U=secret; csrf=hidden',
    });
    expect(fetchRunner).not.toHaveBeenCalled();
    expect(source).toMatchObject({
      url: 'https://m701.music.126.net/enhanced/song.flac',
      codec: 'flac',
      bitrate: 999000,
    });
  });

  it('falls back to high quality when NetEase max quality returns no URL', async () => {
    setNeteaseApiForTests(null);
    const fetchRunner = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 123, url: null, br: 999000, type: 'flac', code: 200 }] }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 123, url: null, br: 999000, type: 'flac', code: 200 }] }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 123, url: null, br: 999000, type: 'flac', code: 200 }] }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 123, url: null, br: 999000, type: 'flac', code: 200 }] }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 123, url: null, br: 999000, type: 'flac', code: 200 }] }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: 123,
              url: 'https://m701.music.126.net/token/song.mp3',
              br: 320000,
              type: 'mp3',
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchRunner);

    const source = await new NeteaseStreamingProvider().resolvePlayback({ provider: 'netease', providerTrackId: '123', quality: 'hires' });

    expect(source).toMatchObject({
      url: 'https://m701.music.126.net/token/song.mp3',
      codec: 'mp3',
      bitrate: 320000,
    });
    expect(fetchRunner).toHaveBeenCalledTimes(6);
    expect(String(fetchRunner.mock.calls[0][0])).toContain('level=jymaster');
    expect(String(fetchRunner.mock.calls[3][0])).toContain('level=hires');
    expect(String(fetchRunner.mock.calls[5][0])).toContain('level=exhigh');
    expect(String(fetchRunner.mock.calls[0][0])).toContain('encodeType=flac');
  });

  it('maps QQ Music search results to streaming tracks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          req_1: {
            data: {
              body: {
                song: {
                  list: [
                    {
                      mid: 'song-mid',
                      name: '测试歌曲',
                      interval: 180,
                      singer: [{ mid: 'artist-mid', name: '测试歌手' }],
                      album: { mid: 'album-mid', name: '测试专辑' },
                    },
                  ],
                },
              },
              meta: {
                sum: 1,
              },
            },
          },
        }),
      ),
    );

    const result = await new QQMusicStreamingProvider().search({ provider: 'qqmusic', query: '测试', page: 1, pageSize: 10 });

    expect(result.tracks[0]).toMatchObject({
      provider: 'qqmusic',
      providerTrackId: 'song-mid',
      stableKey: 'streaming:qqmusic:song-mid',
      title: '测试歌曲',
      artist: '测试歌手',
      album: '测试专辑',
      duration: 180,
      coverThumb: remoteImageUrl('https://y.gtimg.cn/music/photo_new/T002R150x150M000album-mid.jpg', 'https://y.qq.com/'),
    });
  });

  it('maps QQ Music playlist song fields to streaming tracks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          cdlist: [
            {
              dissname: 'QQ Playlist',
              desc: 'Imported from QQ Music',
              logo: 'https://qpic.y.qq.com/music_cover/playlist.jpg',
              total_song_num: 1,
              songlist: [
                {
                  songmid: 'playlist-song-mid',
                  songid: 123,
                  songname: 'Playlist Song Title',
                  songorig: 'Original Song Title',
                  interval: 242,
                  singer: [{ mid: 'artist-mid', name: 'Playlist Artist' }],
                  albumname: 'Playlist Album',
                  albummid: 'playlist-album-mid',
                },
              ],
            },
          ],
        }),
      ),
    );

    const playlist = await new QQMusicStreamingProvider().getPlaylist({ providerPlaylistId: '123456', page: 1, pageSize: 10 });

    expect(playlist).toMatchObject({
      provider: 'qqmusic',
      providerPlaylistId: '123456',
      title: 'QQ Playlist',
      trackCount: 1,
    });
    expect(playlist.tracks[0]).toMatchObject({
      provider: 'qqmusic',
      providerTrackId: 'playlist-song-mid',
      stableKey: 'streaming:qqmusic:playlist-song-mid',
      title: 'Playlist Song Title',
      artist: 'Playlist Artist',
      album: 'Playlist Album',
      duration: 242,
      coverThumb: remoteImageUrl('https://y.gtimg.cn/music/photo_new/T002R150x150M000playlist-album-mid.jpg', 'https://y.qq.com/'),
    });
  });

  it('fetches NetEase playlist song details in batches small enough for the API', async () => {
    setNeteaseApiForTests(null);
    const trackIds = Array.from({ length: 250 }, (_value, index) => index + 1);
    const detailSongs = (ids: number[]) =>
      ids.map((id) => ({
        id,
        name: `Song ${id}`,
        dt: 180000 + id,
        ar: [{ id: 1000 + id, name: `Artist ${id}` }],
        al: { id: 2000 + id, name: `Album ${id}`, picUrl: `https://p.music.126.net/${id}.jpg` },
      }));
    const fetchRunner = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          playlist: {
            name: 'NetEase Likes',
            trackCount: trackIds.length,
            trackIds: trackIds.map((id) => ({ id })),
            tracks: [],
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ songs: detailSongs(trackIds.slice(0, 100)) }))
      .mockResolvedValueOnce(jsonResponse({ songs: detailSongs(trackIds.slice(100, 200)) }))
      .mockResolvedValueOnce(jsonResponse({ songs: detailSongs(trackIds.slice(200)) }));
    vi.stubGlobal('fetch', fetchRunner);

    const playlist = await new NeteaseStreamingProvider().getPlaylist({ providerPlaylistId: '163289102', page: 1, pageSize: 250 });

    expect(playlist).toMatchObject({
      provider: 'netease',
      providerPlaylistId: '163289102',
      title: 'NetEase Likes',
      trackCount: 250,
      total: 250,
      hasMore: false,
    });
    expect(playlist.tracks).toHaveLength(250);
    expect(playlist.tracks[0]).toMatchObject({
      providerTrackId: '1',
      title: 'Song 1',
      artist: 'Artist 1',
      album: 'Album 1',
    });
    expect(fetchRunner).toHaveBeenCalledTimes(4);
    const detailRequests = fetchRunner.mock.calls.slice(1).map(([url]) => new URL(String(url)));
    expect(detailRequests.map((url) => JSON.parse(url.searchParams.get('ids') ?? '[]')).map((ids) => ids.length)).toEqual([100, 100, 50]);
  });

  it('uses the NetEase playlist track API for large playlist pages', async () => {
    const trackIds = Array.from({ length: 1500 }, (_value, index) => index + 1);
    const playlistTrackAll = vi.fn().mockResolvedValue({
      body: {
        songs: [
          {
            id: 1001,
            name: 'Deep Page Song',
            dt: 188000,
            ar: [{ id: 1, name: 'Deep Artist' }],
            al: { id: 2, name: 'Deep Album', picUrl: 'https://p.music.126.net/deep.jpg' },
          },
        ],
      },
    });
    setNeteaseApiForTests({ playlist_track_all: playlistTrackAll });
    const fetchRunner = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        playlist: {
          name: 'Large NetEase Playlist',
          trackCount: trackIds.length,
          trackIds: trackIds.map((id) => ({ id })),
          tracks: [],
        },
      }),
    );
    vi.stubGlobal('fetch', fetchRunner);

    const playlist = await new NeteaseStreamingProvider().getPlaylist({ providerPlaylistId: '2764805072', page: 3, pageSize: 500 });

    expect(playlistTrackAll).toHaveBeenCalledWith({
      id: '2764805072',
      limit: 500,
      offset: 1000,
      cookie: 'MUSIC_U=secret; csrf=hidden',
    });
    expect(fetchRunner).toHaveBeenCalledTimes(1);
    expect(playlist).toMatchObject({
      provider: 'netease',
      providerPlaylistId: '2764805072',
      title: 'Large NetEase Playlist',
      total: 1500,
      hasMore: false,
    });
    expect(playlist.tracks).toHaveLength(1);
    expect(playlist.tracks[0]).toMatchObject({
      providerTrackId: '1001',
      title: 'Deep Page Song',
      artist: 'Deep Artist',
      album: 'Deep Album',
    });
  });

  it('maps NetEase daily recommendations from the signed-in account', async () => {
    const recommendSongs = vi.fn().mockResolvedValue({
      body: {
        data: {
          dailySongs: [
            {
              id: 456,
              name: 'Daily Song',
              dt: 210000,
              ar: [{ id: 7, name: 'Daily Artist' }],
              al: { id: 8, name: 'Daily Album', picUrl: 'http://p.music.126.net/daily.jpg' },
            },
          ],
        },
      },
    });
    setNeteaseApiForTests({ recommend_songs: recommendSongs });

    const playlist = await new NeteaseStreamingProvider().getDailyRecommendPlaylist();

    expect(recommendSongs).toHaveBeenCalledWith({ cookie: 'MUSIC_U=secret; csrf=hidden' });
    expect(playlist).toMatchObject({
      provider: 'netease',
      providerPlaylistId: 'daily-recommend',
      title: '每日推荐',
      trackCount: 1,
      hasMore: false,
      coverThumb: remoteImageUrl('https://p.music.126.net/daily.jpg?param=160y160', 'https://music.163.com/'),
    });
    expect(playlist.tracks[0]).toMatchObject({
      providerTrackId: '456',
      title: 'Daily Song',
      artist: 'Daily Artist',
      album: 'Daily Album',
      coverThumb: remoteImageUrl('https://p.music.126.net/daily.jpg?param=160y160', 'https://music.163.com/'),
    });
  });

  it('resolves QQ Music playback through vkey without leaking account cookies', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            data: [
              {
                mid: 'song-mid',
                name: '测试歌曲',
                file: { media_mid: 'media-mid' },
                singer: [{ name: '测试歌手' }],
                album: { name: '测试专辑', mid: 'album-mid' },
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            req_0: {
              data: {
                sip: ['https://isure.stream.qqmusic.qq.com/'],
                midurlinfo: [{ purl: 'M800media-mid.mp3?vkey=temporary' }],
              },
            },
          }),
        ),
    );

    const source = await new QQMusicStreamingProvider().resolvePlayback({ provider: 'qqmusic', providerTrackId: 'song-mid', quality: 'high' });

    expect(source).toMatchObject({
      provider: 'qqmusic',
      providerTrackId: 'song-mid',
      url: 'https://isure.stream.qqmusic.qq.com/M800media-mid.mp3?vkey=temporary',
      headers: {},
      requiresProxy: false,
      supportsRange: true,
    });
  });

  it('falls back to playable QQ Music quality when lossless returns no URL', async () => {
    const fetchRunner = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              mid: 'song-mid',
              name: 'Fallback Song',
              file: { media_mid: 'media-mid' },
              singer: [{ name: 'Fallback Artist' }],
              album: { name: 'Fallback Album', mid: 'album-mid' },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          req_0: {
            data: {
              sip: ['https://isure.stream.qqmusic.qq.com/'],
              midurlinfo: [{ purl: '' }],
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          req_0: {
            data: {
              sip: ['https://isure.stream.qqmusic.qq.com/'],
              midurlinfo: [{ purl: 'M800media-mid.mp3?vkey=temporary' }],
            },
          },
        }),
      );
    vi.stubGlobal('fetch', fetchRunner);

    const source = await new QQMusicStreamingProvider().resolvePlayback({ provider: 'qqmusic', providerTrackId: 'song-mid', quality: 'lossless' });

    const losslessBody = JSON.parse(String(fetchRunner.mock.calls[1][1]?.body));
    const highBody = JSON.parse(String(fetchRunner.mock.calls[2][1]?.body));

    expect(losslessBody.req_0.param.filename).toEqual(['F000media-mid.flac']);
    expect(highBody.req_0.param.filename).toEqual(['M800media-mid.mp3']);
    expect(source).toMatchObject({
      url: 'https://isure.stream.qqmusic.qq.com/M800media-mid.mp3?vkey=temporary',
      codec: 'mp3',
      bitrate: 320000,
      bitDepth: null,
    });
  });

  it('exposes account status through provider descriptors', () => {
    accountStatus.connected = false;
    const descriptor = new QQMusicStreamingProvider().descriptor;

    expect(descriptor).toMatchObject({
      requiresAccount: true,
      accountConnected: false,
      status: 'needs_account',
    });
  });
});
