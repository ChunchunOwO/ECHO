import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../database/createDatabase';
import type { EchoDatabase } from '../database/createDatabase';
import type { LibraryTrack } from '../../shared/types/library';
import type { MvMatchCandidate } from '../../shared/types/mv';
import { MvService } from './MvService';
import type { MainMvOnlineProvider, ResolvedMvStreamVariant } from './OnlineMvProviders';

const appSettingsMock = vi.hoisted(() => {
  const defaultValue = {
    mvEnabledProviders: ['bilibili', 'youtube'],
    mvProviderOrder: ['bilibili', 'youtube'],
    mvAutoSearch: true,
    mvAutoPreload: true,
    mvAutoApplyThreshold: 0.7,
    mvImmersiveBackground: true,
    mvImmersiveBackgroundScalePercent: 115,
    mvImmersiveBackgroundOffsetXPercent: 50,
    mvImmersiveBackgroundOffsetYPercent: 50,
    mvMaxQuality: 'max',
    mvAllow60fps: true,
  };

  return {
    defaultValue,
    current: { ...defaultValue },
  };
});

vi.mock('../app/appSettings', () => ({
  getAppSettings: () => appSettingsMock.current,
  setAppSettings: vi.fn((patch: Partial<typeof appSettingsMock.current>) => {
    appSettingsMock.current = { ...appSettingsMock.current, ...patch };
    return appSettingsMock.current;
  }),
}));

const tempRoots: string[] = [];

const makeTempRoot = (): string => {
  const root = join(tmpdir(), `echo-next-mv-service-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  tempRoots.push(root);
  return root;
};

const makeTrack = (path: string, id = 'track-1'): LibraryTrack => ({
  id,
  path,
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
});

const insertTrack = (database: EchoDatabase, track: LibraryTrack): void => {
  const timestamp = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO folders (id, path, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run('folder-1', join(tempRoots[0] ?? tmpdir(), 'Music'), 'Music', timestamp, timestamp);
  database
    .prepare(
      `INSERT INTO tracks (
        id, path, folder_id, size_bytes, mtime_ms, title, artist, album, album_artist,
        track_no, disc_no, year, genre, duration, codec, sample_rate, bit_depth, bitrate,
        cover_id, field_sources_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      track.id,
      track.path,
      'folder-1',
      1,
      1,
      track.title,
      track.artist,
      track.album,
      track.albumArtist,
      track.trackNo,
      track.discNo,
      track.year,
      track.genre,
      track.duration,
      track.codec,
      track.sampleRate,
      track.bitDepth,
      track.bitrate,
      track.coverId,
      '{}',
      timestamp,
      timestamp,
    );
};

const createHarness = (onlineProviders: MainMvOnlineProvider[] = []) => {
  const root = makeTempRoot();
  const audioPath = join(root, 'Echo Song.flac');
  writeFileSync(audioPath, 'audio');
  const track = makeTrack(audioPath);
  const database = createDatabase(':memory:');
  insertTrack(database, track);
  const shellOpener = {
    openPath: vi.fn(async () => ''),
    openExternal: vi.fn(async () => undefined),
  };
  const service = new MvService(database, { getTrack: () => track }, undefined, shellOpener, onlineProviders);

  return { database, root, service, shellOpener, track };
};

afterEach(() => {
  appSettingsMock.current = { ...appSettingsMock.defaultValue };
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

describe('MvService', () => {
  it('bindLocalVideo sets the video as selected', () => {
    const { root, service, track } = createHarness();
    const videoPath = join(root, 'Echo Song.mp4');
    writeFileSync(videoPath, 'video');

    const video = service.bindLocalVideo(track.id, videoPath);

    expect(video.selected).toBe(true);
    expect(service.getSelectedVideo(track.id)?.id).toBe(video.id);
    expect(video.filePath).toBeNull();
  });

  it('selectVideo clears other selected videos for the same track', () => {
    const { root, service, track } = createHarness();
    const firstPath = join(root, 'Echo Song.mp4');
    const secondPath = join(root, 'Echo Artist - Echo Song.webm');
    writeFileSync(firstPath, 'video');
    writeFileSync(secondPath, 'video');
    const first = service.bindLocalVideo(track.id, firstPath);
    const second = service.bindLocalVideo(track.id, secondPath);

    service.selectVideo(track.id, first.id);
    const videos = service.getVideoCandidates(track.id);

    expect(videos.find((video) => video.id === first.id)?.selected).toBe(true);
    expect(videos.find((video) => video.id === second.id)?.selected).toBe(false);
  });

  it('clearSelectedVideo keeps candidates', () => {
    const { root, service, track } = createHarness();
    const videoPath = join(root, 'Echo Song.mp4');
    writeFileSync(videoPath, 'video');
    service.bindLocalVideo(track.id, videoPath);

    service.clearSelectedVideo(track.id);

    expect(service.getSelectedVideo(track.id)).toBeNull();
    expect(service.getVideoCandidates(track.id)).toHaveLength(1);
  });

  it('saves MV offset only on the selected video for the current track', () => {
    const { root, service, track } = createHarness();
    const firstPath = join(root, 'Echo Song.mp4');
    const secondPath = join(root, 'Echo Song Live.mp4');
    writeFileSync(firstPath, 'video');
    writeFileSync(secondPath, 'video');
    const first = service.bindLocalVideo(track.id, firstPath);
    const second = service.bindLocalVideo(track.id, secondPath);

    const updated = service.setVideoOffset(track.id, 750);
    service.selectVideo(track.id, first.id);

    expect(updated?.id).toBe(second.id);
    expect(updated?.offsetMs).toBe(750);
    expect(service.getSelectedVideo(track.id)?.offsetMs).toBe(0);
    expect(service.getVideoCandidates(track.id).find((video) => video.id === second.id)?.offsetMs).toBe(750);
  });

  it('automatically searches and applies a network MV candidate at 70 percent or higher when enabled', async () => {
    const candidate: MvMatchCandidate = {
      id: 'bilibili:BV1auto',
      provider: 'bilibili',
      sourceType: 'search_candidate',
      title: 'Echo Song Official MV',
      artist: 'Echo Artist',
      filePath: null,
      url: 'https://www.bilibili.com/video/BV1auto',
      providerUrl: 'https://www.bilibili.com/video/BV1auto',
      thumbnailUrl: null,
      uploader: 'Echo Channel',
      availableQualities: [],
      durationSeconds: 120,
      score: 0.76,
      playableInApp: true,
      reasons: ['Bilibili search'],
    };
    const provider: MainMvOnlineProvider = {
      id: 'bilibili',
      search: vi.fn(async () => [candidate]),
      resolve: vi.fn(async () => []),
    };
    const { service, track } = createHarness([provider]);

    const selected = await service.getSelectedOrAutoApplyVideo(track.id);

    expect(provider.search).toHaveBeenCalledOnce();
    expect(selected).toMatchObject({
      provider: 'bilibili',
      selected: true,
      title: 'Echo Song Official MV',
    });
    expect(service.getSelectedVideo(track.id)?.id).toBe(selected?.id);
  });

  it('keeps a manually selected search candidate when auto search runs again', async () => {
    const highScoreCandidate: MvMatchCandidate = {
      id: 'bilibili:BV1auto',
      provider: 'bilibili',
      sourceType: 'search_candidate',
      title: 'Echo Song Official MV',
      artist: 'Echo Artist',
      filePath: null,
      url: 'https://www.bilibili.com/video/BV1auto',
      providerUrl: 'https://www.bilibili.com/video/BV1auto',
      thumbnailUrl: null,
      uploader: 'Echo Channel',
      availableQualities: [],
      durationSeconds: 120,
      score: 0.92,
      playableInApp: true,
      reasons: ['Bilibili search'],
    };
    const manualCandidate: MvMatchCandidate = {
      ...highScoreCandidate,
      id: 'bilibili:BV1manual',
      title: 'Echo Song Live MV',
      url: 'https://www.bilibili.com/video/BV1manual',
      providerUrl: 'https://www.bilibili.com/video/BV1manual',
      score: 0.74,
    };
    const provider: MainMvOnlineProvider = {
      id: 'bilibili',
      search: vi.fn(async () => [highScoreCandidate, manualCandidate]),
      resolve: vi.fn(async () => []),
    };
    const { service, track } = createHarness([provider]);
    appSettingsMock.current = { ...appSettingsMock.current, mvAutoSearch: false };

    const candidates = await service.searchNetworkCandidates(track.id);
    const selectedManually = service.selectVideo(track.id, candidates.find((candidate) => candidate.title === 'Echo Song Live MV')!.id);
    appSettingsMock.current = { ...appSettingsMock.current, mvAutoSearch: true };

    await service.searchNetworkCandidates(track.id);

    expect(service.getSelectedVideo(track.id)?.id).toBe(selectedManually.id);
    expect(service.getSelectedVideo(track.id)?.title).toBe('Echo Song Live MV');
  });

  it('does not automatically apply external-only network MV candidates', async () => {
    const candidate: MvMatchCandidate = {
      id: 'youtube:external-only',
      provider: 'youtube',
      sourceType: 'search_candidate',
      title: 'Echo Song Official MV',
      artist: 'Echo Artist',
      filePath: null,
      url: 'https://www.youtube.com/watch?v=external-only',
      providerUrl: 'https://www.youtube.com/watch?v=external-only',
      thumbnailUrl: 'https://i.example/external.jpg',
      uploader: 'Echo Channel',
      availableQualities: [],
      durationSeconds: 120,
      score: 0.98,
      playableInApp: false,
      reasons: ['YouTube Data API'],
    };
    const provider: MainMvOnlineProvider = {
      id: 'youtube',
      search: vi.fn(async () => [candidate]),
      resolve: vi.fn(async () => []),
    };
    const { service, track } = createHarness([provider]);

    await service.searchNetworkCandidates(track.id);

    expect(service.getSelectedVideo(track.id)).toBeNull();
    expect(service.getVideoCandidates(track.id)[0]).toMatchObject({
      provider: 'youtube',
      playableInApp: false,
      selected: false,
    });
  });

  it('prefers an in-app playable candidate over a higher-scoring external candidate when auto applying', async () => {
    const externalCandidate: MvMatchCandidate = {
      id: 'youtube:external-high-score',
      provider: 'youtube',
      sourceType: 'search_candidate',
      title: 'Echo Song Official MV',
      artist: 'Echo Artist',
      filePath: null,
      url: 'https://www.youtube.com/watch?v=external-high-score',
      providerUrl: 'https://www.youtube.com/watch?v=external-high-score',
      thumbnailUrl: null,
      uploader: 'Echo Channel',
      availableQualities: [],
      durationSeconds: 120,
      score: 0.99,
      playableInApp: false,
      reasons: ['YouTube Data API'],
    };
    const playableCandidate: MvMatchCandidate = {
      id: 'bilibili:BV1playable',
      provider: 'bilibili',
      sourceType: 'search_candidate',
      title: 'Echo Song MV',
      artist: 'Echo Artist',
      filePath: null,
      url: 'https://www.bilibili.com/video/BV1playable',
      providerUrl: 'https://www.bilibili.com/video/BV1playable',
      thumbnailUrl: null,
      uploader: 'Echo Channel',
      availableQualities: [],
      durationSeconds: 120,
      score: 0.72,
      playableInApp: true,
      reasons: ['Bilibili search'],
    };
    const bilibiliProvider: MainMvOnlineProvider = {
      id: 'bilibili',
      search: vi.fn(async () => [playableCandidate]),
      resolve: vi.fn(async () => []),
    };
    const youtubeProvider: MainMvOnlineProvider = {
      id: 'youtube',
      search: vi.fn(async () => [externalCandidate]),
      resolve: vi.fn(async () => []),
    };
    const { service, track } = createHarness([bilibiliProvider, youtubeProvider]);

    await service.searchNetworkCandidates(track.id);

    expect(service.getSelectedVideo(track.id)).toMatchObject({
      provider: 'bilibili',
      sourceId: 'BV1playable',
      selected: true,
    });
  });

  it('does not automatically apply an MV candidate below 70 percent', async () => {
    const candidate: MvMatchCandidate = {
      id: 'bilibili:BV1low',
      provider: 'bilibili',
      sourceType: 'search_candidate',
      title: 'Echo Song MV',
      artist: 'Echo Artist',
      filePath: null,
      url: 'https://www.bilibili.com/video/BV1low',
      providerUrl: 'https://www.bilibili.com/video/BV1low',
      thumbnailUrl: null,
      uploader: 'Echo Channel',
      availableQualities: [],
      durationSeconds: 120,
      score: 0.69,
      playableInApp: true,
      reasons: ['Bilibili search'],
    };
    const provider: MainMvOnlineProvider = {
      id: 'bilibili',
      search: vi.fn(async () => [candidate]),
      resolve: vi.fn(async () => []),
    };
    const { service, track } = createHarness([provider]);

    const selected = await service.getSelectedOrAutoApplyVideo(track.id);

    expect(provider.search).toHaveBeenCalledOnce();
    expect(selected).toBeNull();
    expect(service.getSelectedVideo(track.id)).toBeNull();
    expect(service.getVideoCandidates(track.id)[0]).toMatchObject({
      provider: 'bilibili',
      score: 0.69,
      selected: false,
    });
  });

  it('does not search network MV candidates when MV is disabled', async () => {
    const provider: MainMvOnlineProvider = {
      id: 'bilibili',
      search: vi.fn(async () => []),
      resolve: vi.fn(async () => []),
    };
    const { service, track } = createHarness([provider]);

    service.setSettings({ enabled: false });

    await expect(service.searchNetworkCandidates(track.id)).resolves.toEqual([]);
    expect(provider.search).not.toHaveBeenCalled();
  });

  it('uses the configured auto-apply threshold for network MV candidates', async () => {
    const candidate: MvMatchCandidate = {
      id: 'bilibili:BV1threshold',
      provider: 'bilibili',
      sourceType: 'search_candidate',
      title: 'Echo Song MV',
      artist: 'Echo Artist',
      filePath: null,
      url: 'https://www.bilibili.com/video/BV1threshold',
      providerUrl: 'https://www.bilibili.com/video/BV1threshold',
      thumbnailUrl: null,
      uploader: 'Echo Channel',
      availableQualities: [],
      durationSeconds: 120,
      score: 0.82,
      playableInApp: true,
      reasons: ['Bilibili search'],
    };
    const provider: MainMvOnlineProvider = {
      id: 'bilibili',
      search: vi.fn(async () => [candidate]),
      resolve: vi.fn(async () => []),
    };
    const { service, track } = createHarness([provider]);

    service.setSettings({ autoApplyThreshold: 0.85 });
    await service.searchNetworkCandidates(track.id);
    expect(service.getSelectedVideo(track.id)).toBeNull();

    service.setSettings({ autoApplyThreshold: 0.8 });
    await service.searchNetworkCandidates(track.id);
    expect(service.getSelectedVideo(track.id)).toMatchObject({
      provider: 'bilibili',
      score: 0.82,
      selected: true,
    });
  });

  it('returns echo-video mediaUrl only for playable local videos', () => {
    const { root, service, track } = createHarness();
    const videoPath = join(root, 'Echo Song.mp4');
    writeFileSync(videoPath, 'video');

    const video = service.bindLocalVideo(track.id, videoPath);

    expect(video.mediaUrl).toBe(`echo-video://mv/${encodeURIComponent(video.id)}`);
    expect(video.playableInApp).toBe(true);
  });

  it('keeps non-browser-playable videos external only', () => {
    const { root, service, track } = createHarness();
    const videoPath = join(root, 'Echo Song.mkv');
    writeFileSync(videoPath, 'video');

    const video = service.bindLocalVideo(track.id, videoPath);

    expect(video.mediaUrl).toBeNull();
    expect(video.playableInApp).toBe(false);
  });

  it('handles missing selected files without crashing', () => {
    const { root, service, track } = createHarness();
    const videoPath = join(root, 'Echo Song.mp4');
    writeFileSync(videoPath, 'video');
    service.bindLocalVideo(track.id, videoPath);
    rmSync(videoPath, { force: true });

    const selected = service.getSelectedVideo(track.id);

    expect(selected?.mediaUrl).toBeNull();
    expect(selected?.playableInApp).toBe(false);
  });

  it('openExternal calls shell.openPath for local videos', async () => {
    const { root, service, shellOpener, track } = createHarness();
    const videoPath = join(root, 'Echo Song.mkv');
    writeFileSync(videoPath, 'video');
    const video = service.bindLocalVideo(track.id, videoPath);

    await service.openVideoExternal(video.id);

    expect(shellOpener.openPath).toHaveBeenCalledWith(videoPath);
  });

  it('binds a custom Bilibili MV URL as the selected video', () => {
    const { service, track } = createHarness();

    const video = service.bindUrl(track.id, 'https://www.bilibili.com/video/BV1ECHO?p=1');

    expect(video).toMatchObject({
      provider: 'bilibili',
      sourceType: 'manual',
      sourceId: 'BV1ECHO',
      providerUrl: 'https://www.bilibili.com/video/BV1ECHO',
      selected: true,
    });
    expect(service.getSelectedVideo(track.id)?.id).toBe(video.id);
  });

  it('binds a raw Bilibili BV id as the selected video', () => {
    const { service, track } = createHarness();

    const video = service.bindUrl(track.id, 'BV1RAW');

    expect(video.provider).toBe('bilibili');
    expect(video.providerUrl).toBe('https://www.bilibili.com/video/BV1RAW');
    expect(video.selected).toBe(true);
  });

  it('binds a custom YouTube MV URL as an external video', async () => {
    const { service, shellOpener, track } = createHarness();

    const video = service.bindUrl(track.id, 'https://youtu.be/abc123');

    expect(video).toMatchObject({
      provider: 'youtube',
      sourceId: 'abc123',
      providerUrl: 'https://www.youtube.com/watch?v=abc123',
      selected: true,
      playableInApp: false,
    });

    await service.openVideoExternal(video.id);
    expect(shellOpener.openExternal).toHaveBeenCalledWith('https://www.youtube.com/watch?v=abc123');
  });

  it('searches, binds, resolves, and proxies a network MV candidate', async () => {
    const candidate: MvMatchCandidate = {
      id: 'bilibili:BV1echo',
      provider: 'bilibili',
      sourceType: 'search_candidate',
      title: 'Echo Song MV',
      artist: 'Echo Artist',
      filePath: null,
      url: 'https://www.bilibili.com/video/BV1echo',
      providerUrl: 'https://www.bilibili.com/video/BV1echo',
      thumbnailUrl: 'https://i.example/echo.jpg',
      uploader: 'Echo Channel',
      availableQualities: [],
      durationSeconds: 120,
      score: 0.7,
      playableInApp: true,
      reasons: ['Bilibili search'],
    };
    const variants: ResolvedMvStreamVariant[] = [
      {
        id: 'bilibili-qn-64',
        label: '720p',
        qualityTier: '720p',
        width: 1280,
        height: 720,
        fps: null,
        codec: 'avc1',
        container: 'mp4',
        mimeType: 'video/mp4',
        protocol: 'direct',
        playableInApp: true,
        requiresAccount: false,
        expiresAt: null,
        url: 'https://cdn.example/echo-720.mp4',
        headers: { Referer: 'https://www.bilibili.com/video/BV1echo' },
        rawProviderJson: null,
      },
      {
        id: 'bilibili-qn-80',
        label: '1080p',
        qualityTier: '1080p',
        width: 1920,
        height: 1080,
        fps: null,
        codec: 'avc1',
        container: 'mp4',
        mimeType: 'video/mp4',
        protocol: 'direct',
        playableInApp: true,
        requiresAccount: false,
        expiresAt: null,
        url: 'https://cdn.example/echo-1080.mp4',
        headers: { Referer: 'https://www.bilibili.com/video/BV1echo' },
        rawProviderJson: null,
      },
    ];
    const provider: MainMvOnlineProvider = {
      id: 'bilibili',
      search: vi.fn(async () => [candidate]),
      resolve: vi.fn(async () => variants),
    };
    const { service, track } = createHarness([provider]);

    const candidates = await service.searchNetworkCandidates(track.id);
    const selected = service.selectVideo(track.id, candidates[0].id);
    const resolved = await service.resolveStreams(selected.id);

    expect(candidates[0]).toMatchObject({
      provider: 'bilibili',
      filePath: null,
      providerUrl: 'https://www.bilibili.com/video/BV1echo',
    });
    expect(resolved.video.mediaUrl).toBe(`echo-mv://stream/${encodeURIComponent(selected.id)}/bilibili-qn-80`);
    expect(resolved.video.qualityLabel).toBe('1080p');
    expect(resolved.variants).toHaveLength(2);

    const nextQuality = await service.setQuality(selected.id, 'bilibili-qn-64');
    expect(nextQuality.mediaUrl).toBe(`echo-mv://stream/${encodeURIComponent(selected.id)}/bilibili-qn-64`);
    expect(nextQuality.qualityLabel).toBe('720p');

    await expect(service.getStreamVariantForProtocol(selected.id, 'missing')).resolves.toBeNull();
    await expect(service.getStreamVariantForProtocol(selected.id, 'bilibili-qn-64')).resolves.toMatchObject({
      url: 'https://cdn.example/echo-720.mp4',
      headers: { Referer: 'https://www.bilibili.com/video/BV1echo' },
      mimeType: 'video/mp4',
    });
  });

  it('auto-selects Bilibili streams by qn rank before encoded height', async () => {
    const candidate: MvMatchCandidate = {
      id: 'bilibili:BV1echo',
      provider: 'bilibili',
      sourceType: 'search_candidate',
      title: 'Echo Song MV',
      artist: 'Echo Artist',
      filePath: null,
      url: 'https://www.bilibili.com/video/BV1echo',
      providerUrl: 'https://www.bilibili.com/video/BV1echo',
      thumbnailUrl: null,
      uploader: null,
      availableQualities: [],
      durationSeconds: 120,
      score: 0.9,
      playableInApp: true,
      reasons: ['Bilibili search'],
    };
    const variants: ResolvedMvStreamVariant[] = [
      {
        id: 'bilibili-qn-80',
        label: '1080p',
        qualityTier: '1080p',
        width: 1920,
        height: 1080,
        fps: null,
        codec: 'avc1',
        container: 'mp4',
        mimeType: 'video/mp4',
        protocol: 'direct',
        playableInApp: true,
        requiresAccount: false,
        expiresAt: null,
        url: 'https://cdn.example/echo-1080.mp4',
        headers: {},
        rawProviderJson: { provider: 'bilibili', resolver: 'bilibili-dash-video-v3', requestedQn: 116, qn: 80, qualityRank: 2 },
      },
      {
        id: 'bilibili-qn-116',
        label: '1080p 60fps',
        qualityTier: '1080p',
        width: 1920,
        height: 888,
        fps: 60,
        codec: 'avc1',
        container: 'mp4',
        mimeType: 'video/mp4',
        protocol: 'direct',
        playableInApp: true,
        requiresAccount: false,
        expiresAt: null,
        url: 'https://cdn.example/echo-1080-60.mp4',
        headers: {},
        rawProviderJson: { provider: 'bilibili', resolver: 'bilibili-dash-video-v3', requestedQn: 116, qn: 116, qualityRank: 4 },
      },
    ];
    const provider: MainMvOnlineProvider = {
      id: 'bilibili',
      search: vi.fn(async () => [candidate]),
      resolve: vi.fn(async () => variants),
    };
    const { service, track } = createHarness([provider]);

    const [resolvedCandidate] = await service.searchNetworkCandidates(track.id);
    const selected = service.selectVideo(track.id, resolvedCandidate.id);
    const resolved = await service.resolveStreams(selected.id);

    expect(resolved.video.mediaUrl).toBe(`echo-mv://stream/${encodeURIComponent(selected.id)}/bilibili-qn-116`);
    expect(resolved.video.qualityLabel).toBe('1080p 60fps');
    expect(resolved.video.height).toBe(888);
  });

  it('caps Bilibili auto quality at regular 4K when max quality is 2160p', async () => {
    appSettingsMock.current = { ...appSettingsMock.current, mvMaxQuality: '2160p' };
    const candidate: MvMatchCandidate = {
      id: 'bilibili:BV1echo',
      provider: 'bilibili',
      sourceType: 'search_candidate',
      title: 'Echo Song MV',
      artist: 'Echo Artist',
      filePath: null,
      url: 'https://www.bilibili.com/video/BV1echo',
      providerUrl: 'https://www.bilibili.com/video/BV1echo',
      thumbnailUrl: null,
      uploader: null,
      availableQualities: [],
      durationSeconds: 120,
      score: 0.9,
      playableInApp: true,
      reasons: ['Bilibili search'],
    };
    const variants: ResolvedMvStreamVariant[] = [
      {
        id: 'bilibili-qn-126',
        label: 'Dolby Vision',
        qualityTier: '2160p',
        width: 3840,
        height: 2160,
        fps: null,
        codec: 'hev1',
        container: 'mp4',
        mimeType: 'video/mp4',
        protocol: 'direct',
        playableInApp: true,
        requiresAccount: false,
        expiresAt: null,
        url: 'https://cdn.example/echo-dolby.mp4',
        headers: {},
        rawProviderJson: { provider: 'bilibili', resolver: 'bilibili-dash-video-v3', requestedQn: 126, qn: 126, qualityRank: 7 },
      },
      {
        id: 'bilibili-qn-120',
        label: '4K',
        qualityTier: '2160p',
        width: 3840,
        height: 2160,
        fps: null,
        codec: 'hev1',
        container: 'mp4',
        mimeType: 'video/mp4',
        protocol: 'direct',
        playableInApp: true,
        requiresAccount: false,
        expiresAt: null,
        url: 'https://cdn.example/echo-4k.mp4',
        headers: {},
        rawProviderJson: { provider: 'bilibili', resolver: 'bilibili-dash-video-v3', requestedQn: 120, qn: 120, qualityRank: 5 },
      },
    ];
    const provider: MainMvOnlineProvider = {
      id: 'bilibili',
      search: vi.fn(async () => [candidate]),
      resolve: vi.fn(async () => variants),
    };
    const { service, track } = createHarness([provider]);

    const [resolvedCandidate] = await service.searchNetworkCandidates(track.id);
    const selected = service.selectVideo(track.id, resolvedCandidate.id);
    const resolved = await service.resolveStreams(selected.id);

    expect(resolved.video.mediaUrl).toBe(`echo-mv://stream/${encodeURIComponent(selected.id)}/bilibili-qn-120`);
    expect(resolved.video.qualityLabel).toBe('4K');
  });
});
