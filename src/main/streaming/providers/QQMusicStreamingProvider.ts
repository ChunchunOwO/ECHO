import type { AccountStatus } from '../../../shared/types/accounts';
import type {
  StreamingArtistRef,
  StreamingLyricsResult,
  StreamingMvResult,
  StreamingPlaybackRequest,
  StreamingPlaybackSource,
  StreamingPlaylistDetail,
  StreamingProviderDescriptor,
  StreamingSearchRequest,
  StreamingSearchResult,
  StreamingTrack,
} from '../../../shared/types/streaming';
import { streamingStableKey } from '../../../shared/types/streaming';
import { getAccountService } from '../../accounts/AccountService';
import type { StreamingProvider } from '../StreamingProvider';
import { asRecord, integer, jsonFetch, linesFromLyrics, maybeDecodeBase64, number, splitLyricsByKind, streamingImageProxyUrl, text } from './chinaStreamingUtils';

const provider = 'qqmusic' as const;
const qqReferer = 'https://y.qq.com/';

const qqHeaders = (cookie?: string): Record<string, string> => ({
  Referer: qqReferer,
  Origin: 'https://y.qq.com',
  ...(cookie ? { Cookie: cookie } : {}),
});

const accountStatus = (): AccountStatus => getAccountService().getStatus(provider);

const accountCookie = (): string | undefined => getAccountService().getCredentials(provider).cookie?.trim() || undefined;

const uinFromCookie = (cookie?: string): string => {
  const match = cookie?.match(/(?:^|;\s*)(?:uin|qqmusic_uin)=o?(\d+)/iu);
  return match?.[1] ?? '0';
};

const albumCoverUrl = (albumMid: string | null, size = 300): string | null =>
  albumMid
    ? streamingImageProxyUrl(`https://y.gtimg.cn/music/photo_new/T002R${size}x${size}M000${albumMid}.jpg`, qqReferer)
    : null;

const artistRefs = (singersValue: unknown): StreamingArtistRef[] => {
  const singers = Array.isArray(singersValue) ? singersValue.map(asRecord) : [];
  return singers
    .map((singer): StreamingArtistRef | null => {
      const id = String(singer.mid ?? singer.id ?? text(singer.name) ?? '').trim();
      const name = text(singer.name);
      if (!id || !name) {
        return null;
      }

      return {
        id: streamingStableKey(provider, `artist:${id}`),
        provider,
        providerArtistId: id,
        name,
      };
    })
    .filter((artist): artist is StreamingArtistRef => Boolean(artist));
};

const mapSong = (songValue: unknown): StreamingTrack => {
  const song = asRecord(songValue);
  const album = asRecord(song.album);
  const file = asRecord(song.file);
  const artists = artistRefs(song.singer);
  const mid = text(song.mid) ?? text(song.songmid) ?? text(file.media_mid) ?? String(song.id ?? song.songid ?? text(song.name) ?? text(song.songname) ?? '').trim();
  const title = text(song.name) ?? text(song.title) ?? text(song.songname) ?? text(song.songorig) ?? 'Untitled';
  const artist = artists.map((item) => item.name).join(' / ') || 'Unknown Artist';
  const albumTitle = text(album.name) ?? text(album.title) ?? text(song.albumname) ?? text(song.albumtitle) ?? 'Unknown Album';
  const albumMid = text(album.mid) ?? text(album.pmid) ?? text(song.albummid) ?? text(song.album_mid);
  const pay = asRecord(song.pay);
  const payPlay = integer(pay.payplay);
  const playable = payPlay !== 1 && song.disabled !== true;

  return {
    id: streamingStableKey(provider, mid || title),
    provider,
    providerTrackId: mid || title,
    stableKey: streamingStableKey(provider, mid || title),
    title,
    artist,
    artists,
    album: albumTitle,
    albumId: text(album.mid) ?? (album.id == null ? null : String(album.id)),
    albumArtist: artist,
    duration: number(song.interval),
    coverUrl: albumCoverUrl(albumMid, 500),
    coverThumb: albumCoverUrl(albumMid, 150),
    qualities: payPlay === 1 ? ['standard'] : ['standard', 'high', 'lossless'],
    explicit: false,
    playable,
    unavailableReason: playable ? null : '需要会员或版权不可用',
    lyricsStatus: 'available',
    mvStatus: text(asRecord(song.mv).vid) ? 'available' : 'unknown',
  };
};

const qualityPrefix = (quality: StreamingPlaybackRequest['quality']): { prefix: string; extension: string; codec: string; mimeType: string; bitrate: number } => {
  if (quality === 'lossless' || quality === 'hires') {
    return { prefix: 'F000', extension: 'flac', codec: 'flac', mimeType: 'audio/flac', bitrate: 999000 };
  }
  if (quality === 'standard') {
    return { prefix: 'M500', extension: 'mp3', codec: 'mp3', mimeType: 'audio/mpeg', bitrate: 128000 };
  }

  return { prefix: 'M800', extension: 'mp3', codec: 'mp3', mimeType: 'audio/mpeg', bitrate: 320000 };
};

type QqPlaybackQuality = NonNullable<StreamingPlaybackRequest['quality']>;

const qqPlaybackQualityFallbacks: Record<QqPlaybackQuality | 'fallback', QqPlaybackQuality[]> = {
  hires: ['lossless', 'high', 'standard'],
  lossless: ['lossless', 'high', 'standard'],
  high: ['high', 'standard'],
  standard: ['standard'],
  fallback: ['high', 'standard'],
};

export class QQMusicStreamingProvider implements StreamingProvider {
  readonly name = provider;

  get descriptor(): Omit<StreamingProviderDescriptor, 'name'> {
    const status = accountStatus();
    return {
      displayName: 'QQ 音乐',
      enabled: true,
      supportsSearch: true,
      supportsPlayback: true,
      supportsLyrics: true,
      supportsMv: true,
      requiresAccount: true,
      accountConnected: status.connected,
      accountDisplayName: status.displayName,
      accountUsername: status.username,
      accountAvatarUrl: status.avatarUrl,
      status: status.connected ? 'ready' : 'needs_account',
      statusMessage: status.connected ? '已连接 QQ 音乐账号' : '可搜索公开结果，登录后播放能力更完整',
    };
  }

  async search(request: StreamingSearchRequest): Promise<StreamingSearchResult> {
    const page = Math.max(1, Math.floor(request.page ?? 1));
    const pageSize = Math.min(50, Math.max(1, Math.floor(request.pageSize ?? 20)));
    const body = {
      comm: {
        ct: '19',
        cv: '1859',
        uin: uinFromCookie(accountCookie()),
      },
      req_1: {
        module: 'music.search.SearchCgiService',
        method: 'DoSearchForQQMusicDesktop',
        param: {
          query: request.query,
          page_num: page,
          num_per_page: pageSize,
          search_type: 0,
        },
      },
    };
    const data = asRecord(
      await jsonFetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
        method: 'POST',
        headers: qqHeaders(accountCookie()),
        body,
      }),
    );
    const payload = asRecord(asRecord(data.req_1).data);
    const bodyData = asRecord(payload.body);
    const songData = asRecord(bodyData.song);
    const meta = asRecord(payload.meta);
    const songs = Array.isArray(songData.list) ? songData.list : [];
    const total = integer(songData.totalnum ?? songData.total ?? meta.sum ?? meta.estimate_sum);

    return {
      provider,
      query: request.query,
      page,
      pageSize,
      total,
      hasMore: total ? page * pageSize < total : songs.length === pageSize,
      tracks: songs.map(mapSong),
      albums: [],
      artists: [],
      playlists: [],
      mvs: [],
    };
  }

  async getTrack(input: { providerTrackId: string }): Promise<StreamingTrack> {
    const song = await this.fetchSong(input.providerTrackId);
    return mapSong(song);
  }

  async getPlaylist(input: { providerPlaylistId: string; page?: number; pageSize?: number }): Promise<StreamingPlaylistDetail> {
    const page = Math.max(1, Math.floor(input.page ?? 1));
    const pageSize = Math.min(500, Math.max(1, Math.floor(input.pageSize ?? 100)));
    const begin = (page - 1) * pageSize;
    const params = new URLSearchParams({
      type: '1',
      json: '1',
      utf8: '1',
      onlysong: '0',
      disstid: input.providerPlaylistId,
      format: 'json',
      g_tk: '5381',
      loginUin: uinFromCookie(accountCookie()),
      hostUin: '0',
      inCharset: 'utf8',
      outCharset: 'utf-8',
      notice: '0',
      platform: 'yqq',
      needNewCode: '0',
      song_begin: String(begin),
      song_num: String(pageSize),
    });
    const data = asRecord(
      await jsonFetch(`https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?${params.toString()}`, {
        headers: qqHeaders(accountCookie()),
        timeoutMs: 12_000,
      }),
    );
    const cd = asRecord((Array.isArray(data.cdlist) ? data.cdlist : [])[0]);
    const songlist = Array.isArray(cd.songlist) ? cd.songlist : [];
    const total = integer(cd.total_song_num ?? cd.songnum) ?? songlist.length;
    const logo = text(cd.logo) ?? text(cd.picurl);
    const coverUrl = logo ? streamingImageProxyUrl(logo, qqReferer) : null;

    return {
      id: streamingStableKey(provider, `playlist:${input.providerPlaylistId}`),
      provider,
      providerPlaylistId: input.providerPlaylistId,
      title: text(cd.dissname) ?? 'QQ Music Playlist',
      description: text(cd.desc),
      creator: text(asRecord(cd.headurl).nick) ?? text(cd.nickname),
      coverUrl,
      coverThumb: coverUrl,
      trackCount: total,
      tracks: songlist.map(mapSong),
      page,
      pageSize,
      total,
      hasMore: begin + songlist.length < total,
    };
  }

  async getLyrics(input: { providerTrackId: string }): Promise<StreamingLyricsResult> {
    const params = new URLSearchParams({
      songmid: input.providerTrackId,
      pcachetime: String(Date.now()),
      g_tk: '5381',
      loginUin: uinFromCookie(accountCookie()),
      hostUin: '0',
      format: 'json',
      inCharset: 'utf8',
      outCharset: 'utf-8',
      notice: '0',
      platform: 'yqq',
      needNewCode: '0',
      nobase64: '1',
    });
    const data = asRecord(await jsonFetch(`https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?${params.toString()}`, { headers: qqHeaders(accountCookie()) }));
    const translationLyrics = maybeDecodeBase64(data.trans);
    const romanizationLyrics = maybeDecodeBase64(data.roma);
    const split = splitLyricsByKind(maybeDecodeBase64(data.lyric));
    const lines = linesFromLyrics(split.syncedLyrics, split.plainLyrics, translationLyrics, romanizationLyrics);

    return {
      provider,
      providerTrackId: input.providerTrackId,
      status: split.syncedLyrics || split.plainLyrics || lines.length > 0 ? 'available' : 'missing',
      plainLyrics: split.plainLyrics,
      syncedLyrics: split.syncedLyrics,
      translationLyrics,
      romanizationLyrics,
      lines,
      sourceLabel: 'QQ 音乐',
    };
  }

  async getMv(input: { providerTrackId: string }): Promise<StreamingMvResult> {
    const song = asRecord(await this.fetchSong(input.providerTrackId));
    const track = mapSong(song);
    const mv = asRecord(song.mv);
    const mvId = text(mv.vid);

    if (!mvId) {
      return { provider, providerTrackId: input.providerTrackId, status: 'missing', items: [] };
    }

    return {
      provider,
      providerTrackId: input.providerTrackId,
      status: 'available',
      items: [
        {
          id: streamingStableKey(provider, `mv:${mvId}`),
          provider,
          providerMvId: mvId,
          providerTrackId: input.providerTrackId,
          title: `${track.title} MV`,
          artist: track.artist,
          duration: track.duration,
          thumbnailUrl: track.coverThumb,
        },
      ],
    };
  }

  async resolvePlayback(request: StreamingPlaybackRequest): Promise<StreamingPlaybackSource> {
    const song = asRecord(await this.fetchSong(request.providerTrackId));
    const file = asRecord(song.file);
    const mediaMid = text(file.media_mid) ?? text(file.strMediaMid) ?? request.providerTrackId;
    const cookie = accountCookie();
    const uin = uinFromCookie(cookie);
    const qualities = qqPlaybackQualityFallbacks[request.quality ?? 'fallback'] ?? qqPlaybackQualityFallbacks.fallback;
    let lastItem: Record<string, unknown> = {};

    for (const quality of qualities) {
      const selectedQuality = qualityPrefix(quality);
      const filename = `${selectedQuality.prefix}${mediaMid}.${selectedQuality.extension}`;
      const body = {
        req_0: {
          module: 'vkey.GetVkeyServer',
          method: 'CgiGetVkey',
          param: {
            guid: '10000',
            songmid: [request.providerTrackId],
            filename: [filename],
            songtype: [0],
            uin,
            loginflag: 1,
            platform: '20',
          },
        },
        comm: {
          uin,
          format: 'json',
          ct: 24,
          cv: 0,
        },
      };
      const data = asRecord(
        await jsonFetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
          method: 'POST',
          headers: qqHeaders(cookie),
          body,
        }),
      );
      const payload = asRecord(asRecord(data.req_0).data);
      const item = asRecord((Array.isArray(payload.midurlinfo) ? payload.midurlinfo : [])[0]);
      lastItem = item;
      const purl = text(item.purl);

      if (!purl) {
        continue;
      }

      const sip = Array.isArray(payload.sip) ? payload.sip.map(text).find(Boolean) : null;
      const url = purl.startsWith('http') ? purl : `${sip ?? 'https://isure.stream.qqmusic.qq.com/'}${purl}`;

      return {
        provider,
        providerTrackId: request.providerTrackId,
        url,
        expiresAt: new Date(Date.now() + 4 * 60 * 1000).toISOString(),
        mimeType: selectedQuality.mimeType,
        bitrate: selectedQuality.bitrate,
        sampleRate: null,
        bitDepth: selectedQuality.codec === 'flac' ? 16 : null,
        codec: selectedQuality.codec,
        headers: {},
        requiresProxy: false,
        supportsRange: true,
      };
    }

    const message = text(lastItem.msg) ?? text(lastItem.message);
    throw new Error(message ?? '这首歌暂时不可播放，可能需要会员或版权不可用');
  }

  private async fetchSong(providerTrackId: string): Promise<unknown> {
    const params = new URLSearchParams({
      songmid: providerTrackId,
      tpl: 'yqq_song_detail',
      format: 'json',
    });
    const data = asRecord(await jsonFetch(`https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?${params.toString()}`, { headers: qqHeaders(accountCookie()) }));
    const songs = Array.isArray(data.data) ? data.data : [];
    const song = songs[0];
    if (!song) {
      throw new Error('没有找到这首 QQ 音乐歌曲');
    }

    return song;
  }
}
