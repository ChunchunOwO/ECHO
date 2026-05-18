import { afterEach, describe, expect, it, vi } from 'vitest';
import { LibraryService } from './LibraryService';
import type { LibraryDiagnostics } from './libraryTypes';

let playbackState: 'idle' | 'loading' | 'playing' | 'paused' | 'stopped' = 'idle';

vi.mock('../audio/AudioSession', () => ({
  getAudioSession: () => ({
    getStatus: () => ({
      state: playbackState,
      currentFilePath: null,
    }),
  }),
}));

class FakeStore {
  refreshAlbumsCalls = 0;
  refreshArtistsCalls = 0;
  markMissingCalls = 0;
  shouldThrowRefresh = false;

  transaction<T>(work: () => T): T {
    return work();
  }

  refreshAlbums(): void {
    this.refreshAlbumsCalls += 1;
    if (this.shouldThrowRefresh) {
      throw new Error('grouping failed');
    }
  }

  refreshArtists(): void {
    this.refreshArtistsCalls += 1;
  }

  getArtists(): { items: unknown[]; page: number; pageSize: number; total: number; hasMore: boolean } {
    return {
      items: [],
      page: 1,
      pageSize: 100,
      total: 0,
      hasMore: false,
    };
  }

  markTracksMissingByPaths(): number {
    this.markMissingCalls += 1;
    return 1;
  }

  getDiagnostics(): LibraryDiagnostics {
    return {
      foldersCount: 0,
      tracksCount: 0,
      albumsCount: 0,
      artistsCount: 0,
      coversCount: 0,
      lastScan: null,
      lastQueryMs: { getTracks: null, getAlbums: null },
      averageAlbumPayloadBytes: null,
      databasePath: null,
      databaseSizeBytes: null,
      coverCachePath: null,
      coverCacheSizeBytes: null,
      coverCacheVersion: 0,
      cpuCount: 1,
      scanPerformanceMode: 'balanced',
      metadataConcurrency: 1,
      coverConcurrency: 1,
    };
  }
}

const createService = (store = new FakeStore()): LibraryService =>
  new LibraryService(
    store as never,
    { hasRunningJobs: () => false } as never,
    {} as never,
    {
      prepare: () => ({
        all: () => [],
        get: () => null,
        run: () => ({ changes: 0 }),
      }),
    } as never,
    () => undefined,
    'test.sqlite',
    'covers',
    {} as never,
    {} as never,
    null,
    null,
    null,
    null,
    () =>
      ({
        albumMergeStrategy: 'standard',
        liveLibraryAutoHideDeletedEnabled: true,
        autoFetchArtistImages: false,
        audioAnalysisEnabled: true,
      }) as never,
    {
      cpuCount: 1,
      mode: 'balanced',
      metadataConcurrency: 1,
      coverConcurrency: 1,
    },
  );

afterEach(() => {
  vi.useRealTimers();
  playbackState = 'idle';
});

describe('LibraryService grouping refresh scheduling', () => {
  it('defers grouping refresh while playback is active and runs once after playback stops', async () => {
    const store = new FakeStore();
    const service = createService(store);
    const scheduled = service as unknown as {
      groupingRefreshQueued: boolean;
      runScheduledGroupingRefresh: () => Promise<void>;
      close: () => void;
    };

    playbackState = 'playing';
    scheduled.groupingRefreshQueued = true;
    await scheduled.runScheduledGroupingRefresh();

    expect(store.refreshAlbumsCalls).toBe(0);
    expect(store.refreshArtistsCalls).toBe(0);
    expect(service.getDiagnostics().groupingRefreshQueued).toBe(true);
    expect(service.getDiagnostics().groupingRefreshDelayedForPlaybackCount).toBe(1);

    playbackState = 'stopped';
    await scheduled.runScheduledGroupingRefresh();

    expect(store.refreshAlbumsCalls).toBe(1);
    expect(store.refreshArtistsCalls).toBe(1);
    expect(service.getDiagnostics().groupingRefreshQueued).toBe(false);
    expect(service.getDiagnostics().lastGroupingRefreshDurationMs).not.toBeNull();
    expect(service.getDiagnostics().lastGroupingRefreshAt).not.toBeNull();
    expect(service.getDiagnostics().lastGroupingRefreshError).toBeNull();
    scheduled.close();
  });

  it('coalesces repeated grouping refresh requests into one refresh', async () => {
    const store = new FakeStore();
    const service = createService(store);
    const scheduled = service as unknown as {
      groupingRefreshQueued: boolean;
      runScheduledGroupingRefresh: () => Promise<void>;
      close: () => void;
    };

    scheduled.groupingRefreshQueued = true;
    scheduled.groupingRefreshQueued = true;
    await scheduled.runScheduledGroupingRefresh();

    expect(store.refreshAlbumsCalls).toBe(1);
    expect(store.refreshArtistsCalls).toBe(1);
    scheduled.close();
  });

  it('records grouping refresh errors in diagnostics', async () => {
    const store = new FakeStore();
    store.shouldThrowRefresh = true;
    const service = createService(store);
    const scheduled = service as unknown as {
      groupingRefreshQueued: boolean;
      runScheduledGroupingRefresh: () => Promise<void>;
      close: () => void;
    };

    scheduled.groupingRefreshQueued = true;
    await scheduled.runScheduledGroupingRefresh();

    expect(service.getDiagnostics().lastGroupingRefreshError).toBe('grouping failed');
    expect(service.getDiagnostics().lastGroupingRefreshDurationMs).not.toBeNull();
    scheduled.close();
  });

  it('marks missing paths without immediately rebuilding grouping indexes', () => {
    const store = new FakeStore();
    const service = createService(store);

    const changed = (service as unknown as { markMissingPathsFromWatcher: (folderId: string, paths: string[]) => number })
      .markMissingPathsFromWatcher('folder-1', ['D:\\Music\\deleted.flac']);

    expect(changed).toBe(1);
    expect(store.markMissingCalls).toBe(1);
    expect(store.refreshAlbumsCalls).toBe(0);
    expect(store.refreshArtistsCalls).toBe(0);
    expect(service.getDiagnostics().groupingRefreshQueued).toBe(true);
    service.close();
  });

  it('does not force an artist rebuild while a grouping refresh is already queued', () => {
    const store = new FakeStore();
    const service = createService(store);
    const scheduled = service as unknown as {
      markMissingPathsFromWatcher: (folderId: string, paths: string[]) => number;
      close: () => void;
    };

    scheduled.markMissingPathsFromWatcher('folder-1', ['D:\\Music\\deleted.flac']);
    service.getArtists({ pageSize: 10 });

    expect(store.refreshArtistsCalls).toBe(0);
    expect(service.getDiagnostics().groupingRefreshQueued).toBe(true);
    scheduled.close();
  });
});
