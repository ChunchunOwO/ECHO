import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AlbumService } from './AlbumService';
import type { LibraryStore } from './LibraryStore';
import { ScanJobQueue } from './ScanJobQueue';
import type {
  CoverExtractOptions,
  CoverResult,
  LibraryFolder,
  LibraryScanStatus,
  MetadataResult,
  ScannedFile,
  ScanJobUpdate,
  StoredTrackCoverState,
  TrackWrite,
} from './libraryTypes';
import type { CoverExtractor } from './workers/CoverExtractor';
import type { FileScanner } from './workers/FileScanner';
import type { MetadataReader } from './workers/MetadataReader';

const tempRoots: string[] = [];

const makeTempRoot = (): string => {
  const root = join(tmpdir(), `echo-next-scan-queue-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  tempRoots.push(root);
  return root;
};

const baseFolder = (root: string): LibraryFolder => ({
  id: 'folder-1',
  path: join(root, 'music'),
  name: 'music',
  status: 'active',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const baseStatus = (folderId: string): LibraryScanStatus => ({
  id: 'job-1',
  folderId,
  status: 'queued',
  phase: 'queued',
  totalFiles: 0,
  processedFiles: 0,
  skippedFiles: 0,
  addedTracks: 0,
  updatedTracks: 0,
  removedTracks: 0,
  coverCount: 0,
  errorCount: 0,
  errors: [],
  startedAt: null,
  finishedAt: null,
});

const metadataResult = (embeddedCover?: Uint8Array): MetadataResult => ({
  fields: {
    title: 'Embedded Title',
    artist: 'Embedded Artist',
    album: 'Embedded Album',
    albumArtist: 'Embedded Artist',
    trackNo: 1,
    discNo: null,
    year: 2024,
    genre: 'Electronic',
    duration: 120,
    codec: 'FLAC',
    sampleRate: 44100,
    bitDepth: 16,
    bitrate: 900000,
  },
  fieldSources: {
    title: 'embedded',
    artist: 'embedded',
    album: 'embedded',
    albumArtist: 'embedded',
    trackNo: 'embedded',
    discNo: 'unknown',
    year: 'embedded',
    genre: 'embedded',
    duration: 'technical',
    codec: 'technical',
    sampleRate: 'technical',
    bitDepth: 'technical',
    bitrate: 'technical',
  },
  embeddedCover: embeddedCover ? { data: embeddedCover, mimeType: 'image/png' } : undefined,
  embeddedMetadataStatus: 'present',
  embeddedCoverStatus: embeddedCover ? 'present' : 'missing',
  warnings: [],
  errors: [],
  status: 'ok',
});

class FakeStore {
  status: LibraryScanStatus | null = null;
  readonly updates: ScanJobUpdate[] = [];
  readonly upsertedTracks: TrackWrite[] = [];
  cancelled = false;

  constructor(private readonly coverState: StoredTrackCoverState | null = null) {}

  createScanJob(folderId: string): LibraryScanStatus {
    this.status = baseStatus(folderId);
    return this.status;
  }

  updateScanJob(_jobId: string, update: ScanJobUpdate): LibraryScanStatus {
    if (!this.status) {
      throw new Error('missing status');
    }

    this.updates.push(update);
    this.status = {
      ...this.status,
      ...update,
      errors: update.errors ?? this.status.errors,
      errorCount: update.errorCount ?? update.errors?.length ?? this.status.errorCount,
      coverCount: update.coverCount ?? this.status.coverCount,
    };
    return this.status;
  }

  getScanJob(): LibraryScanStatus | null {
    return this.status;
  }

  isScanCancelled(): boolean {
    return this.cancelled;
  }

  findTrackCoverState(): StoredTrackCoverState | null {
    return this.coverState;
  }

  transaction<T>(work: () => T): T {
    return work();
  }

  markTracksMissingFromFolder(): number {
    return 0;
  }

  upsertCover(): string {
    return 'cover-1';
  }

  updateTrackCover(): void {}

  upsertTrack(track: TrackWrite): 'added' | 'updated' {
    this.upsertedTracks.push(track);
    return 'added';
  }

  refreshAlbums(): void {}

  refreshArtists(): void {}

  finishFolderScan(): void {}
}

class FakeScanner implements FileScanner {
  constructor(private readonly files: ScannedFile[]) {}

  async *scanFolder(): AsyncIterable<ScannedFile> {
    for (const file of this.files) {
      yield file;
    }
  }
}

class ThrowingScanner implements FileScanner {
  scanFolder(): AsyncIterable<ScannedFile> {
    throw new Error('scanner boom');
  }
}

class FakeMetadataReader implements MetadataReader {
  constructor(private readonly result: MetadataResult = metadataResult()) {}

  async read(): Promise<MetadataResult> {
    return this.result;
  }
}

class CapturingCoverExtractor implements CoverExtractor {
  readonly cacheRoots: string[] = [];
  readonly sawEmbeddedCover: boolean[] = [];

  async extract(_filePath: string, options: CoverExtractOptions): Promise<CoverResult> {
    this.cacheRoots.push(options.cacheRoot);
    this.sawEmbeddedCover.push(Boolean(options.metadata?.embeddedCover));
    return {
      source: options.metadata?.embeddedCover ? 'embedded' : 'default',
      thumbPath: join(options.cacheRoot, 'thumb.webp'),
      albumPath: join(options.cacheRoot, 'album.webp'),
      largePath: join(options.cacheRoot, 'large.webp'),
      originalRef: join(options.cacheRoot, 'original.png'),
      sourceHash: 'cover-hash',
      mimeType: 'image/png',
      warnings: [],
      errors: [],
    };
  }
}

const makeFiles = (root: string, count: number): ScannedFile[] =>
  Array.from({ length: count }, (_, index) => ({
    path: join(root, 'music', `track-${index}.flac`),
    sizeBytes: 10,
    mtimeMs: 1,
  }));

const runQueue = async (
  store: FakeStore,
  scanner: FileScanner,
  metadataReader: MetadataReader,
  coverExtractor: CoverExtractor,
  cacheRoot: string,
  folder: LibraryFolder,
): Promise<LibraryScanStatus> => {
  const queue = new ScanJobQueue(
    store as unknown as LibraryStore,
    scanner,
    metadataReader,
    coverExtractor,
    {} as AlbumService,
    { coverCacheDir: cacheRoot },
  );
  const job = queue.scanFolder(folder);
  await queue.waitForIdle(job.id);
  return store.getScanJob()!;
};

afterEach(() => {
  vi.useRealTimers();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

describe('ScanJobQueue progress and cover memory behavior', () => {
  it('throttles ordinary progress writes for large unchanged scans', async () => {
    const root = makeTempRoot();
    const cacheRoot = join(root, 'custom-cache');
    mkdirSync(cacheRoot, { recursive: true });
    const cachedCover = join(cacheRoot, 'cached.webp');
    writeFileSync(cachedCover, 'cached');
    const store = new FakeStore({
      id: 'track-1',
      sizeBytes: 10,
      mtimeMs: 1,
      coverId: 'cover-1',
      coverSource: 'default',
      sourceHash: 'hash',
      mimeType: 'image/webp',
      thumbPath: cachedCover,
      albumPath: cachedCover,
      largePath: cachedCover,
      originalRef: cachedCover,
    });

    const status = await runQueue(
      store,
      new FakeScanner(makeFiles(root, 1000)),
      new FakeMetadataReader(),
      new CapturingCoverExtractor(),
      cacheRoot,
      baseFolder(root),
    );

    expect(status.status).toBe('completed');
    expect(status.phase).toBe('finished');
    expect(status.processedFiles).toBe(1000);
    expect(status.skippedFiles).toBe(1000);
    expect(store.updates.length).toBeLessThan(100);
    expect(store.updates.map((update) => update.phase)).toEqual(
      expect.arrayContaining(['discovering', 'checking_cache', 'reading_metadata', 'extracting_covers', 'grouping_albums', 'writing_database', 'finished']),
    );
  });

  it('does not keep embedded cover buffers in track writes while preserving embeddedCoverStatus', async () => {
    const root = makeTempRoot();
    const cacheRoot = join(root, 'user-selected-cache');
    const embeddedCover = new Uint8Array([1, 2, 3, 4]);
    const coverExtractor = new CapturingCoverExtractor();
    const store = new FakeStore();

    const status = await runQueue(
      store,
      new FakeScanner(makeFiles(root, 1)),
      new FakeMetadataReader(metadataResult(embeddedCover)),
      coverExtractor,
      cacheRoot,
      baseFolder(root),
    );

    expect(status.status).toBe('completed');
    expect(coverExtractor.sawEmbeddedCover).toEqual([true]);
    expect(coverExtractor.cacheRoots).toEqual([cacheRoot]);
    expect(store.upsertedTracks).toHaveLength(1);
    expect('embeddedCover' in store.upsertedTracks[0]).toBe(false);
    expect(store.upsertedTracks[0].embeddedCoverStatus).toBe('present');
  });

  it('uses an updated custom cover cache directory for later scans', async () => {
    const root = makeTempRoot();
    const initialCacheRoot = join(root, 'initial-cache');
    const updatedCacheRoot = join(root, 'updated-cache');
    const coverExtractor = new CapturingCoverExtractor();
    const store = new FakeStore();
    const queue = new ScanJobQueue(
      store as unknown as LibraryStore,
      new FakeScanner(makeFiles(root, 1)),
      new FakeMetadataReader(),
      coverExtractor,
      {} as AlbumService,
      { coverCacheDir: initialCacheRoot },
    );

    queue.updateCoverCacheDir(updatedCacheRoot);
    const job = queue.scanFolder(baseFolder(root));
    await queue.waitForIdle(job.id);

    expect(coverExtractor.cacheRoots).toEqual([updatedCacheRoot]);
  });

  it('keeps scan job error JSON bounded while preserving total error count', async () => {
    const root = makeTempRoot();
    const noisyMetadata = {
      ...metadataResult(),
      warnings: Array.from({ length: 250 }, (_, index) => `warning-${index}`),
    };
    const store = new FakeStore();

    const status = await runQueue(
      store,
      new FakeScanner(makeFiles(root, 1)),
      new FakeMetadataReader(noisyMetadata),
      new CapturingCoverExtractor(),
      join(root, 'custom-cache'),
      baseFolder(root),
    );

    expect(status.errorCount).toBe(250);
    expect(status.errors).toHaveLength(200);
  });

  it('flushes a final failed state when scanning fails', async () => {
    const root = makeTempRoot();
    const store = new FakeStore();

    const status = await runQueue(
      store,
      new ThrowingScanner(),
      new FakeMetadataReader(),
      new CapturingCoverExtractor(),
      join(root, 'custom-cache'),
      baseFolder(root),
    );

    expect(status.status).toBe('failed');
    expect(status.phase).toBe('failed');
    expect(status.finishedAt).toBeTruthy();
    expect(status.errors[0]).toContain('scanner boom');
  });

  it('flushes a final cancelled state when cancellation is observed', async () => {
    const root = makeTempRoot();
    const store = new FakeStore();
    store.cancelled = true;

    const status = await runQueue(
      store,
      new FakeScanner(makeFiles(root, 1)),
      new FakeMetadataReader(),
      new CapturingCoverExtractor(),
      join(root, 'custom-cache'),
      baseFolder(root),
    );

    expect(status.status).toBe('cancelled');
    expect(status.phase).toBe('cancelled');
    expect(status.finishedAt).toBeTruthy();
  });
});
