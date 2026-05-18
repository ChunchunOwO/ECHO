import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AlbumService } from './AlbumService';
import type { LibraryStore } from './LibraryStore';
import { ScanJobQueue } from './ScanJobQueue';
import type { FileIdentityObservation } from './FileIdentityService';
import type {
  CoverExtractOptions,
  CoverResult,
  LibraryFolder,
  LibraryScanOptions,
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
  readonly identityUpdates: Array<{ trackId: string; identity: Partial<TrackWrite> }> = [];
  readonly missingPaths: string[] = [];
  markMissingCalls = 0;
  refreshAlbumsCalls = 0;
  refreshArtistsCalls = 0;
  finishFolderScanCalls = 0;
  getTrackCacheStatesByFolderCalls = 0;
  findTrackCoverStateCalls = 0;
  cancelled = false;

  constructor(private readonly coverStatesByPath = new Map<string, StoredTrackCoverState>()) {}

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

  getTrackCacheStatesByFolder(): Map<string, StoredTrackCoverState> {
    this.getTrackCacheStatesByFolderCalls += 1;
    return new Map(this.coverStatesByPath);
  }

  findTrackCoverState(filePath: string): StoredTrackCoverState | null {
    this.findTrackCoverStateCalls += 1;
    return this.coverStatesByPath.get(filePath) ?? null;
  }

  transaction<T>(work: () => T): T {
    return work();
  }

  markTracksMissingFromFolder(_folderId: string, discoveredPaths: string[]): number {
    this.markMissingCalls += 1;
    const discovered = new Set(discoveredPaths);
    const missing = Array.from(this.coverStatesByPath.keys()).filter((filePath) => !discovered.has(filePath));
    this.missingPaths.push(...missing);
    return missing.length;
  }

  upsertCover(): string {
    return 'cover-1';
  }

  updateTrackCover(): void {}

  updateTrackIdentity(trackId: string, identity: Partial<TrackWrite>): void {
    this.identityUpdates.push({ trackId, identity });
  }

  upsertTrack(track: TrackWrite): 'added' | 'updated' {
    this.upsertedTracks.push(track);
    return this.coverStatesByPath.has(track.path) ? 'updated' : 'added';
  }

  refreshAlbums(): void {
    this.refreshAlbumsCalls += 1;
  }

  refreshArtists(): void {
    this.refreshArtistsCalls += 1;
  }

  finishFolderScan(): void {
    this.finishFolderScanCalls += 1;
  }
}

class FakeScanner implements FileScanner {
  calls = 0;
  constructor(private readonly files: ScannedFile[]) {}

  async *scanFolder(): AsyncIterable<ScannedFile> {
    this.calls += 1;
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
  readonly paths: string[] = [];

  constructor(private readonly result: MetadataResult = metadataResult()) {}

  async read(filePath: string): Promise<MetadataResult> {
    this.paths.push(filePath);
    return this.result;
  }
}

class CapturingCoverExtractor implements CoverExtractor {
  readonly cacheRoots: string[] = [];
  readonly sawEmbeddedCover: boolean[] = [];
  readonly repairCalls: string[] = [];

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

  async repairCachedCover(options: {
    cacheRoot: string;
    source: CoverResult['source'];
    sourceHash: string;
    mimeType: string | null;
    originalRef: string;
    thumbPath?: string | null;
    albumPath?: string | null;
    largePath?: string | null;
  }): Promise<CoverResult> {
    this.repairCalls.push(options.sourceHash);
    const thumbPath = options.thumbPath ?? join(options.cacheRoot, 'thumb.webp');
    const albumPath = options.albumPath ?? join(options.cacheRoot, 'album.webp');
    const largePath = options.largePath ?? join(options.cacheRoot, 'large.webp');

    writeFileSync(thumbPath, 'thumb');
    writeFileSync(albumPath, 'album');
    writeFileSync(largePath, 'large');

    return {
      source: options.source,
      thumbPath,
      albumPath,
      largePath,
      originalRef: options.originalRef,
      sourceHash: options.sourceHash,
      mimeType: options.mimeType,
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

const coverState = (file: ScannedFile, overrides: Partial<StoredTrackCoverState> = {}): StoredTrackCoverState => ({
  id: `track-${file.path}`,
  sizeBytes: file.sizeBytes,
  mtimeMs: file.mtimeMs,
  coverId: 'cover-1',
  coverSource: 'default',
  sourceHash: 'hash',
  mimeType: 'image/webp',
  thumbPath: null,
  albumPath: null,
  largePath: null,
  originalRef: null,
  cacheVersion: 1,
  ...overrides,
});

const coverStateMap = (files: ScannedFile[], stateForFile: (file: ScannedFile, index: number) => StoredTrackCoverState): Map<string, StoredTrackCoverState> =>
  new Map(files.map((file, index) => [file.path, stateForFile(file, index)]));

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

const statMtimeMs = (filePath: string): number => statSync(filePath).mtimeMs;

const runPathsQueue = async (
  store: FakeStore,
  scanner: FileScanner,
  metadataReader: MetadataReader,
  coverExtractor: CoverExtractor,
  cacheRoot: string,
  folder: LibraryFolder,
  paths: string[],
  options: LibraryScanOptions = {},
): Promise<LibraryScanStatus> => {
  const queue = new ScanJobQueue(
    store as unknown as LibraryStore,
    scanner,
    metadataReader,
    coverExtractor,
    {} as AlbumService,
    { coverCacheDir: cacheRoot },
  );
  const job = queue.scanPaths(folder, paths, options);
  await queue.waitForIdle(job.id);
  return store.getScanJob()!;
};

const identityObservation = (overrides: Partial<FileIdentityObservation> = {}): FileIdentityObservation => ({
  fileIdentity: 'dev:1:ino:2',
  fileIdentitySource: 'posix-dev-ino',
  quickHash: 'a'.repeat(64),
  quickHashVersion: 1,
  identityStatus: 'ok',
  identityUpdatedAt: '2026-05-18T00:00:00.000Z',
  identityError: null,
  ...overrides,
});

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
    const files = makeFiles(root, 1000);
    const store = new FakeStore(
      coverStateMap(files, (file) =>
        coverState(file, {
          thumbPath: cachedCover,
          albumPath: cachedCover,
          largePath: cachedCover,
          originalRef: cachedCover,
        }),
      ),
    );

    const status = await runQueue(
      store,
      new FakeScanner(files),
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
    expect(store.getTrackCacheStatesByFolderCalls).toBe(1);
    expect(store.findTrackCoverStateCalls).toBe(0);
  });

  it('skips metadata parse and cover extraction for unchanged files with complete cover cache', async () => {
    const root = makeTempRoot();
    const cacheRoot = join(root, 'custom-cache');
    mkdirSync(cacheRoot, { recursive: true });
    const cachedCover = join(cacheRoot, 'cached.webp');
    writeFileSync(cachedCover, 'cached');
    const files = makeFiles(root, 2);
    const metadataReader = new FakeMetadataReader();
    const store = new FakeStore(
      coverStateMap(files, (file) =>
        coverState(file, {
          thumbPath: cachedCover,
          albumPath: cachedCover,
          largePath: cachedCover,
          originalRef: cachedCover,
        }),
      ),
    );

    const coverExtractor = new CapturingCoverExtractor();
    const status = await runQueue(
      store,
      new FakeScanner(files),
      metadataReader,
      coverExtractor,
      cacheRoot,
      baseFolder(root),
    );

    expect(status.skippedFiles).toBe(2);
    expect(metadataReader.paths).toEqual([]);
    expect(coverExtractor.cacheRoots).toEqual([]);
    expect(store.upsertedTracks).toEqual([]);
    expect(store.getTrackCacheStatesByFolderCalls).toBe(1);
    expect(store.findTrackCoverStateCalls).toBe(0);
  });

  it.each([
    ['thumb', 'thumbPath'],
    ['album', 'albumPath'],
    ['large', 'largePath'],
  ] as const)('repairs an unchanged track when %s derivative is missing', async (_name, missingKey) => {
    const root = makeTempRoot();
    const cacheRoot = join(root, 'custom-cache');
    mkdirSync(cacheRoot, { recursive: true });
    const files = makeFiles(root, 1);
    const thumbPath = join(cacheRoot, 'thumb.webp');
    const albumPath = join(cacheRoot, 'album.webp');
    const largePath = join(cacheRoot, 'large.webp');
    const originalRef = join(cacheRoot, 'original.png');

    for (const filePath of [thumbPath, albumPath, largePath, originalRef]) {
      writeFileSync(filePath, 'cached');
    }
    rmSync({ thumbPath, albumPath, largePath }[missingKey], { force: true });

    const metadataReader = new FakeMetadataReader();
    const coverExtractor = new CapturingCoverExtractor();
    const store = new FakeStore(
      coverStateMap(files, (file) =>
        coverState(file, {
          coverSource: 'embedded',
          sourceHash: 'repair-hash',
          thumbPath,
          albumPath,
          largePath,
          originalRef,
        }),
      ),
    );

    const status = await runQueue(store, new FakeScanner(files), metadataReader, coverExtractor, cacheRoot, baseFolder(root));

    expect(status.skippedFiles).toBe(0);
    expect(status.updatedTracks).toBe(0);
    expect(metadataReader.paths).toEqual([]);
    expect(coverExtractor.cacheRoots).toEqual([]);
    expect(coverExtractor.repairCalls).toEqual(['repair-hash']);
    expect(store.getTrackCacheStatesByFolderCalls).toBe(1);
    expect(store.findTrackCoverStateCalls).toBe(0);
  });

  it('reads metadata again for changed files', async () => {
    const root = makeTempRoot();
    const [file] = makeFiles(root, 1);
    const changedFile = { ...file, sizeBytes: file.sizeBytes + 1 };
    const metadataReader = new FakeMetadataReader();
    const store = new FakeStore(coverStateMap([file], (item) => coverState(item)));

    const status = await runQueue(
      store,
      new FakeScanner([changedFile]),
      metadataReader,
      new CapturingCoverExtractor(),
      join(root, 'custom-cache'),
      baseFolder(root),
    );

    expect(status.updatedTracks).toBe(1);
    expect(metadataReader.paths).toEqual([changedFile.path]);
    expect(store.upsertedTracks[0]?.id).toBe(store.getTrackCacheStatesByFolder().get(file.path)?.id);
    expect(store.findTrackCoverStateCalls).toBe(0);
  });

  it('adds newly discovered files', async () => {
    const root = makeTempRoot();
    const [file] = makeFiles(root, 1);
    const metadataReader = new FakeMetadataReader();
    const store = new FakeStore();

    const status = await runQueue(
      store,
      new FakeScanner([file]),
      metadataReader,
      new CapturingCoverExtractor(),
      join(root, 'custom-cache'),
      baseFolder(root),
    );

    expect(status.addedTracks).toBe(1);
    expect(metadataReader.paths).toEqual([file.path]);
    expect(store.upsertedTracks[0]?.path).toBe(file.path);
    expect(store.findTrackCoverStateCalls).toBe(0);
  });

  it('marks files missing when they disappear from a scan', async () => {
    const root = makeTempRoot();
    const [keptFile, deletedFile] = makeFiles(root, 2);
    const cacheRoot = join(root, 'custom-cache');
    mkdirSync(cacheRoot, { recursive: true });
    const cachedCover = join(cacheRoot, 'cached.webp');
    writeFileSync(cachedCover, 'cached');
    const metadataReader = new FakeMetadataReader();
    const store = new FakeStore(
      coverStateMap([keptFile, deletedFile], (file) =>
        coverState(file, {
          thumbPath: cachedCover,
          albumPath: cachedCover,
          largePath: cachedCover,
          originalRef: cachedCover,
        }),
      ),
    );

    const status = await runQueue(
      store,
      new FakeScanner([keptFile]),
      metadataReader,
      new CapturingCoverExtractor(),
      cacheRoot,
      baseFolder(root),
    );

    expect(status.removedTracks).toBe(1);
    expect(status.skippedFiles).toBe(1);
    expect(store.missingPaths).toEqual([deletedFile.path]);
    expect(metadataReader.paths).toEqual([]);
    expect(store.getTrackCacheStatesByFolderCalls).toBe(1);
    expect(store.findTrackCoverStateCalls).toBe(0);
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

describe('ScanJobQueue local path rescans', () => {
  it('only processes provided paths without scanning the whole folder', async () => {
    const root = makeTempRoot();
    const folder = baseFolder(root);
    mkdirSync(folder.path, { recursive: true });
    const requestedPath = join(folder.path, 'requested.flac');
    const otherPath = join(folder.path, 'other.flac');
    writeFileSync(requestedPath, 'requested');
    writeFileSync(otherPath, 'other');
    const scanner = new FakeScanner([{ path: otherPath, sizeBytes: 5, mtimeMs: 1 }]);
    const metadataReader = new FakeMetadataReader();
    const store = new FakeStore();

    const status = await runPathsQueue(
      store,
      scanner,
      metadataReader,
      new CapturingCoverExtractor(),
      join(root, 'custom-cache'),
      folder,
      [requestedPath],
    );

    expect(status.status).toBe('completed');
    expect(status.totalFiles).toBe(1);
    expect(status.addedTracks).toBe(1);
    expect(scanner.calls).toBe(0);
    expect(metadataReader.paths).toEqual([requestedPath]);
    expect(store.upsertedTracks.map((track) => track.path)).toEqual([requestedPath]);
  });

  it('does not mark missing tracks during a local path rescan', async () => {
    const root = makeTempRoot();
    const folder = baseFolder(root);
    mkdirSync(folder.path, { recursive: true });
    const keptPath = join(folder.path, 'kept.flac');
    const omittedPath = join(folder.path, 'omitted.flac');
    writeFileSync(keptPath, 'kept');
    const cacheRoot = join(root, 'custom-cache');
    mkdirSync(cacheRoot, { recursive: true });
    const cachedCover = join(cacheRoot, 'cached.webp');
    writeFileSync(cachedCover, 'cached');
    const keptFile = { path: keptPath, sizeBytes: 4, mtimeMs: Math.round(statMtimeMs(keptPath)) };
    const omittedFile = { path: omittedPath, sizeBytes: 10, mtimeMs: 1 };
    const store = new FakeStore(
      coverStateMap([keptFile, omittedFile], (file) =>
        coverState(file, {
          thumbPath: cachedCover,
          albumPath: cachedCover,
          largePath: cachedCover,
          originalRef: cachedCover,
        }),
      ),
    );

    const status = await runPathsQueue(
      store,
      new FakeScanner([]),
      new FakeMetadataReader(),
      new CapturingCoverExtractor(),
      cacheRoot,
      folder,
      [keptPath],
    );

    expect(status.removedTracks).toBe(0);
    expect(store.markMissingCalls).toBe(0);
    expect(store.missingPaths).toEqual([]);
    expect(store.finishFolderScanCalls).toBe(0);
  });

  it('can defer grouping refresh for live local path rescans', async () => {
    const root = makeTempRoot();
    const folder = baseFolder(root);
    mkdirSync(folder.path, { recursive: true });
    const filePath = join(folder.path, 'live.flac');
    writeFileSync(filePath, 'live');
    const cacheRoot = join(root, 'custom-cache');
    mkdirSync(cacheRoot, { recursive: true });
    const store = new FakeStore();

    await runPathsQueue(
      store,
      new FakeScanner([]),
      new FakeMetadataReader(),
      new CapturingCoverExtractor(),
      cacheRoot,
      folder,
      [filePath],
      { deferGroupingRefresh: true },
    );

    expect(store.upsertedTracks.map((track) => track.path)).toEqual([filePath]);
    expect(store.refreshAlbumsCalls).toBe(0);
    expect(store.refreshArtistsCalls).toBe(0);
  });

  it('skips unchanged local files with complete cover cache', async () => {
    const root = makeTempRoot();
    const folder = baseFolder(root);
    mkdirSync(folder.path, { recursive: true });
    const filePath = join(folder.path, 'cached.flac');
    writeFileSync(filePath, 'cached');
    const cacheRoot = join(root, 'custom-cache');
    mkdirSync(cacheRoot, { recursive: true });
    const cachedCover = join(cacheRoot, 'cached.webp');
    writeFileSync(cachedCover, 'cached');
    const file = { path: filePath, sizeBytes: 6, mtimeMs: Math.round(statMtimeMs(filePath)) };
    const metadataReader = new FakeMetadataReader();
    const coverExtractor = new CapturingCoverExtractor();
    const store = new FakeStore(
      coverStateMap([file], (item) =>
        coverState(item, {
          thumbPath: cachedCover,
          albumPath: cachedCover,
          largePath: cachedCover,
          originalRef: cachedCover,
        }),
      ),
    );

    const status = await runPathsQueue(store, new FakeScanner([]), metadataReader, coverExtractor, cacheRoot, folder, [filePath]);

    expect(status.skippedFiles).toBe(1);
    expect(metadataReader.paths).toEqual([]);
    expect(coverExtractor.cacheRoots).toEqual([]);
    expect(store.upsertedTracks).toEqual([]);
  });

  it('rereads unchanged placeholder tracks created by watcher preview', async () => {
    const root = makeTempRoot();
    const folder = baseFolder(root);
    mkdirSync(folder.path, { recursive: true });
    const filePath = join(folder.path, 'previewed.flac');
    writeFileSync(filePath, 'previewed');
    const cacheRoot = join(root, 'custom-cache');
    mkdirSync(cacheRoot, { recursive: true });
    const cachedCover = join(cacheRoot, 'cached.webp');
    writeFileSync(cachedCover, 'cached');
    const file = { path: filePath, sizeBytes: 9, mtimeMs: Math.round(statMtimeMs(filePath)) };
    const metadataReader = new FakeMetadataReader();
    const coverExtractor = new CapturingCoverExtractor();
    const store = new FakeStore(
      coverStateMap([file], (item) =>
        coverState(item, {
          metadataStatus: 'fallback',
          embeddedMetadataStatus: 'pending',
          embeddedCoverStatus: 'pending',
          thumbPath: cachedCover,
          albumPath: cachedCover,
          largePath: cachedCover,
          originalRef: cachedCover,
        }),
      ),
    );

    const status = await runPathsQueue(store, new FakeScanner([]), metadataReader, coverExtractor, cacheRoot, folder, [filePath]);

    expect(status.updatedTracks).toBe(1);
    expect(metadataReader.paths).toEqual([filePath]);
    expect(store.upsertedTracks[0]).toMatchObject({
      path: filePath,
      title: 'Embedded Title',
      metadataStatus: 'ok',
      embeddedMetadataStatus: 'present',
    });
  });

  it('adds new local files through metadata and cover workers', async () => {
    const root = makeTempRoot();
    const folder = baseFolder(root);
    mkdirSync(folder.path, { recursive: true });
    const filePath = join(folder.path, 'new-song.wav');
    writeFileSync(filePath, 'new-song');
    const metadataReader = new FakeMetadataReader();
    const coverExtractor = new CapturingCoverExtractor();
    const store = new FakeStore();

    const status = await runPathsQueue(
      store,
      new FakeScanner([]),
      metadataReader,
      coverExtractor,
      join(root, 'custom-cache'),
      folder,
      [filePath],
    );

    expect(status.addedTracks).toBe(1);
    expect(metadataReader.paths).toEqual([filePath]);
    expect(coverExtractor.cacheRoots).toHaveLength(1);
    expect(store.upsertedTracks[0]?.path).toBe(filePath);
  });

  it('refreshes changed local files when size or mtime differs', async () => {
    const root = makeTempRoot();
    const folder = baseFolder(root);
    mkdirSync(folder.path, { recursive: true });
    const filePath = join(folder.path, 'changed.flac');
    writeFileSync(filePath, 'changed-now');
    const currentFile = { path: filePath, sizeBytes: 11, mtimeMs: Math.round(statMtimeMs(filePath)) };
    const previousFile = { ...currentFile, sizeBytes: 1 };
    const metadataReader = new FakeMetadataReader();
    const store = new FakeStore(coverStateMap([previousFile], (item) => coverState(item)));

    const status = await runPathsQueue(
      store,
      new FakeScanner([]),
      metadataReader,
      new CapturingCoverExtractor(),
      join(root, 'custom-cache'),
      folder,
      [filePath],
    );

    expect(status.updatedTracks).toBe(1);
    expect(metadataReader.paths).toEqual([filePath]);
    expect(store.upsertedTracks[0]?.id).toBe(store.getTrackCacheStatesByFolder().get(filePath)?.id);
  });

  it('ignores non-audio, temporary, outside, and duplicate paths', async () => {
    const root = makeTempRoot();
    const folder = baseFolder(root);
    mkdirSync(folder.path, { recursive: true });
    const outsideRoot = join(root, 'outside');
    mkdirSync(outsideRoot, { recursive: true });
    const validPath = join(folder.path, 'valid.mp3');
    const duplicatePath = join(folder.path, '.', 'valid.mp3');
    const textPath = join(folder.path, 'notes.txt');
    const tempPath = join(folder.path, 'song.flac.tmp');
    const hiddenPath = join(folder.path, '.hidden.flac');
    const outsidePath = join(outsideRoot, 'outside.flac');
    for (const filePath of [validPath, textPath, tempPath, hiddenPath, outsidePath]) {
      writeFileSync(filePath, 'x');
    }
    const metadataReader = new FakeMetadataReader();
    const store = new FakeStore();

    const status = await runPathsQueue(
      store,
      new FakeScanner([]),
      metadataReader,
      new CapturingCoverExtractor(),
      join(root, 'custom-cache'),
      folder,
      [validPath, duplicatePath, textPath, tempPath, hiddenPath, outsidePath, join(folder.path, 'missing.flac')],
    );

    expect(status.totalFiles).toBe(1);
    expect(status.addedTracks).toBe(1);
    expect(metadataReader.paths).toEqual([validPath]);
    expect(store.upsertedTracks.map((track) => track.path)).toEqual([validPath]);
  });

  it('rejects overly large local rescan batches before creating a job', () => {
    const root = makeTempRoot();
    const folder = baseFolder(root);
    const store = new FakeStore();
    const queue = new ScanJobQueue(
      store as unknown as LibraryStore,
      new FakeScanner([]),
      new FakeMetadataReader(),
      new CapturingCoverExtractor(),
      {} as AlbumService,
      { coverCacheDir: join(root, 'custom-cache') },
    );

    expect(() => queue.scanPaths(folder, Array.from({ length: 1001 }, (_, index) => join(folder.path, `track-${index}.flac`)))).toThrow(
      /Too many local rescan paths/u,
    );
    expect(store.status).toBeNull();
  });

  it('keeps cancellation semantics for local path rescans', async () => {
    const root = makeTempRoot();
    const folder = baseFolder(root);
    mkdirSync(folder.path, { recursive: true });
    const filePath = join(folder.path, 'cancel.flac');
    writeFileSync(filePath, 'cancel');
    const store = new FakeStore();
    store.cancelled = true;

    const status = await runPathsQueue(
      store,
      new FakeScanner([]),
      new FakeMetadataReader(),
      new CapturingCoverExtractor(),
      join(root, 'custom-cache'),
      folder,
      [filePath],
    );

    expect(status.status).toBe('cancelled');
    expect(status.phase).toBe('cancelled');
    expect(store.upsertedTracks).toEqual([]);
  });

  it('writes identity observation for changed files without changing scan semantics', async () => {
    const root = makeTempRoot();
    const folder = baseFolder(root);
    mkdirSync(folder.path, { recursive: true });
    const filePath = join(folder.path, 'identity.flac');
    writeFileSync(filePath, 'identity');
    const store = new FakeStore();
    const queue = new ScanJobQueue(
      store as unknown as LibraryStore,
      new FakeScanner([]),
      new FakeMetadataReader(),
      new CapturingCoverExtractor(),
      {} as AlbumService,
      {
        coverCacheDir: join(root, 'custom-cache'),
        fileIdentityService: { observe: () => identityObservation({ quickHash: 'b'.repeat(64) }) } as never,
      },
    );

    const job = queue.scanPaths(folder, [filePath]);
    await queue.waitForIdle(job.id);

    expect(store.getScanJob()?.status).toBe('completed');
    expect(store.upsertedTracks[0]).toMatchObject({
      fileIdentity: 'dev:1:ino:2',
      quickHash: 'b'.repeat(64),
      identityStatus: 'ok',
    });
  });

  it('backfills identity for unchanged files without reading metadata or cover', async () => {
    const root = makeTempRoot();
    const folder = baseFolder(root);
    mkdirSync(folder.path, { recursive: true });
    const filePath = join(folder.path, 'unchanged.flac');
    writeFileSync(filePath, 'cached');
    const cacheRoot = join(root, 'custom-cache');
    mkdirSync(cacheRoot, { recursive: true });
    const cachedCover = join(cacheRoot, 'cached.webp');
    writeFileSync(cachedCover, 'cached');
    const file = { path: filePath, sizeBytes: 6, mtimeMs: Math.round(statMtimeMs(filePath)) };
    const metadataReader = new FakeMetadataReader();
    const coverExtractor = new CapturingCoverExtractor();
    const store = new FakeStore(
      coverStateMap([file], (item) =>
        coverState(item, {
          thumbPath: cachedCover,
          albumPath: cachedCover,
          largePath: cachedCover,
          originalRef: cachedCover,
          quickHash: null,
          identityStatus: null,
        }),
      ),
    );
    const queue = new ScanJobQueue(
      store as unknown as LibraryStore,
      new FakeScanner([]),
      metadataReader,
      coverExtractor,
      {} as AlbumService,
      {
        coverCacheDir: cacheRoot,
        fileIdentityService: { observe: () => identityObservation({ quickHash: 'c'.repeat(64) }) } as never,
      },
    );

    const job = queue.scanPaths(folder, [filePath]);
    await queue.waitForIdle(job.id);

    expect(store.getScanJob()?.skippedFiles).toBe(1);
    expect(metadataReader.paths).toEqual([]);
    expect(coverExtractor.cacheRoots).toEqual([]);
    expect(store.identityUpdates).toHaveLength(1);
    expect(store.identityUpdates[0].identity.quickHash).toBe('c'.repeat(64));
  });

  it('identity observation errors do not fail scan jobs', async () => {
    const root = makeTempRoot();
    const folder = baseFolder(root);
    mkdirSync(folder.path, { recursive: true });
    const filePath = join(folder.path, 'identity-error.flac');
    writeFileSync(filePath, 'identity-error');
    const store = new FakeStore();
    const queue = new ScanJobQueue(
      store as unknown as LibraryStore,
      new FakeScanner([]),
      new FakeMetadataReader(),
      new CapturingCoverExtractor(),
      {} as AlbumService,
      {
        coverCacheDir: join(root, 'custom-cache'),
        fileIdentityService: {
          observe: () => {
            throw new Error('identity boom');
          },
        } as never,
      },
    );

    const job = queue.scanPaths(folder, [filePath]);
    await queue.waitForIdle(job.id);

    expect(store.getScanJob()?.status).toBe('completed');
    expect(store.upsertedTracks[0]).toMatchObject({
      identityStatus: 'error',
      identityError: 'identity boom',
    });
  });

  it('unsupported identity observations do not fail scans', async () => {
    const root = makeTempRoot();
    const folder = baseFolder(root);
    mkdirSync(folder.path, { recursive: true });
    const filePath = join(folder.path, 'identity-unsupported.flac');
    writeFileSync(filePath, 'identity-unsupported');
    const store = new FakeStore();
    const queue = new ScanJobQueue(
      store as unknown as LibraryStore,
      new FakeScanner([]),
      new FakeMetadataReader(),
      new CapturingCoverExtractor(),
      {} as AlbumService,
      {
        coverCacheDir: join(root, 'custom-cache'),
        fileIdentityService: {
          observe: () =>
            identityObservation({
              fileIdentity: null,
              fileIdentitySource: 'unsupported',
              identityStatus: 'partial',
              identityError: 'unsupported',
            }),
        } as never,
      },
    );

    const job = queue.scanPaths(folder, [filePath]);
    await queue.waitForIdle(job.id);

    expect(store.getScanJob()?.status).toBe('completed');
    expect(store.upsertedTracks[0]).toMatchObject({
      fileIdentity: null,
      fileIdentitySource: 'unsupported',
      identityStatus: 'partial',
    });
  });
});
