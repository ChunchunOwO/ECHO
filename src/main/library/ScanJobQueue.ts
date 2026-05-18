import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import { setImmediate as yieldToMainLoop } from 'node:timers/promises';
import { SCANNABLE_AUDIO_EXTENSIONS } from '../../shared/constants/audioExtensions';
import type { AlbumMergeStrategy, AlbumService } from './AlbumService';
import type { LibraryStore } from './LibraryStore';
import type {
  CoverResult,
  LibraryFolder,
  LibraryScanMode,
  LibraryScanOptions,
  LibraryScanStatus,
  MetadataResult,
  ScannedAudioFile,
  ScannedFile,
  ScanJobUpdate,
  StoredTrackCoverState,
} from './libraryTypes';
import type { CoverExtractor } from './workers/CoverExtractor';
import type { FileScanner } from './workers/FileScanner';
import type { MetadataReader } from './workers/MetadataReader';
import { getNcmConverter } from './NcmConverter';
import { FileIdentityService, QUICK_HASH_VERSION, type FileIdentityObservation } from './FileIdentityService';

type ParsedScanItem = {
  file: ScannedAudioFile;
  metadata: MetadataResult;
  cover: CoverResult | null;
  existingTrackId: string | null;
  identity: FileIdentityObservation | null;
};

type ChangedFile = {
  file: ScannedAudioFile;
  existingTrackId: string | null;
};

type CoverRepairItem = {
  file: ScannedAudioFile;
  state: StoredTrackCoverState;
  cover: CoverResult | null;
  identity: FileIdentityObservation | null;
};

type IdentityUpdateItem = {
  file: ScannedAudioFile;
  state: StoredTrackCoverState;
  identity: FileIdentityObservation | null;
};

type ScanJobQueueOptions = {
  coverCacheDir: string;
  metadataConcurrency?: number;
  coverConcurrency?: number;
  getAlbumMergeStrategy?: () => AlbumMergeStrategy;
  checkDatabaseHealth?: (status: LibraryScanStatus) => void;
  fileIdentityService?: FileIdentityService;
};

const progressFlushIntervalMs = 300;
const progressFlushFileDelta = 64;
const maxStoredScanErrors = 200;
const maxLocalScanPathCount = 1000;
const temporaryExtensions = new Set(['.tmp', '.temp', '.part', '.crdownload', '.download', '.swp']);
const ignoredTemporaryNames = new Set(['.ds_store', 'thumbs.db']);

type ScanProgressReporter = {
  update: (patch: ScanJobUpdate) => LibraryScanStatus | null;
  flushNow: (patch?: ScanJobUpdate) => LibraryScanStatus;
};

class ScanCancelledError extends Error {
  constructor() {
    super('scan_cancelled');
  }
}

export class ScanJobQueue {
  private readonly runningJobs = new Map<string, Promise<void>>();
  private readonly metadataConcurrency: number;
  private readonly coverConcurrency: number;
  private readonly getAlbumMergeStrategy: () => AlbumMergeStrategy;
  private readonly checkDatabaseHealth: (status: LibraryScanStatus) => void;
  private readonly fileIdentityService: FileIdentityService;
  private coverCacheDir: string;

  constructor(
    private readonly store: LibraryStore,
    private readonly fileScanner: FileScanner,
    private readonly metadataReader: MetadataReader,
    private readonly coverExtractor: CoverExtractor,
    private readonly albumService: AlbumService,
    options: ScanJobQueueOptions,
  ) {
    this.metadataConcurrency = options.metadataConcurrency ?? 2;
    this.coverConcurrency = options.coverConcurrency ?? 2;
    this.getAlbumMergeStrategy = options.getAlbumMergeStrategy ?? (() => 'standard');
    this.checkDatabaseHealth = options.checkDatabaseHealth ?? (() => undefined);
    this.fileIdentityService = options.fileIdentityService ?? new FileIdentityService();
    this.coverCacheDir = options.coverCacheDir;
  }

  hasRunningJobs(): boolean {
    return this.runningJobs.size > 0;
  }

  updateCoverCacheDir(coverCacheDir: string): void {
    this.coverCacheDir = coverCacheDir;
  }

  scanFolder(folder: LibraryFolder, options: LibraryScanOptions = {}): LibraryScanStatus {
    const job = this.store.createScanJob(folder.id);
    const run = this.runJob(job.id, folder, options.mode ?? 'normal').finally(() => {
      this.runningJobs.delete(job.id);
    });

    this.runningJobs.set(job.id, run);

    return job;
  }

  scanPaths(folder: LibraryFolder, paths: string[], options: LibraryScanOptions = {}): LibraryScanStatus {
    if (paths.length > maxLocalScanPathCount) {
      throw new Error(`Too many local rescan paths: ${paths.length} > ${maxLocalScanPathCount}`);
    }

    const job = this.store.createScanJob(folder.id);
    const run = this.runPathsJob(job.id, folder, paths, options.mode ?? 'normal', options.deferGroupingRefresh === true).finally(() => {
      this.runningJobs.delete(job.id);
    });

    this.runningJobs.set(job.id, run);

    return job;
  }

  getScanStatus(jobId: string): LibraryScanStatus {
    const job = this.store.getScanJob(jobId);

    if (!job) {
      throw new Error(`Unknown scan job ${jobId}`);
    }

    return job;
  }

  cancelScan(jobId: string): LibraryScanStatus {
    const current = this.getScanStatus(jobId);

    if (current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled') {
      return current;
    }

    return this.store.updateScanJob(jobId, {
      cancelRequested: true,
      status: current.status === 'queued' ? 'cancelled' : current.status,
      phase: current.status === 'queued' ? 'cancelled' : current.phase,
      finishedAt: current.status === 'queued' ? new Date().toISOString() : current.finishedAt,
    });
  }

  async waitForIdle(jobId: string): Promise<void> {
    await this.runningJobs.get(jobId);
  }

  private async runJob(jobId: string, folder: LibraryFolder, mode: LibraryScanMode): Promise<void> {
    const progress = this.createProgressReporter(jobId);
    const errors: string[] = [];

    try {
      progress.flushNow({
        status: 'running',
        phase: 'discovering',
        startedAt: new Date().toISOString(),
      });

      const files = await this.discoverFiles(jobId, folder, errors, progress);
      await this.runFilesJob(jobId, folder, files, mode, progress, errors, true);
    } catch (error) {
      this.finishFailedOrCancelledJob(jobId, progress, errors, error, {
        processedFiles: 0,
        skippedFiles: 0,
        addedTracks: 0,
        updatedTracks: 0,
        removedTracks: 0,
        coverCount: 0,
      });
    }
  }

  private async runPathsJob(
    jobId: string,
    folder: LibraryFolder,
    paths: string[],
    mode: LibraryScanMode,
    deferGroupingRefresh: boolean,
  ): Promise<void> {
    const progress = this.createProgressReporter(jobId);
    const errors: string[] = [];

    try {
      progress.flushNow({
        status: 'running',
        phase: 'discovering',
        startedAt: new Date().toISOString(),
      });

      const files = this.normalizeLocalRescanPaths(folder, paths);
      progress.flushNow({
        phase: 'discovering',
        totalFiles: files.length,
        errors,
      });
      await this.runFilesJob(jobId, folder, files, mode, progress, errors, false, deferGroupingRefresh);
    } catch (error) {
      this.finishFailedOrCancelledJob(jobId, progress, errors, error, {
        processedFiles: 0,
        skippedFiles: 0,
        addedTracks: 0,
        updatedTracks: 0,
        removedTracks: 0,
        coverCount: 0,
      });
    }
  }

  private async runFilesJob(
    jobId: string,
    folder: LibraryFolder,
    files: ScannedAudioFile[],
    mode: LibraryScanMode,
    progress: ScanProgressReporter,
    errors: string[],
    markMissing: boolean,
    deferGroupingRefresh = false,
  ): Promise<void> {
    let processedFiles = 0;
    let skippedFiles = 0;
    let addedTracks = 0;
    let updatedTracks = 0;
    let removedTracks = 0;
    let coverCount = 0;

    try {
      progress.flushNow({
        phase: 'checking_cache',
        totalFiles: files.length,
        errors,
      });

      const changedFiles: ChangedFile[] = [];
      const coverRepairItems: CoverRepairItem[] = [];
      const identityUpdateItems: IdentityUpdateItem[] = [];
      const cacheStatesByPath = this.store.getTrackCacheStatesByFolder(folder.id);

      for (const file of files) {
        this.throwIfCancelled(jobId);

        const existing = cacheStatesByPath.get(resolve(file.path)) ?? null;

        const unchanged = existing && existing.sizeBytes === file.sizeBytes && existing.mtimeMs === file.mtimeMs;
        const forceReadEmbeddedTags = this.shouldForceReadEmbeddedTags(mode, existing) || this.shouldBackfillPlaceholderMetadata(existing);

        if (unchanged && !forceReadEmbeddedTags) {
          if (this.hasCompleteCoverCache(existing)) {
            if (!this.hasIdentityObservation(existing)) {
              identityUpdateItems.push({
                file,
                state: existing,
                identity: null,
              });
            }
            processedFiles += 1;
            skippedFiles += 1;
            progress.update({
              processedFiles,
              skippedFiles,
            });
            continue;
          }

          if (this.canRepairCoverCache(existing)) {
            coverRepairItems.push({
              file,
              state: existing,
              cover: null,
              identity: null,
            });
            continue;
          }

          changedFiles.push({
            file,
            existingTrackId: existing.id,
          });
          continue;
        }

        changedFiles.push({
          file,
          existingTrackId: existing?.id ?? null,
        });
      }

      progress.flushNow({
        phase: 'reading_metadata',
        processedFiles,
        skippedFiles,
        errors,
      });

      const parsedItems: ParsedScanItem[] = [];
      const coverTimestamp = new Date().toISOString();

      await this.processWithConcurrency(changedFiles, this.metadataConcurrency, async (item) => {
        this.throwIfCancelled(jobId);

        try {
          const metadata = await this.metadataReader.read(item.file.path);
          const identity = this.observeFileIdentity(item.file.path);
          this.collectWorkerMessages(errors, item.file.path, 'metadata', metadata.warnings, metadata.errors);
          let cover: CoverResult | null = null;

          try {
            cover = await this.coverExtractor.extract(item.file.path, {
              cacheRoot: this.coverCacheDir,
              metadata,
              now: coverTimestamp,
            });
            this.collectWorkerMessages(errors, item.file.path, 'cover', cover.warnings, cover.errors);
            coverCount += 1;
          } catch (error) {
            errors.push(`${item.file.path}: cover: ${error instanceof Error ? error.message : String(error)}`);
          }

          parsedItems.push({
            ...item,
            metadata: this.stripEmbeddedCoverData(metadata),
            cover,
            identity,
          });
        } catch (error) {
          errors.push(`${item.file.path}: metadata: ${error instanceof Error ? error.message : String(error)}`);
        }

        processedFiles += 1;
        progress.update({
          phase: 'reading_metadata',
          processedFiles,
          skippedFiles,
          coverCount,
          errors,
        });
        await yieldToMainLoop();
      });

      this.throwIfCancelled(jobId);

      progress.flushNow({
        phase: 'extracting_covers',
        processedFiles,
        skippedFiles,
        coverCount,
        errors,
      });

      await this.processWithConcurrency(coverRepairItems, this.coverConcurrency, async (item) => {
        this.throwIfCancelled(jobId);

        try {
          if (!this.coverExtractor.repairCachedCover) {
            throw new Error('cover extractor does not support cached cover repair');
          }

          const cover = await this.coverExtractor.repairCachedCover({
            cacheRoot: this.coverCacheDir,
            source: item.state.coverSource!,
            sourceHash: item.state.sourceHash!,
            mimeType: item.state.mimeType,
            originalRef: item.state.originalRef!,
            thumbPath: item.state.thumbPath,
            albumPath: item.state.albumPath,
            largePath: item.state.largePath,
            now: coverTimestamp,
          });
          this.collectWorkerMessages(errors, item.file.path, 'cover', cover.warnings, cover.errors);
          item.cover = cover;
          coverCount += 1;
        } catch (error) {
          errors.push(`${item.file.path}: cover: ${error instanceof Error ? error.message : String(error)}`);
        }

        if (!this.hasIdentityObservation(item.state)) {
          item.identity = this.observeFileIdentity(item.file.path);
        }

        processedFiles += 1;
        progress.update({
          phase: 'extracting_covers',
          processedFiles,
          skippedFiles,
          coverCount,
          errors,
        });
        await yieldToMainLoop();
      });

      await this.processWithConcurrency(identityUpdateItems, this.metadataConcurrency, async (item) => {
        this.throwIfCancelled(jobId);
        item.identity = this.observeFileIdentity(item.file.path);
        await yieldToMainLoop();
      });

      this.throwIfCancelled(jobId);
      await yieldToMainLoop();

      this.store.transaction(() => {
        const timestamp = new Date().toISOString();

        if (markMissing) {
          removedTracks = this.store.markTracksMissingFromFolder(
            folder.id,
            files.map((file) => file.path),
            timestamp,
          );
        }

        for (const item of coverRepairItems) {
          if (item.cover) {
            const repairedCoverId = this.store.upsertCover(item.cover, timestamp);

            if (repairedCoverId && repairedCoverId !== item.state.coverId) {
              this.store.updateTrackCover(item.state.id, repairedCoverId, timestamp);
              updatedTracks += 1;
            }
          }
          if (item.identity) {
            this.store.updateTrackIdentity(item.state.id, item.identity, timestamp);
          }
        }

        for (const item of identityUpdateItems) {
          if (item.identity) {
            this.store.updateTrackIdentity(item.state.id, item.identity, timestamp);
          }
        }

        for (const item of parsedItems) {
          const coverId = item.cover ? this.store.upsertCover(item.cover, timestamp) : null;
          const result = this.store.upsertTrack({
            ...item.file,
            ...item.metadata.fields,
            id: item.existingTrackId ?? randomUUID(),
            coverId,
            fieldSources: item.metadata.fieldSources,
            embeddedMetadataStatus: item.metadata.embeddedMetadataStatus,
            embeddedCoverStatus: item.metadata.embeddedCoverStatus,
            metadataStatus: item.metadata.status,
            warnings: item.metadata.warnings,
            errors: item.metadata.errors,
            updatedAt: timestamp,
            ...this.toTrackIdentityWrite(item.identity),
          });

          if (result === 'added') {
            addedTracks += 1;
          } else {
            updatedTracks += 1;
          }
        }

        progress.flushNow({
          phase: 'grouping_albums',
          processedFiles,
          skippedFiles,
          addedTracks,
          updatedTracks,
          removedTracks,
          coverCount,
          errors,
        });
        if (!deferGroupingRefresh) {
          this.store.refreshAlbums(this.albumService, timestamp, { albumMergeStrategy: this.getAlbumMergeStrategy() });
          this.store.refreshArtists();
        }
        progress.flushNow({
          phase: 'writing_database',
          processedFiles,
          skippedFiles,
          addedTracks,
          updatedTracks,
          removedTracks,
          coverCount,
          errors,
        });
        if (markMissing) {
          this.store.finishFolderScan(folder.id, timestamp);
        }
        progress.flushNow({
          status: 'completed',
          phase: 'finished',
          processedFiles,
          skippedFiles,
          addedTracks,
          updatedTracks,
          removedTracks,
          coverCount,
          errors,
          finishedAt: new Date().toISOString(),
        });
      });
      this.checkDatabaseHealth(this.getScanStatus(jobId));
    } catch (error) {
      this.finishFailedOrCancelledJob(jobId, progress, errors, error, {
        processedFiles,
        skippedFiles,
        addedTracks,
        updatedTracks,
        removedTracks,
        coverCount,
      });
    }
  }

  private finishFailedOrCancelledJob(
    _jobId: string,
    progress: ScanProgressReporter,
    errors: string[],
    error: unknown,
    counts: {
      processedFiles: number;
      skippedFiles: number;
      addedTracks: number;
      updatedTracks: number;
      removedTracks: number;
      coverCount: number;
    },
  ): void {
    if (error instanceof ScanCancelledError) {
      progress.flushNow({
        status: 'cancelled',
        phase: 'cancelled',
        ...counts,
        errors,
        finishedAt: new Date().toISOString(),
      });
      return;
    }

    errors.push(error instanceof Error ? error.message : String(error));
    progress.flushNow({
      status: 'failed',
      phase: 'failed',
      ...counts,
      errors,
      finishedAt: new Date().toISOString(),
    });
  }

  private async discoverFiles(
    jobId: string,
    folder: LibraryFolder,
    errors: string[],
    progress: ScanProgressReporter,
  ): Promise<ScannedAudioFile[]> {
    const files: ScannedAudioFile[] = [];

    try {
      for await (const file of this.fileScanner.scanFolder(folder.path)) {
        this.throwIfCancelled(jobId);
        try {
          files.push(await this.normalizeScannedFile(file, folder.id));
        } catch (error) {
          errors.push(`${file.path}: ncm: ${error instanceof Error ? error.message : String(error)}`);
        }

        if (files.length % 100 === 0) {
          progress.update({
            phase: 'discovering',
            totalFiles: files.length,
            errors,
          });
        }
      }
    } catch (error) {
      errors.push(`${folder.path}: scanner: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }

    return files;
  }

  private normalizeLocalRescanPaths(folder: LibraryFolder, paths: string[]): ScannedAudioFile[] {
    const files: ScannedAudioFile[] = [];
    const seen = new Set<string>();

    for (const inputPath of paths) {
      const filePath = resolve(inputPath);
      const comparePath = this.pathCompareValue(filePath);

      if (seen.has(comparePath) || !this.isPathInsideFolder(folder.path, filePath) || !this.isLocalRescanCandidate(filePath)) {
        continue;
      }

      seen.add(comparePath);

      try {
        const fileStat = statSync(filePath);
        if (!fileStat.isFile()) {
          continue;
        }

        files.push({
          path: filePath,
          folderId: folder.id,
          sizeBytes: fileStat.size,
          mtimeMs: Math.round(fileStat.mtimeMs),
        });
      } catch {
        continue;
      }
    }

    return files;
  }

  private isLocalRescanCandidate(filePath: string): boolean {
    const fileName = basename(filePath).toLowerCase();
    const extension = extname(fileName);

    if (
      !fileName ||
      fileName.startsWith('.') ||
      fileName.startsWith('~') ||
      ignoredTemporaryNames.has(fileName) ||
      temporaryExtensions.has(extension)
    ) {
      return false;
    }

    return SCANNABLE_AUDIO_EXTENSIONS.has(extension);
  }

  private isPathInsideFolder(folderPath: string, filePath: string): boolean {
    const root = this.pathCompareValue(resolve(folderPath));
    const candidate = this.pathCompareValue(resolve(filePath));
    const relativePath = relative(root, candidate);

    return Boolean(relativePath) && !relativePath.startsWith('..') && !isAbsolute(relativePath);
  }

  private pathCompareValue(filePath: string): string {
    return process.platform === 'win32' ? filePath.toLocaleLowerCase() : filePath;
  }

  private createProgressReporter(jobId: string): ScanProgressReporter {
    let pending: ScanJobUpdate = {};
    let lastFlushAt = 0;
    let lastProcessedFiles = 0;
    let lastCoverCount = 0;
    let lastTotalFiles = 0;

    const mergePatch = (patch?: ScanJobUpdate): void => {
      if (!patch) {
        return;
      }

      pending = {
        ...pending,
        ...patch,
        errors: patch.errors ?? pending.errors,
      };
    };

    const sanitizePatch = (patch: ScanJobUpdate): ScanJobUpdate => {
      if (!patch.errors) {
        return patch;
      }

      return {
        ...patch,
        errorCount: patch.errorCount ?? patch.errors.length,
        errors: patch.errors.slice(0, maxStoredScanErrors),
      };
    };

    const flush = (): LibraryScanStatus => {
      const patch = sanitizePatch(pending);
      pending = {};
      const status = this.store.updateScanJob(jobId, patch);
      lastFlushAt = Date.now();
      lastProcessedFiles = status.processedFiles;
      lastCoverCount = status.coverCount ?? lastCoverCount;
      lastTotalFiles = status.totalFiles;
      return status;
    };

    return {
      update: (patch: ScanJobUpdate): LibraryScanStatus | null => {
        mergePatch(patch);

        const now = Date.now();
        const nextProcessedFiles = pending.processedFiles ?? lastProcessedFiles;
        const nextCoverCount = pending.coverCount ?? lastCoverCount;
        const nextTotalFiles = pending.totalFiles ?? lastTotalFiles;
        const shouldFlush =
          now - lastFlushAt >= progressFlushIntervalMs ||
          nextProcessedFiles - lastProcessedFiles >= progressFlushFileDelta ||
          nextCoverCount - lastCoverCount >= progressFlushFileDelta ||
          nextTotalFiles - lastTotalFiles >= progressFlushFileDelta;

        return shouldFlush ? flush() : null;
      },
      flushNow: (patch?: ScanJobUpdate): LibraryScanStatus => {
        mergePatch(patch);
        return flush();
      },
    };
  }

  private stripEmbeddedCoverData(metadata: MetadataResult): MetadataResult {
    if (!metadata.embeddedCover) {
      return metadata;
    }

    const lightweightMetadata = { ...metadata };
    delete lightweightMetadata.embeddedCover;
    return lightweightMetadata;
  }

  private withFolderId(file: ScannedFile, folderId: string): ScannedAudioFile {
    return {
      ...file,
      folderId,
    };
  }

  private async normalizeScannedFile(file: ScannedFile, folderId: string): Promise<ScannedAudioFile> {
    const decodedPath = await getNcmConverter().convertIfNeeded(file.path);
    if (decodedPath === file.path) {
      return this.withFolderId(file, folderId);
    }

    const fileStat = statSync(decodedPath);
    return {
      path: resolve(decodedPath),
      folderId,
      sizeBytes: fileStat.size,
      mtimeMs: Math.round(fileStat.mtimeMs),
    };
  }

  private throwIfCancelled(jobId: string): void {
    if (this.store.isScanCancelled(jobId)) {
      throw new ScanCancelledError();
    }
  }

  private collectWorkerMessages(
    errors: string[],
    filePath: string,
    workerName: string,
    warnings: string[],
    workerErrors: string[],
  ): void {
    for (const warning of warnings) {
      errors.push(`${filePath}: ${workerName} warning: ${warning}`);
    }

    for (const error of workerErrors) {
      errors.push(`${filePath}: ${workerName}: ${error}`);
    }
  }

  private hasCompleteCoverCache(state: StoredTrackCoverState): boolean {
    return Boolean(
      state.coverId &&
        state.thumbPath &&
        state.albumPath &&
        state.largePath &&
        existsSync(state.thumbPath) &&
        existsSync(state.albumPath) &&
        existsSync(state.largePath),
    );
  }

  private shouldForceReadEmbeddedTags(mode: LibraryScanMode, state: StoredTrackCoverState | null): boolean {
    if (mode === 'normal') {
      return false;
    }

    if (mode === 'embedded-tags-all') {
      return true;
    }

    return !state || this.isMissingOrDefaultCover(state);
  }

  private shouldBackfillPlaceholderMetadata(state: StoredTrackCoverState | null): boolean {
    if (!state) {
      return false;
    }

    return (
      state.metadataStatus === 'fallback' ||
      state.embeddedMetadataStatus === 'pending' ||
      state.embeddedMetadataStatus === 'reading'
    );
  }

  private isMissingOrDefaultCover(state: StoredTrackCoverState): boolean {
    return !state.coverId || state.coverSource === 'default' || !this.hasCompleteCoverCache(state);
  }

  private canRepairCoverCache(state: StoredTrackCoverState): boolean {
    return Boolean(
      state.coverId &&
        state.coverSource &&
        state.sourceHash &&
        state.originalRef &&
        existsSync(state.originalRef),
    );
  }

  private hasIdentityObservation(state: StoredTrackCoverState): boolean {
    return Boolean(state.identityStatus && (state.quickHash || state.fileIdentity || state.identityStatus === 'unsupported' || state.identityStatus === 'error'));
  }

  private observeFileIdentity(filePath: string): FileIdentityObservation {
    try {
      return this.fileIdentityService.observe(filePath);
    } catch (error) {
      return {
        fileIdentity: null,
        fileIdentitySource: 'error',
        quickHash: null,
        quickHashVersion: QUICK_HASH_VERSION,
        identityStatus: 'error',
        identityUpdatedAt: new Date().toISOString(),
        identityError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private toTrackIdentityWrite(identity: FileIdentityObservation | null): {
    fileIdentity?: string | null;
    fileIdentitySource?: FileIdentityObservation['fileIdentitySource'];
    quickHash?: string | null;
    quickHashVersion?: number;
    identityStatus?: FileIdentityObservation['identityStatus'];
    identityUpdatedAt?: string;
    identityError?: string | null;
  } {
    if (!identity) {
      return {};
    }

    return {
      fileIdentity: identity.fileIdentity,
      fileIdentitySource: identity.fileIdentitySource,
      quickHash: identity.quickHash,
      quickHashVersion: identity.quickHashVersion,
      identityStatus: identity.identityStatus,
      identityUpdatedAt: identity.identityUpdatedAt,
      identityError: identity.identityError,
    };
  }

  private async processWithConcurrency<T>(
    items: T[],
    concurrency: number,
    worker: (item: T) => Promise<void>,
  ): Promise<void> {
    let nextIndex = 0;
    const workerCount = Math.min(Math.max(1, concurrency), items.length);

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (nextIndex < items.length) {
          const currentIndex = nextIndex;
          nextIndex += 1;
          await worker(items[currentIndex]);
        }
      }),
    );
  }
}
