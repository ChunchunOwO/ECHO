// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RemoteSourcesPanel } from './RemoteSourcesPanel';
import type {
  RemoteBackgroundGlobalStatus,
  RemoteBackgroundJobKind,
  RemoteBackgroundJobStatus,
  RemoteSource,
  RemoteSourceOverview,
  RemoteSyncStatus,
} from '../../../shared/types/remoteSources';

const remoteApiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  getOverview: vi.fn(),
  listIssues: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  test: vi.fn(),
  browse: vi.fn(),
  sync: vi.fn(),
  cancelSync: vi.fn(),
  getSyncStatus: vi.fn(),
  createStreamUrl: vi.fn(),
  startBackgroundJobs: vi.fn(),
  pauseBackgroundJobs: vi.fn(),
  resumeBackgroundJobs: vi.fn(),
  getJobStatus: vi.fn(),
  retryFailedJobs: vi.fn(),
  setBackgroundPaused: vi.fn(),
  getBackgroundGlobalStatus: vi.fn(),
  updateRuntimeLimits: vi.fn(),
}));

vi.mock('../../utils/echoBridge', () => ({
  getRemoteSourcesBridge: () => remoteApiMocks,
}));

const jobKinds: RemoteBackgroundJobKind[] = ['metadata', 'cover', 'lyrics', 'mv', 'duration-backfill'];

const remoteSource = (overrides: Partial<RemoteSource> = {}): RemoteSource => ({
  id: 'source-1',
  provider: 'webdav',
  displayName: 'Mock AList',
  status: 'enabled',
  baseUrl: 'http://127.0.0.1:18080/dav',
  username: 'user',
  authType: 'basic',
  config: { rootPath: '/音乐 Space/', scanConcurrency: 2, metadataConcurrency: 1, coverConcurrency: 3 },
  syncMode: 'index',
  lastTestAt: null,
  lastSyncAt: null,
  lastError: null,
  indexedTrackCount: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const syncStatus = (sourceId = 'source-1'): RemoteSyncStatus => ({
  sourceId,
  status: 'idle',
  phase: 'idle',
  discoveredCount: 0,
  parsedCount: 0,
  writtenCount: 0,
  skippedCount: 0,
  missingCount: 0,
  failedCount: 0,
  currentPath: null,
  errors: [],
  startedAt: null,
  finishedAt: null,
});

const jobStatus = (sourceId = 'source-1'): RemoteBackgroundJobStatus => {
  const empty = Object.fromEntries(jobKinds.map((kind) => [kind, 0])) as Record<RemoteBackgroundJobKind, number>;
  return {
    sourceId,
    paused: false,
    concurrency: { metadata: 2, cover: 2, lyrics: 1, mv: 1, 'duration-backfill': 1 },
    pending: empty,
    running: empty,
    completed: empty,
    failed: empty,
    skipped: empty,
    current: [],
    lastError: null,
    updatedAt: null,
  };
};

type GlobalStatusOverrides = Partial<Omit<RemoteBackgroundGlobalStatus, 'concurrency'>> & {
  concurrency?: Partial<Record<RemoteBackgroundJobKind, number>>;
};

const defaultGlobalConcurrency: Record<RemoteBackgroundJobKind, number> = { metadata: 2, cover: 2, lyrics: 1, mv: 1, 'duration-backfill': 1 };

const globalStatus = (overrides: GlobalStatusOverrides = {}): RemoteBackgroundGlobalStatus => ({
  paused: overrides.paused ?? false,
  playbackActive: overrides.playbackActive ?? false,
  concurrency: { ...defaultGlobalConcurrency, ...(overrides.concurrency ?? {}) },
  updatedAt: overrides.updatedAt ?? null,
});

const emptyStatusCounts = () => ({ pending: 0, searching: 0, partial: 0, ok: 0, not_found: 0, error: 0 });

const overviewFor = (items: RemoteSource[]): RemoteSourceOverview => {
  const overviewItems = items.map((source) => ({
    sourceId: source.id,
    provider: source.provider,
    displayName: source.displayName,
    status: source.status,
    syncMode: source.syncMode,
    trackCount: source.indexedTrackCount,
    albumCount: source.indexedTrackCount > 0 ? 1 : 0,
    artistCount: source.indexedTrackCount > 0 ? 1 : 0,
    totalSizeBytes: source.indexedTrackCount * 1024,
    missingTrackCount: 0,
    metadata: { ...emptyStatusCounts(), ok: source.indexedTrackCount },
    cover: { ...emptyStatusCounts(), ok: source.indexedTrackCount },
    lyrics: { ...emptyStatusCounts(), ok: source.indexedTrackCount },
    mv: emptyStatusCounts(),
    lastSyncAt: source.lastSyncAt,
    lastError: source.lastError,
  }));

  return {
    totalSources: overviewItems.length,
    enabledSources: overviewItems.filter((source) => source.status === 'enabled').length,
    disabledSources: overviewItems.filter((source) => source.status === 'disabled').length,
    errorSources: overviewItems.filter((source) => source.status === 'error').length,
    trackCount: overviewItems.reduce((total, source) => total + source.trackCount, 0),
    albumCount: overviewItems.reduce((total, source) => total + source.albumCount, 0),
    artistCount: overviewItems.reduce((total, source) => total + source.artistCount, 0),
    totalSizeBytes: overviewItems.reduce((total, source) => total + source.totalSizeBytes, 0),
    missingTrackCount: overviewItems.reduce((total, source) => total + source.missingTrackCount, 0),
    metadata: { ...emptyStatusCounts(), ok: overviewItems.reduce((total, source) => total + source.metadata.ok, 0) },
    cover: { ...emptyStatusCounts(), ok: overviewItems.reduce((total, source) => total + source.cover.ok, 0) },
    lyrics: { ...emptyStatusCounts(), ok: overviewItems.reduce((total, source) => total + source.lyrics.ok, 0) },
    mv: emptyStatusCounts(),
    sources: overviewItems,
  };
};

describe('RemoteSourcesPanel', () => {
  let sources: RemoteSource[] = [];

  beforeEach(() => {
    sources = [];
    for (const mock of Object.values(remoteApiMocks)) {
      mock.mockReset();
    }
    remoteApiMocks.list.mockImplementation(() => Promise.resolve(sources));
    remoteApiMocks.getOverview.mockImplementation(() => Promise.resolve(overviewFor(sources)));
    remoteApiMocks.listIssues.mockResolvedValue([]);
    remoteApiMocks.create.mockImplementation(async (input) => {
      const source = remoteSource({
        id: 'created-source',
        displayName: input.displayName,
        baseUrl: input.baseUrl,
        username: input.username,
        authType: input.authType,
        config: input.config,
        syncMode: input.syncMode,
      });
      sources = [source];
      return source;
    });
    remoteApiMocks.update.mockImplementation(async (input) => {
      sources = sources.map((source) => (source.id === input.id ? { ...source, ...input } : source));
      return sources.find((source) => source.id === input.id) ?? remoteSource(input);
    });
    remoteApiMocks.delete.mockImplementation(async (sourceId) => {
      sources = sources.filter((source) => source.id !== sourceId);
    });
    remoteApiMocks.test.mockResolvedValue({
      ok: true,
      status: 'enabled',
      message: '连接成功。',
      testedAt: '2026-01-01T00:00:00.000Z',
    });
    remoteApiMocks.browse.mockResolvedValue([
      {
        sourceId: 'source-1',
        provider: 'webdav',
        path: '/音乐 Space/Echo Song.mp3',
        name: 'Echo Song.mp3',
        kind: 'file',
        sizeBytes: 16,
        modifiedAt: null,
        etag: null,
        contentType: 'audio/mpeg',
        audio: true,
      },
    ]);
    remoteApiMocks.sync.mockResolvedValue(syncStatus('created-source'));
    remoteApiMocks.cancelSync.mockResolvedValue(syncStatus());
    remoteApiMocks.getSyncStatus.mockImplementation((sourceId) => Promise.resolve(syncStatus(sourceId)));
    remoteApiMocks.getJobStatus.mockImplementation((sourceId) => Promise.resolve(jobStatus(sourceId)));
    remoteApiMocks.startBackgroundJobs.mockImplementation((sourceId) => Promise.resolve(jobStatus(sourceId)));
    remoteApiMocks.pauseBackgroundJobs.mockImplementation((sourceId) => Promise.resolve(jobStatus(sourceId)));
    remoteApiMocks.resumeBackgroundJobs.mockImplementation((sourceId) => Promise.resolve(jobStatus(sourceId)));
    remoteApiMocks.retryFailedJobs.mockImplementation((sourceId) => Promise.resolve(jobStatus(sourceId)));
    remoteApiMocks.setBackgroundPaused.mockResolvedValue(globalStatus());
    remoteApiMocks.getBackgroundGlobalStatus.mockResolvedValue(globalStatus());
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('tests and saves a WebDAV source with the configured root path', async () => {
    const { container } = render(<RemoteSourcesPanel />);
    await waitFor(() => expect(remoteApiMocks.list).toHaveBeenCalled());

    const inputs = container.querySelectorAll('input');
    fireEvent.change(inputs[0], { target: { value: 'Mock AList' } });
    fireEvent.change(inputs[1], { target: { value: 'http://127.0.0.1:18080/dav' } });
    fireEvent.change(inputs[2], { target: { value: 'user' } });
    fireEvent.change(inputs[3], { target: { value: 'secret' } });
    fireEvent.change(inputs[4], { target: { value: '/音乐 Space/' } });

    fireEvent.click(screen.getByRole('button', { name: /测试连接/u }));
    await waitFor(() => expect(screen.getAllByText(/连接成功/u).length).toBeGreaterThan(0));
    expect(remoteApiMocks.test).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'webdav',
      displayName: 'Mock AList',
      baseUrl: 'http://127.0.0.1:18080/dav',
      username: 'user',
      secret: 'secret',
      config: expect.objectContaining({ rootPath: '/音乐 Space/', coverConcurrency: 2 }),
    }));

    fireEvent.click(screen.getByRole('button', { name: /保存并同步/u }));
    await waitFor(() => expect(remoteApiMocks.create).toHaveBeenCalled());
    expect(remoteApiMocks.sync).toHaveBeenCalledWith('created-source');
  });

  it('submits unauthenticated WebDAV when credentials are blank', async () => {
    const { container } = render(<RemoteSourcesPanel />);
    await waitFor(() => expect(remoteApiMocks.list).toHaveBeenCalled());

    const inputs = container.querySelectorAll('input');
    fireEvent.change(inputs[0], { target: { value: 'Open WebDAV' } });
    fireEvent.change(inputs[1], { target: { value: 'http://127.0.0.1:18080/dav' } });

    fireEvent.click(screen.getByRole('button', { name: /测试连接/u }));
    await waitFor(() => expect(remoteApiMocks.test).toHaveBeenCalled());

    expect(remoteApiMocks.test).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'webdav',
      displayName: 'Open WebDAV',
      baseUrl: 'http://127.0.0.1:18080/dav',
      username: null,
      secret: null,
      authType: 'none',
    }));
  });

  it('keeps Basic WebDAV auth when username has an empty password', async () => {
    const { container } = render(<RemoteSourcesPanel />);
    await waitFor(() => expect(remoteApiMocks.list).toHaveBeenCalled());

    const inputs = container.querySelectorAll('input');
    fireEvent.change(inputs[0], { target: { value: 'Empty Password WebDAV' } });
    fireEvent.change(inputs[1], { target: { value: 'http://127.0.0.1:18080/dav' } });
    fireEvent.change(inputs[2], { target: { value: 'user-no-pass' } });
    fireEvent.change(inputs[3], { target: { value: '' } });

    fireEvent.click(screen.getByRole('button', { name: /测试连接/u }));
    await waitFor(() => expect(remoteApiMocks.test).toHaveBeenCalled());

    expect(remoteApiMocks.test).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'webdav',
      username: 'user-no-pass',
      secret: '',
      authType: 'basic',
    }));
  });

  it('shows browse previews and confirms before deleting an existing source', async () => {
    sources = [remoteSource()];
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<RemoteSourcesPanel />);

    await screen.findByText('Mock AList');
    fireEvent.click(screen.getByRole('button', { name: /^浏览$/u }));
    await screen.findByText('/音乐 Space/Echo Song.mp3');
    expect(remoteApiMocks.browse).toHaveBeenCalledWith('source-1');

    fireEvent.click(screen.getByRole('button', { name: /删除/u }));
    expect(remoteApiMocks.delete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /删除/u }));
    await waitFor(() => expect(remoteApiMocks.delete).toHaveBeenCalledWith('source-1'));
  });

  it('starts a cover scan for missing remote covers', async () => {
    sources = [remoteSource()];
    render(<RemoteSourcesPanel />);

    await screen.findByText('Mock AList');
    expect(remoteApiMocks.list).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /加载封面/u }));

    await waitFor(() => expect(remoteApiMocks.startBackgroundJobs).toHaveBeenCalledWith('source-1', ['cover']));
    await screen.findByText('\u5df2\u52a0\u5165\u4e00\u5c0f\u6279\u7f3a\u5931\u5c01\u9762\u626b\u63cf\u4efb\u52a1\u3002');
    expect(remoteApiMocks.list).toHaveBeenCalledTimes(1);
  });

  it('shows playback low-load status while keeping manual background actions clear', async () => {
    sources = [remoteSource()];
    const status = jobStatus();
    remoteApiMocks.getJobStatus.mockResolvedValue({
      ...status,
      pending: { ...status.pending, cover: 1, lyrics: 1 },
    });
    remoteApiMocks.getBackgroundGlobalStatus.mockResolvedValue(globalStatus({
      playbackActive: true,
      concurrency: { metadata: 1, cover: 0, lyrics: 0, mv: 0, 'duration-backfill': 1 },
    }));
    render(<RemoteSourcesPanel />);

    await screen.findByText('Mock AList');
    expect(screen.getByText('\u4f4e\u8d1f\u8f7d\u8fd0\u884c')).toBeTruthy();
    expect(screen.getByText(/\u64ad\u653e\u4e2d\uff0c\u540e\u53f0\u4efb\u52a1\u5df2\u964d\u4f4e\u8d1f\u8f7d/u)).toBeTruthy();
    expect(screen.getByText(/\u64ad\u653e\u4e2d\uff0c\u5c01\u9762\u548c\u6b4c\u8bcd\u7b49\u540e\u53f0\u4efb\u52a1/u)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /\u52a0\u8f7d\u5c01\u9762/u }));

    await waitFor(() => expect(remoteApiMocks.startBackgroundJobs).toHaveBeenCalledWith('source-1', ['cover']));
    await screen.findByText('\u5df2\u52a0\u5165\u7f3a\u5931\u5c01\u9762\u4efb\u52a1\uff1b\u64ad\u653e\u4e2d\u4f1a\u4fdd\u6301\u4f4e\u8d1f\u8f7d\uff0c\u7a7a\u95f2\u540e\u7ee7\u7eed\u5904\u7406\u3002');
  });

  it('shows remote overview, source recommendations, and issue previews', async () => {
    sources = [remoteSource({ indexedTrackCount: 8 })];
    remoteApiMocks.getOverview.mockResolvedValue({
      ...overviewFor(sources),
      trackCount: 8,
      albumCount: 2,
      artistCount: 3,
      totalSizeBytes: 4096,
      metadata: { ...emptyStatusCounts(), ok: 6, error: 2 },
      sources: [
        {
          ...overviewFor(sources).sources[0],
          trackCount: 8,
          albumCount: 2,
          artistCount: 3,
          totalSizeBytes: 4096,
          metadata: { ...emptyStatusCounts(), ok: 6, error: 2 },
        },
      ],
    });
    remoteApiMocks.listIssues.mockResolvedValue([
      {
        id: 'remote-track-1',
        sourceId: 'source-1',
        provider: 'webdav',
        kind: 'metadata',
        status: 'error',
        title: 'Echo Song',
        artist: 'Echo Artist',
        album: 'Echo Album',
        remotePath: '/music/Echo Song.flac',
        sizeBytes: 4096,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    render(<RemoteSourcesPanel />);

    await screen.findByText('Mock AList');
    expect(screen.getAllByText('已索引歌曲').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/8/u).length).toBeGreaterThan(0);
    expect(screen.getByText(/有 2 首元数据异常/u)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /查看元数据问题/u }));
    await waitFor(() => expect(remoteApiMocks.listIssues).toHaveBeenCalledWith('source-1', 'metadata', 6));
    await screen.findByText('Echo Song');
  });

  it('keeps remote matching and retry actions lightweight', async () => {
    sources = [remoteSource()];
    render(<RemoteSourcesPanel />);

    await screen.findByText('Mock AList');

    fireEvent.click(screen.getByRole('button', { name: /\u5339\u914d\u6b4c\u8bcd/u }));
    await waitFor(() => expect(remoteApiMocks.startBackgroundJobs).toHaveBeenCalledWith('source-1', ['lyrics']));
    await screen.findByText('\u5df2\u52a0\u5165\u4e00\u5c0f\u6279\u6b4c\u8bcd\u5339\u914d\u4efb\u52a1\uff1b\u7f51\u76d8\u6765\u6e90\u4e0d\u518d\u6279\u91cf\u5339\u914d MV\u3002');
    expect(remoteApiMocks.startBackgroundJobs).not.toHaveBeenCalledWith('source-1', ['lyrics', 'mv']);

    fireEvent.click(screen.getByRole('button', { name: /\u4ec5\u91cd\u8bd5\u5931\u8d25\u5143\u6570\u636e/u }));
    await waitFor(() => expect(remoteApiMocks.retryFailedJobs).toHaveBeenCalledWith('source-1', ['metadata', 'duration-backfill']));
    expect(remoteApiMocks.retryFailedJobs).not.toHaveBeenCalledWith('source-1', ['metadata', 'cover', 'lyrics', 'mv', 'duration-backfill']);
  });

  it('marks active, paused, and disabled remote controls visually', async () => {
    sources = [remoteSource({ status: 'disabled' })];
    const status = jobStatus();
    remoteApiMocks.getJobStatus.mockResolvedValue({
      ...status,
      paused: true,
      pending: { ...status.pending, cover: 2 },
    });
    remoteApiMocks.resumeBackgroundJobs.mockResolvedValue({ ...status, paused: false });
    render(<RemoteSourcesPanel />);

    await screen.findByText('Mock AList');
    const coverButton = screen.getByRole('button', { name: /加载封面/u });
    expect(coverButton.getAttribute('data-state')).toBe('active');
    expect(coverButton.getAttribute('aria-pressed')).toBe('true');

    const pauseButton = screen.getByRole('button', { name: /恢复后台任务/u });
    expect(pauseButton.getAttribute('data-state')).toBe('paused');
    fireEvent.click(pauseButton);
    await waitFor(() => expect(remoteApiMocks.resumeBackgroundJobs).toHaveBeenCalledWith('source-1'));

    const enableButton = screen.getByRole('button', { name: /启用/u });
    expect(enableButton.getAttribute('data-state')).toBe('off');
  });

  it('removes a deleted source from local state even if the refresh fails', async () => {
    sources = [remoteSource()];
    remoteApiMocks.list
      .mockImplementationOnce(() => Promise.resolve(sources))
      .mockImplementation(() => Promise.reject(new Error('refresh failed')));
    remoteApiMocks.delete.mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<RemoteSourcesPanel />);

    await screen.findByText('Mock AList');
    fireEvent.click(screen.getByRole('button', { name: /删除/u }));

    await waitFor(() => expect(remoteApiMocks.delete).toHaveBeenCalledWith('source-1'));
    await waitFor(() => expect(screen.queryByText('Mock AList')).toBeNull());
  });
});
