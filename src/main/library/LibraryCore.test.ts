import { existsSync, mkdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../database/createDatabase';
import { MetadataService } from './MetadataService';
import { createLibraryService } from './LibraryService';
import type {
  CoverCacheRepairOptions,
  CoverExtractOptions,
  CoverResult,
  MetadataResult,
  ParsedTrackMetadata,
  ScannedAudioFile,
  ScannedFile,
} from './libraryTypes';
import type { CoverExtractor } from './workers/CoverExtractor';
import type { FileScanner } from './workers/FileScanner';
import type { MetadataReader } from './workers/MetadataReader';

const tempRoots: string[] = [];
const cleanupCallbacks: Array<() => void> = [];

const makeTempRoot = (): string => {
  const root = join(tmpdir(), `echo-next-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  tempRoots.push(root);
  return root;
};

const writeAudioFile = (folder: string, name: string, mtime = new Date('2024-01-01T00:00:00.000Z')): string => {
  const filePath = join(folder, name);
  writeFileSync(filePath, `fake audio ${name}`);
  utimesSync(filePath, mtime, mtime);
  return filePath;
};

const validCoverPng = (): Uint8Array =>
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
    'base64',
  );

const baseMetadata = (overrides: Partial<ParsedTrackMetadata> = {}): ParsedTrackMetadata => ({
  title: 'Embedded Title',
  artist: 'Embedded Artist',
  album: 'Embedded Album',
  albumArtist: 'Embedded Album Artist',
  trackNo: 1,
  discNo: 1,
  year: 2024,
  genre: 'Electronic',
  duration: 180,
  codec: 'FLAC',
  sampleRate: 96000,
  bitDepth: 24,
  bitrate: 1600000,
  fieldSources: {
    title: 'embedded',
    artist: 'embedded',
    album: 'embedded',
    albumArtist: 'embedded',
    trackNo: 'embedded',
    discNo: 'embedded',
    year: 'embedded',
    genre: 'embedded',
    duration: 'technical',
    codec: 'technical',
    sampleRate: 'technical',
    bitDepth: 'technical',
    bitrate: 'technical',
  },
  ...overrides,
});

const metadataWithSources = (
  overrides: Partial<ParsedTrackMetadata>,
  fieldSources: Partial<ParsedTrackMetadata['fieldSources']>,
): ParsedTrackMetadata => {
  const mergedSources = { ...baseMetadata().fieldSources };
  for (const [key, value] of Object.entries(fieldSources)) {
    if (value) {
      mergedSources[key] = value;
    }
  }

  return baseMetadata({ ...overrides, fieldSources: mergedSources });
};

class MockMetadataService extends MetadataService {
  readonly calls: string[] = [];
  readonly overrides = new Map<string, Partial<ParsedTrackMetadata>>();
  readonly failures = new Set<string>();

  async read(file: ScannedAudioFile): Promise<ParsedTrackMetadata> {
    this.calls.push(file.path);
    if (this.failures.has(file.path)) {
      throw new Error('metadata boom');
    }

    return baseMetadata(this.overrides.get(file.path));
  }
}

const metadataResult = (overrides: Partial<ParsedTrackMetadata> = {}, extras: Partial<MetadataResult> = {}): MetadataResult => {
  const metadata = baseMetadata(overrides);

  return {
    fields: {
      title: metadata.title,
      artist: metadata.artist,
      album: metadata.album,
      albumArtist: metadata.albumArtist,
      trackNo: metadata.trackNo,
      discNo: metadata.discNo,
      year: metadata.year,
      genre: metadata.genre,
      duration: metadata.duration,
      codec: metadata.codec,
      sampleRate: metadata.sampleRate,
      bitDepth: metadata.bitDepth,
      bitrate: metadata.bitrate,
    },
    fieldSources: metadata.fieldSources,
    embeddedCover: metadata.embeddedCover,
    embeddedMetadataStatus: metadata.embeddedMetadataStatus ?? 'present',
    embeddedCoverStatus: metadata.embeddedCoverStatus ?? (metadata.embeddedCover ? 'present' : 'missing'),
    warnings: [],
    errors: [],
    status: 'ok',
    ...extras,
  };
};

class FakeMetadataReader implements MetadataReader {
  readonly calls: string[] = [];

  constructor(private readonly result: MetadataResult = metadataResult()) {}

  async read(filePath: string): Promise<MetadataResult> {
    this.calls.push(filePath);
    return this.result;
  }
}

class FakeCoverExtractor implements CoverExtractor {
  readonly calls: string[] = [];
  readonly repairCalls: string[] = [];

  constructor(private readonly result?: Partial<CoverResult>) {}

  async extract(filePath: string, options: CoverExtractOptions): Promise<CoverResult> {
    this.calls.push(filePath);
    const sourceHash = this.result?.sourceHash ?? `fake-${this.calls.length}`;
    const coverRoot = join(options.cacheRoot, sourceHash.slice(0, 2), sourceHash);
    mkdirSync(coverRoot, { recursive: true });
    const thumbPath = this.result?.thumbPath ?? join(coverRoot, 'thumb.webp');
    const albumPath = this.result?.albumPath ?? join(coverRoot, 'album.webp');
    const largePath = this.result?.largePath ?? join(coverRoot, 'large.webp');
    const originalRef = this.result?.originalRef ?? join(coverRoot, 'original.svg');

    writeFileSync(thumbPath, 'thumb');
    writeFileSync(albumPath, 'album');
    writeFileSync(largePath, 'large');
    writeFileSync(originalRef, 'original');

    return {
      source: 'default',
      thumbPath,
      albumPath,
      largePath,
      originalRef,
      sourceHash,
      mimeType: 'image/svg+xml',
      warnings: [],
      errors: [],
      ...this.result,
    };
  }

  async repairCachedCover(options: CoverCacheRepairOptions): Promise<CoverResult> {
    this.repairCalls.push(options.sourceHash);
    const coverRoot = join(options.cacheRoot, options.sourceHash.slice(0, 2), options.sourceHash);
    mkdirSync(coverRoot, { recursive: true });
    const thumbPath = options.thumbPath ?? join(coverRoot, 'thumb.webp');
    const albumPath = options.albumPath ?? join(coverRoot, 'album.webp');
    const largePath = options.largePath ?? join(coverRoot, 'large.webp');

    if (!existsSync(thumbPath)) {
      writeFileSync(thumbPath, 'thumb');
    }

    if (!existsSync(albumPath)) {
      writeFileSync(albumPath, 'album');
    }

    if (!existsSync(largePath)) {
      writeFileSync(largePath, 'large');
    }

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

class ThrowingCoverExtractor implements CoverExtractor {
  async extract(): Promise<CoverResult> {
    throw new Error('cover extractor boom');
  }
}

class FakeFileScanner implements FileScanner {
  readonly calls: string[] = [];

  constructor(private readonly files: ScannedFile[]) {}

  async *scanFolder(folderPath: string): AsyncIterable<ScannedFile> {
    this.calls.push(folderPath);

    for (const file of this.files) {
      yield file;
    }
  }
}

const createHarness = (overrides: { coverExtractor?: CoverExtractor; metadataReader?: MetadataReader; fileScanner?: FileScanner } = {}) => {
  const root = makeTempRoot();
  const folder = join(root, 'music');
  mkdirSync(folder, { recursive: true });
  const metadataService = new MockMetadataService();
  const databasePath = join(root, 'library.sqlite');
  const coverCacheDir = join(root, 'cover-cache');
  const service = createLibraryService(databasePath, {
    metadataService,
    coverCacheDir,
    ...overrides,
  });
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    try {
      service.close();
    } catch {
      // Some tests intentionally close and reopen the service to simulate app restart.
    }
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // SQLite and image codecs can release Windows handles a tick after test assertions finish.
    }
  };

  cleanupCallbacks.push(cleanup);

  return {
    root,
    folder,
    databasePath,
    coverCacheDir,
    metadataService,
    service,
    async scanFolder() {
      const [libraryFolder] = service.getFolders();
      const job = service.scanFolder(libraryFolder.id);
      await service.waitForScan(job.id);
      return service.getScanStatus(job.id);
    },
    addFolder() {
      return service.addFolder(folder);
    },
    cleanup() {
      cleanup();
    },
  };
};

afterEach(() => {
  for (const cleanup of cleanupCallbacks.splice(0)) {
    cleanup();
  }

  for (const root of tempRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // SQLite WAL handles can linger briefly after an assertion failure on Windows.
    }
  }
});

describe('Library Core', () => {
  it('migration can initialize database and run repeatedly', () => {
    const root = makeTempRoot();
    const databasePath = join(root, 'library.sqlite');
    const database = createDatabase(databasePath);
    const tables = database.prepare<unknown[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    const indexes = database.prepare<unknown[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name);

    expect(tables).toEqual(expect.arrayContaining(['folders', 'tracks', 'albums', 'album_tracks', 'artists', 'covers', 'scan_jobs']));
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_tracks_path',
        'idx_tracks_folder_id',
        'idx_tracks_title',
        'idx_tracks_artist',
        'idx_tracks_album',
        'idx_albums_album_key',
        'idx_album_tracks_album_id',
        'idx_album_tracks_track_id',
        'idx_folders_path',
        'idx_covers_id',
      ]),
    );

    database.close();
    const reopened = createDatabase(databasePath);
    const migrationRows = reopened.prepare<unknown[], { id: number }>('SELECT id FROM schema_migrations ORDER BY id').all();

    expect(migrationRows.map((row) => Number(row.id))).toEqual([1, 2, 3, 4, 5, 6]);
    reopened.close();
  });

  it('can add folder', () => {
    const harness = createHarness();
    const folder = harness.addFolder();

    expect(folder.path).toBe(harness.folder);
    expect(harness.service.getFolders()).toHaveLength(1);
    harness.cleanup();
  });

  it('addFolder is idempotent for the same path', () => {
    const harness = createHarness();
    const first = harness.addFolder();
    const second = harness.service.addFolder(harness.folder);

    expect(second.id).toBe(first.id);
    expect(harness.service.getFolders()).toHaveLength(1);
    harness.cleanup();
  });

  it('addFolder persists across service restart', () => {
    const harness = createHarness();
    harness.addFolder();
    harness.service.close();

    const restarted = createLibraryService(harness.databasePath, {
      metadataService: new MockMetadataService(),
      coverCacheDir: harness.coverCacheDir,
    });

    expect(restarted.getFolders()).toHaveLength(1);
    expect(restarted.getFolders()[0].path).toBe(harness.folder);
    restarted.close();
    harness.cleanup();
  });

  it('path + size + mtime unchanged skips metadata parse', async () => {
    const harness = createHarness();
    writeAudioFile(harness.folder, 'Artist - Song.flac');
    harness.addFolder();

    await harness.scanFolder();
    const secondScan = await harness.scanFolder();

    expect(harness.metadataService.calls).toHaveLength(1);
    expect(secondScan.skippedFiles).toBe(1);
    harness.cleanup();
  });

  it('path + size + mtime unchanged with complete cover cache skips cover work', async () => {
    const coverExtractor = new FakeCoverExtractor();
    const harness = createHarness({ coverExtractor });
    writeAudioFile(harness.folder, 'Artist - Cached Cover.flac');
    harness.addFolder();

    await harness.scanFolder();
    const secondScan = await harness.scanFolder();

    expect(harness.metadataService.calls).toHaveLength(1);
    expect(coverExtractor.calls).toHaveLength(1);
    expect(coverExtractor.repairCalls).toHaveLength(0);
    expect(secondScan.skippedFiles).toBe(1);
    harness.cleanup();
  });

  it('unchanged track with missing cover_id backfills cover by rereading metadata', async () => {
    const coverExtractor = new FakeCoverExtractor();
    const harness = createHarness({ coverExtractor });
    writeAudioFile(harness.folder, 'Artist - Missing Cover Id.flac');
    harness.addFolder();

    await harness.scanFolder();
    harness.service.close();
    const database = createDatabase(harness.databasePath);
    database.prepare('UPDATE tracks SET cover_id = NULL').run();
    database.close();

    const restarted = createLibraryService(harness.databasePath, {
      metadataService: harness.metadataService,
      coverExtractor,
      coverCacheDir: harness.coverCacheDir,
    });
    const [libraryFolder] = restarted.getFolders();
    const job = restarted.scanFolder(libraryFolder.id);
    await restarted.waitForScan(job.id);
    const track = restarted.getTracks({ pageSize: 1 }).items[0];

    expect(harness.metadataService.calls).toHaveLength(2);
    expect(coverExtractor.calls).toHaveLength(2);
    expect(track.coverId).toBeTruthy();
    restarted.close();
    harness.cleanup();
  });

  it('unchanged track with missing derivative repairs from original_ref without rereading metadata', async () => {
    const coverExtractor = new FakeCoverExtractor();
    const harness = createHarness({ coverExtractor });
    writeAudioFile(harness.folder, 'Artist - Missing Album Derivative.flac');
    harness.addFolder();

    await harness.scanFolder();
    const track = harness.service.getTracks({ pageSize: 1 }).items[0];
    harness.service.close();
    const database = createDatabase(harness.databasePath);
    const cover = database
      .prepare<[string | null], { album_path: string }>('SELECT album_path FROM covers WHERE id = ?')
      .get(track.coverId);
    database.close();
    expect(cover?.album_path).toBeTruthy();
    unlinkSync(cover!.album_path);

    const restarted = createLibraryService(harness.databasePath, {
      metadataService: harness.metadataService,
      coverExtractor,
      coverCacheDir: harness.coverCacheDir,
    });
    const [libraryFolder] = restarted.getFolders();
    const job = restarted.scanFolder(libraryFolder.id);
    await restarted.waitForScan(job.id);

    expect(harness.metadataService.calls).toHaveLength(1);
    expect(coverExtractor.calls).toHaveLength(1);
    expect(coverExtractor.repairCalls).toHaveLength(1);
    expect(existsSync(cover!.album_path)).toBe(true);
    restarted.close();
    harness.cleanup();
  });

  it('changed mtime or size triggers reparse', async () => {
    const harness = createHarness();
    const filePath = writeAudioFile(harness.folder, 'Artist - Song.flac');
    harness.addFolder();

    await harness.scanFolder();
    writeFileSync(filePath, 'fake audio with a changed size');
    utimesSync(filePath, new Date('2024-01-02T00:00:00.000Z'), new Date('2024-01-02T00:00:00.000Z'));
    const secondScan = await harness.scanFolder();

    expect(harness.metadataService.calls).toHaveLength(2);
    expect(secondScan.updatedTracks).toBe(1);
    harness.cleanup();
  });

  it('deleted files are removed from the library on the next scan', async () => {
    const harness = createHarness();
    const filePath = writeAudioFile(harness.folder, 'Artist - Removed.flac');
    harness.addFolder();

    await harness.scanFolder();
    rmSync(filePath);
    const secondScan = await harness.scanFolder();

    expect(secondScan.removedTracks).toBe(1);
    expect(harness.service.getTracks({ pageSize: 10 }).total).toBe(0);
    harness.cleanup();
  });

  it('prunes missing tracks without a full folder scan', async () => {
    const harness = createHarness();
    const filePath = writeAudioFile(harness.folder, 'Artist - Missing Later.flac');
    harness.addFolder();

    await harness.scanFolder();
    rmSync(filePath);
    const result = harness.service.pruneMissingTracks();

    expect(result).toEqual({ scannedCount: 1, removedCount: 1 });
    expect(harness.service.getTracks({ pageSize: 10 }).total).toBe(0);
    harness.cleanup();
  });

  it('clears the visible library list without deleting local files', async () => {
    const harness = createHarness();
    const filePath = writeAudioFile(harness.folder, 'Artist - Keep File.flac');
    harness.addFolder();

    await harness.scanFolder();
    const result = harness.service.clearTracks();

    expect(result).toEqual({ scannedCount: 1, removedCount: 1 });
    expect(existsSync(filePath)).toBe(true);
    expect(harness.service.getTracks({ pageSize: 10 }).total).toBe(0);
    harness.cleanup();
  });

  it('scan job reports progress phases and per-file metadata errors', async () => {
    const harness = createHarness();
    writeAudioFile(harness.folder, 'Good.flac');
    const badFile = writeAudioFile(harness.folder, 'Bad.flac');
    harness.metadataService.failures.add(badFile);
    harness.addFolder();

    const status = await harness.scanFolder();

    expect(status.status).toBe('completed');
    expect(status.phase).toBe('finished');
    expect(status.totalFiles).toBe(2);
    expect(status.processedFiles).toBe(2);
    expect(status.errorCount).toBe(1);
    expect(status.errors[0]).toContain('metadata boom');
    expect(harness.service.getTracks({ pageSize: 10 }).total).toBe(1);
    harness.cleanup();
  });

  it('metadata embedded title is not overwritten by filename fallback', () => {
    const metadataService = new MetadataService();
    const parsed = metadataService.normalize('Filename Artist - Filename Title.flac', {
      common: {
        title: 'Embedded Title',
        artist: 'Embedded Artist',
        album: 'Embedded Album',
      },
      format: {},
    } as Parameters<MetadataService['normalize']>[1]);

    expect(parsed.title).toBe('Embedded Title');
    expect(parsed.artist).toBe('Embedded Artist');
    expect(parsed.album).toBe('Embedded Album');
    expect(parsed.fieldSources.title).toBe('embedded');
  });

  it('embedded artist prevents Unknown Artist fallback', () => {
    const metadataService = new MetadataService();
    const parsed = metadataService.normalize('No Artist In Name.flac', {
      common: {
        artist: 'Embedded Artist',
      },
      format: {},
    } as Parameters<MetadataService['normalize']>[1]);

    expect(parsed.artist).toBe('Embedded Artist');
    expect(parsed.artist).not.toBe('Unknown Artist');
    expect(parsed.fieldSources.artist).toBe('embedded');
  });

  it('embedded album is not overwritten by folder inference', () => {
    const metadataService = new MetadataService();
    const parsed = metadataService.normalize(join('Folder Album', 'Artist - Song.flac'), {
      common: {
        album: 'Embedded Album',
      },
      format: {},
    } as Parameters<MetadataService['normalize']>[1]);

    expect(parsed.album).toBe('Embedded Album');
    expect(parsed.fieldSources.album).toBe('embedded');
  });

  it('missing embedded albumArtist is marked as artist fallback', () => {
    const metadataService = new MetadataService();
    const parsed = metadataService.normalize(join('Folder Album', 'Artist - Song.flac'), {
      common: {
        artist: 'Embedded Artist',
        album: 'Embedded Album',
      },
      format: {},
    } as Parameters<MetadataService['normalize']>[1]);

    expect(parsed.albumArtist).toBe('Embedded Artist');
    expect(parsed.fieldSources.albumArtist).toBe('artist_fallback');
  });

  it('album grouping same embedded albumArtist merges even when track artists differ', async () => {
    const harness = createHarness();
    const first = writeAudioFile(harness.folder, 'A.flac');
    const second = writeAudioFile(harness.folder, 'B.flac');
    harness.metadataService.overrides.set(first, baseMetadata({ title: 'A', artist: 'Track Artist One', album: 'Same Album', albumArtist: 'Same Artist' }));
    harness.metadataService.overrides.set(second, baseMetadata({ title: 'B', artist: 'Track Artist Two', album: 'Same Album', albumArtist: 'Same Artist' }));
    harness.addFolder();

    await harness.scanFolder();
    const albums = harness.service.getAlbums({ pageSize: 10 });

    expect(albums.total).toBe(1);
    expect(albums.items[0].trackCount).toBe(2);
    harness.cleanup();
  });

  it('album grouping same folder and same album uses folder when albumArtist is artist fallback', async () => {
    const harness = createHarness();
    const first = writeAudioFile(harness.folder, 'A.flac');
    const second = writeAudioFile(harness.folder, 'B.flac');
    harness.metadataService.overrides.set(
      first,
      metadataWithSources(
        { title: 'A', artist: 'Track Artist One', album: 'Same Album', albumArtist: 'Track Artist One', year: 2024 },
        { albumArtist: 'artist_fallback' },
      ),
    );
    harness.metadataService.overrides.set(
      second,
      metadataWithSources(
        { title: 'B', artist: 'Track Artist Two', album: 'Same Album', albumArtist: 'Track Artist Two', year: 2024 },
        { albumArtist: 'artist_fallback' },
      ),
    );
    harness.addFolder();

    await harness.scanFolder();
    const albums = harness.service.getAlbums({ pageSize: 10 });

    expect(albums.total).toBe(1);
    expect(albums.items[0].trackCount).toBe(2);
    harness.cleanup();
  });

  it('album grouping same album with artist fallback stays split across folders', async () => {
    const harness = createHarness();
    const firstFolder = join(harness.folder, 'disc-a');
    const secondFolder = join(harness.folder, 'disc-b');
    mkdirSync(firstFolder, { recursive: true });
    mkdirSync(secondFolder, { recursive: true });
    const first = writeAudioFile(firstFolder, 'A.flac');
    const second = writeAudioFile(secondFolder, 'B.flac');
    harness.metadataService.overrides.set(
      first,
      metadataWithSources(
        { title: 'A', artist: 'Track Artist One', album: 'Same Album', albumArtist: 'Track Artist One', year: 2024 },
        { albumArtist: 'artist_fallback' },
      ),
    );
    harness.metadataService.overrides.set(
      second,
      metadataWithSources(
        { title: 'B', artist: 'Track Artist Two', album: 'Same Album', albumArtist: 'Track Artist Two', year: 2024 },
        { albumArtist: 'artist_fallback' },
      ),
    );
    harness.addFolder();

    await harness.scanFolder();
    const albums = harness.service.getAlbums({ pageSize: 10 });

    expect(albums.total).toBe(2);
    harness.cleanup();
  });

  it('album grouping different albumArtist does not merge', async () => {
    const harness = createHarness();
    const first = writeAudioFile(harness.folder, 'A.flac');
    const second = writeAudioFile(harness.folder, 'B.flac');
    harness.metadataService.overrides.set(first, baseMetadata({ title: 'A', album: 'Same Album', albumArtist: 'Artist One' }));
    harness.metadataService.overrides.set(second, baseMetadata({ title: 'B', album: 'Same Album', albumArtist: 'Artist Two' }));
    harness.addFolder();

    await harness.scanFolder();
    const albums = harness.service.getAlbums({ pageSize: 10 });

    expect(albums.total).toBe(2);
    harness.cleanup();
  });

  it('empty album values do not merge into one giant Unknown Album', async () => {
    const harness = createHarness();
    const first = writeAudioFile(harness.folder, 'Loose A.flac');
    const second = writeAudioFile(harness.folder, 'Loose B.flac');
    harness.metadataService.overrides.set(first, baseMetadata({ title: 'Loose A', album: '', albumArtist: '' }));
    harness.metadataService.overrides.set(second, baseMetadata({ title: 'Loose B', album: '', albumArtist: '' }));
    harness.addFolder();

    await harness.scanFolder();
    const albums = harness.service.getAlbums({ pageSize: 10 });

    expect(albums.total).toBe(2);
    harness.cleanup();
  });

  it('Unknown Album values do not merge by folder', async () => {
    const harness = createHarness();
    const first = writeAudioFile(harness.folder, 'Loose A.flac');
    const second = writeAudioFile(harness.folder, 'Loose B.flac');
    harness.metadataService.overrides.set(
      first,
      metadataWithSources({ title: 'Loose A', artist: 'Artist One', album: 'Unknown Album', albumArtist: 'Artist One' }, { albumArtist: 'artist_fallback' }),
    );
    harness.metadataService.overrides.set(
      second,
      metadataWithSources({ title: 'Loose B', artist: 'Artist Two', album: 'Unknown Album', albumArtist: 'Artist Two' }, { albumArtist: 'artist_fallback' }),
    );
    harness.addFolder();

    await harness.scanFolder();
    const albums = harness.service.getAlbums({ pageSize: 10 });

    expect(albums.total).toBe(2);
    harness.cleanup();
  });

  it('manual albumArtist source groups by manual Album Artist', async () => {
    const harness = createHarness();
    const first = writeAudioFile(harness.folder, 'A.flac');
    const second = writeAudioFile(harness.folder, 'B.flac');
    harness.metadataService.overrides.set(
      first,
      metadataWithSources({ title: 'A', artist: 'Track Artist One', album: 'Same Album', albumArtist: 'Manual Album Artist' }, { albumArtist: 'manual' }),
    );
    harness.metadataService.overrides.set(
      second,
      metadataWithSources({ title: 'B', artist: 'Track Artist Two', album: 'Same Album', albumArtist: 'Manual Album Artist' }, { albumArtist: 'manual' }),
    );
    harness.addFolder();

    await harness.scanFolder();
    const albums = harness.service.getAlbums({ pageSize: 10 });

    expect(albums.total).toBe(1);
    expect(albums.items[0].albumArtist).toBe('Manual Album Artist');
    expect(albums.items[0].trackCount).toBe(2);
    harness.cleanup();
  });

  it('albums persist and can be read after restart without metadata parsing', async () => {
    const harness = createHarness();
    writeAudioFile(harness.folder, 'A.flac');
    writeAudioFile(harness.folder, 'B.flac');
    harness.addFolder();

    await harness.scanFolder();
    harness.service.close();

    const restartedMetadata = new MockMetadataService();
    const restarted = createLibraryService(harness.databasePath, {
      metadataService: restartedMetadata,
      coverCacheDir: harness.coverCacheDir,
    });
    const albums = restarted.getAlbums({ pageSize: 10 });

    expect(albums.total).toBe(1);
    expect(albums.items[0].trackCount).toBe(2);
    expect(restartedMetadata.calls).toHaveLength(0);
    restarted.close();
    harness.cleanup();
  });

  it('getTracks returns paginated data', async () => {
    const harness = createHarness();
    writeAudioFile(harness.folder, 'A.flac');
    writeAudioFile(harness.folder, 'B.flac');
    writeAudioFile(harness.folder, 'C.flac');
    harness.addFolder();

    await harness.scanFolder();
    const firstPage = harness.service.getTracks({ page: 1, pageSize: 2 });
    const secondPage = harness.service.getTracks({ page: 2, pageSize: 2 });

    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.hasMore).toBe(true);
    expect(secondPage.items).toHaveLength(1);
    harness.cleanup();
  });

  it('getAlbumTracks returns paginated tracks from persisted album_tracks', async () => {
    const harness = createHarness();
    writeAudioFile(harness.folder, 'A.flac');
    writeAudioFile(harness.folder, 'B.flac');
    harness.addFolder();

    await harness.scanFolder();
    const [album] = harness.service.getAlbums({ pageSize: 1 }).items;
    const firstPage = harness.service.getAlbumTracks(album.id, { page: 1, pageSize: 1 });
    const secondPage = harness.service.getAlbumTracks(album.id, { page: 2, pageSize: 1 });

    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.hasMore).toBe(true);
    expect(secondPage.items).toHaveLength(1);
    harness.cleanup();
  });

  it('list API does not return full cover', async () => {
    const harness = createHarness();
    const filePath = writeAudioFile(harness.folder, 'Cover.flac');
    harness.metadataService.overrides.set(
      filePath,
      baseMetadata({
        embeddedCover: {
          data: validCoverPng(),
          mimeType: 'image/png',
        },
      }),
    );
    harness.addFolder();

    await harness.scanFolder();
    const [track] = harness.service.getTracks({ pageSize: 1 }).items;
    const [album] = harness.service.getAlbums({ pageSize: 1 }).items;
    const serializedTrack = JSON.stringify(track);
    const serializedAlbum = JSON.stringify(album);

    expect(track).toHaveProperty('coverThumb');
    expect(track.coverThumb).toContain('echo-cover://thumb/');
    expect(album.coverThumb).toContain('echo-cover://album/');
    expect(track).not.toHaveProperty('largePath');
    expect(track).not.toHaveProperty('originalRef');
    expect(album).not.toHaveProperty('largePath');
    expect(album).not.toHaveProperty('originalRef');
    expect(track).not.toHaveProperty('coverLarge');
    expect(track).not.toHaveProperty('coverOriginal');
    expect(serializedTrack).not.toContain('file://');
    expect(serializedAlbum).not.toContain('file://');
    expect(serializedTrack).not.toContain('cover-cache');
    expect(serializedAlbum).not.toContain('cover-cache');
    expect(serializedTrack).not.toContain('largePath');
    expect(serializedAlbum).not.toContain('largePath');
    expect(serializedTrack).not.toContain('originalRef');
    expect(serializedAlbum).not.toContain('originalRef');
    expect(serializedTrack).not.toContain('base64');
    expect(serializedAlbum).not.toContain('base64');
    harness.cleanup();
  });

  it('getDiagnostics returns counts and timings without full track or cover lists', async () => {
    const harness = createHarness();
    writeAudioFile(harness.folder, 'Diagnostics.flac');
    harness.addFolder();

    await harness.scanFolder();
    harness.service.getTracks({ pageSize: 1 });
    harness.service.getAlbums({ pageSize: 1 });
    const diagnostics = harness.service.getDiagnostics();
    const serialized = JSON.stringify(diagnostics);

    expect(diagnostics.foldersCount).toBe(1);
    expect(diagnostics.tracksCount).toBe(1);
    expect(diagnostics.albumsCount).toBe(1);
    expect(diagnostics.coversCount).toBe(1);
    expect(diagnostics.lastScan?.status).toBe('completed');
    expect(diagnostics.lastScan?.coverCount).toBe(1);
    expect(diagnostics.lastScan?.skippedCount).toBe(0);
    expect(typeof diagnostics.lastQueryMs.getTracks).toBe('number');
    expect(typeof diagnostics.lastQueryMs.getAlbums).toBe('number');
    expect(typeof diagnostics.averageAlbumPayloadBytes).toBe('number');
    expect(diagnostics.coverCachePath).toBe(harness.coverCacheDir);
    expect(typeof diagnostics.coverCacheSizeBytes).toBe('number');
    expect(diagnostics.coverCacheVersion).toBe(1);
    expect(diagnostics.databasePath).toBe(harness.databasePath);
    expect(serialized).not.toContain('"items"');
    expect(serialized).not.toContain('coverLarge');
    expect(serialized).not.toContain('coverOriginal');
    harness.cleanup();
  });

  it('embedded cover wins over folder/default cover', async () => {
    const embeddedCover = validCoverPng();
    const harness = createHarness({
      metadataReader: new FakeMetadataReader(
        metadataResult({
          embeddedCover: {
            data: embeddedCover,
            mimeType: 'image/png',
          },
        }),
      ),
    });
    writeAudioFile(harness.folder, 'Cover Priority.flac');
    writeFileSync(join(harness.folder, 'cover.jpg'), new Uint8Array([9, 9, 9]));
    harness.addFolder();

    await harness.scanFolder();
    const [track] = harness.service.getTracks({ pageSize: 1 }).items;
    harness.service.close();
    const database = createDatabase(harness.databasePath);
    const cover = database
      .prepare<[string | null], { source_type: string; thumb_path: string | null }>('SELECT source_type, thumb_path FROM covers WHERE id = ?')
      .get(track.coverId);

    expect(cover?.source_type).toBe('embedded');
    expect(typeof cover?.thumb_path).toBe('string');
    expect(track.coverThumb).toContain('echo-cover://thumb/');
    database.close();
    harness.cleanup();
  });

  it('cover extractor failures do not prevent track metadata from being written', async () => {
    const harness = createHarness({ coverExtractor: new ThrowingCoverExtractor() });
    writeAudioFile(harness.folder, 'Cover Failure.flac');
    harness.addFolder();

    const status = await harness.scanFolder();
    const tracks = harness.service.getTracks({ pageSize: 10 });

    expect(status.status).toBe('completed');
    expect(status.errors.join('\n')).toContain('cover extractor boom');
    expect(tracks.total).toBe(1);
    expect(tracks.items[0].title).toBe('Embedded Title');
    expect(tracks.items[0].coverThumb).toBeNull();
    harness.cleanup();
  });

  it('LibraryService can scan with fake worker interfaces instead of concrete TS workers', async () => {
    const root = makeTempRoot();
    const folder = join(root, 'music');
    mkdirSync(folder, { recursive: true });
    const filePath = writeAudioFile(folder, 'Fake Worker.flac');
    const fileScanner = new FakeFileScanner([
      {
        path: filePath,
        sizeBytes: 123,
        mtimeMs: 456,
      },
    ]);
    const metadataReader = new FakeMetadataReader(metadataResult({ title: 'Worker Title' }));
    const coverExtractor = new FakeCoverExtractor();
    const service = createLibraryService(join(root, 'library.sqlite'), {
      fileScanner,
      metadataReader,
      coverExtractor,
      coverCacheDir: join(root, 'cover-cache'),
    });

    const libraryFolder = service.addFolder(folder);
    const job = service.scanFolder(libraryFolder.id);
    await service.waitForScan(job.id);

    const tracks = service.getTracks({ pageSize: 10 });
    expect(fileScanner.calls).toEqual([folder]);
    expect(metadataReader.calls).toEqual([filePath]);
    expect(coverExtractor.calls).toEqual([filePath]);
    expect(tracks.total).toBe(1);
    expect(tracks.items[0].title).toBe('Worker Title');
    service.close();
  });

  it('worker warnings and errors are collected without failing the scan', async () => {
    const root = makeTempRoot();
    const folder = join(root, 'music');
    mkdirSync(folder, { recursive: true });
    const filePath = writeAudioFile(folder, 'Noisy Worker.flac');
    const metadataReader = new FakeMetadataReader(
      metadataResult(
        { title: 'Noisy Title' },
        {
          status: 'error',
          warnings: ['metadata warning'],
          errors: ['metadata fallback'],
        },
      ),
    );
    const coverExtractor = new FakeCoverExtractor({
      warnings: ['cover warning'],
      errors: ['cover fallback'],
    });
    const service = createLibraryService(join(root, 'library.sqlite'), {
      fileScanner: new FakeFileScanner([
        {
          path: filePath,
          sizeBytes: 123,
          mtimeMs: 456,
        },
      ]),
      metadataReader,
      coverExtractor,
      coverCacheDir: join(root, 'cover-cache'),
    });

    const libraryFolder = service.addFolder(folder);
    const job = service.scanFolder(libraryFolder.id);
    await service.waitForScan(job.id);
    const status = service.getScanStatus(job.id);
    const tracks = service.getTracks({ pageSize: 10 });

    expect(status.status).toBe('completed');
    expect(status.errorCount).toBe(4);
    expect(status.errors.join('\n')).toContain('metadata warning');
    expect(status.errors.join('\n')).toContain('metadata fallback');
    expect(status.errors.join('\n')).toContain('cover warning');
    expect(status.errors.join('\n')).toContain('cover fallback');
    expect(tracks.total).toBe(1);
    expect(tracks.items[0].metadataStatus).toBe('error');
    service.close();
  });

  it('scan job can be cancelled while worker work is in flight', async () => {
    const root = makeTempRoot();
    const folder = join(root, 'music');
    mkdirSync(folder, { recursive: true });
    const filePath = writeAudioFile(folder, 'Slow Worker.flac');
    let resolveStarted: () => void = () => undefined;
    let releaseRead: () => void = () => undefined;
    const readStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const metadataReader: MetadataReader = {
      async read() {
        resolveStarted();
        await new Promise<void>((resolveRead) => {
          releaseRead = resolveRead;
        });
        return metadataResult();
      },
    };
    const service = createLibraryService(join(root, 'library.sqlite'), {
      fileScanner: new FakeFileScanner([
        {
          path: filePath,
          sizeBytes: 123,
          mtimeMs: 456,
        },
      ]),
      metadataReader,
      coverExtractor: new FakeCoverExtractor(),
      coverCacheDir: join(root, 'cover-cache'),
    });
    const libraryFolder = service.addFolder(folder);
    const job = service.scanFolder(libraryFolder.id);

    await readStarted;
    const cancelling = service.cancelScan(job.id);
    expect(cancelling.status).toBe('running');
    releaseRead();
    await service.waitForScan(job.id);
    expect(service.getScanStatus(job.id).status).toBe('cancelled');
    service.close();
  });
});
