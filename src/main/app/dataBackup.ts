import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { app } from 'electron';
import { strFromU8, strToU8, unzip, zip, type AsyncZippable, type Unzipped } from 'fflate';
import type {
  DataBackupExportResult,
  DataBackupImportResult,
  DataBackupRunReason,
  DataBackupStatus,
} from '../../shared/types/settingsBackup';
import type { AppSettings } from '../../shared/types/appSettings';
import { checkDatabaseHealth } from '../database/health';
import { getLibraryDatabaseManager } from '../database/LibraryDatabaseManager';
import { ensureCoverCacheDirectory, getDefaultCoverCacheDir } from '../library/CoverCacheManager';
import { getLibraryService } from '../library/LibraryService';
import { getAppSettings, normalizeSettings, setAppSettings } from './appSettings';
import { checkpointProtectedLibrary, createDataProtectionSnapshot, protectedDataEntries } from './dataProtection';

const dataBackupFormat = 'echo-next-user-data-backup';
const dataBackupVersion = 1;
const libraryFileName = 'echo-library.sqlite';
const libraryWalFileName = `${libraryFileName}-wal`;
const libraryShmFileName = `${libraryFileName}-shm`;
const libraryEntryNames = new Set([libraryFileName, libraryWalFileName, libraryShmFileName]);
const metadataFileNames = ['echo-download-jobs.json'];
const runtimeCacheDirectories = ['smtc-covers', 'artist-images'];
const importArchiveDirectoryName = 'data-backup-import-archives';
const initialAutoBackupDelayMs = 90_000;
const minRescheduleDelayMs = 15_000;
const maxTimerDelayMs = 2_147_000_000;
const dayMs = 24 * 60 * 60 * 1000;

type ZipFiles = AsyncZippable;
type Manifest = {
  format: typeof dataBackupFormat;
  version: typeof dataBackupVersion;
  exportedAt: string;
  reason: DataBackupRunReason;
  appVersion: string;
  database: {
    health: ReturnType<typeof checkDatabaseHealth>;
    backupMethod: 'none' | 'sqlite-backup' | 'file-copy';
  };
  settingsFile: string;
  entries: string[];
};

let schedulerTimer: NodeJS.Timeout | null = null;
let schedulerNextBackupAt: string | null = null;
let runningBackup: Promise<DataBackupExportResult> | null = null;

const timestampForPath = (date = new Date()): string => date.toISOString().replace(/[:.]/g, '-');

const yieldToEventLoop = (): Promise<void> => new Promise((resolveYield) => setTimeout(resolveYield, 0));

const toZipText = (value: unknown): Uint8Array => strToU8(`${JSON.stringify(value, null, 2)}\n`);

const safeZipPath = (path: string): string =>
  path.split(sep).join('/').replace(/\\/g, '/').replace(/^\/+/u, '').replace(/(?:^|\/)\.\.(?=\/|$)/gu, '_');

const safeRelativeZipPath = (zipRoot: string, sourceRoot: string, sourcePath: string): string =>
  safeZipPath(`${zipRoot}/${relative(sourceRoot, sourcePath)}`);

const isInsideDirectory = (directory: string, targetPath: string): boolean => {
  const relativePath = relative(resolve(directory), resolve(targetPath));
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
};

const isExcluded = (targetPath: string, excludedPaths: string[]): boolean =>
  excludedPaths.some((excludedPath) => isInsideDirectory(excludedPath, targetPath));

const addFileToZip = async (
  files: ZipFiles,
  entryPath: string,
  sourcePath: string,
  warnings: string[],
  includedEntries: string[],
  skippedEntries: string[],
): Promise<void> => {
  try {
    if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
      skippedEntries.push(entryPath);
      return;
    }

    const content = await readFile(sourcePath);
    const zipPath = safeZipPath(entryPath);
    files[zipPath] = new Uint8Array(content);
    includedEntries.push(zipPath);
  } catch (error) {
    skippedEntries.push(entryPath);
    warnings.push(`${entryPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const addDirectoryToZip = async (
  files: ZipFiles,
  zipRoot: string,
  sourceRoot: string,
  warnings: string[],
  includedEntries: string[],
  skippedEntries: string[],
  excludedPaths: string[] = [],
): Promise<void> => {
  if (!existsSync(sourceRoot)) {
    skippedEntries.push(zipRoot);
    return;
  }

  let walkedFiles = 0;
  const walk = async (directory: string): Promise<void> => {
    if (isExcluded(directory, excludedPaths)) {
      return;
    }

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      warnings.push(`${safeZipPath(`${zipRoot}/${relative(sourceRoot, directory)}`)}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    for (const entry of entries) {
      const sourcePath = join(directory, entry.name);
      if (isExcluded(sourcePath, excludedPaths)) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(sourcePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      await addFileToZip(files, safeRelativeZipPath(zipRoot, sourceRoot, sourcePath), sourcePath, warnings, includedEntries, skippedEntries);
      walkedFiles += 1;
      if (walkedFiles % 80 === 0) {
        await yieldToEventLoop();
      }
    }
  };

  await walk(sourceRoot);
};

const zipAsync = (files: AsyncZippable): Promise<Uint8Array> =>
  new Promise((resolveZip, rejectZip) => {
    zip(files, { consume: true, level: 1 }, (error, data) => {
      if (error) {
        rejectZip(error);
        return;
      }

      resolveZip(data);
    });
  });

const unzipAsync = (content: Uint8Array): Promise<Unzipped> =>
  new Promise((resolveUnzip, rejectUnzip) => {
    unzip(content, (error, data) => {
      if (error) {
        rejectUnzip(error);
        return;
      }

      resolveUnzip(data);
    });
  });

const writeZipAtomically = async (outputPath: string, files: AsyncZippable): Promise<number> => {
  const outputDirectory = dirname(outputPath);
  const tempPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(outputDirectory, { recursive: true });

  try {
    const zipBytes = await zipAsync(files);
    await writeFile(tempPath, Buffer.from(zipBytes));
    rmSync(outputPath, { force: true, maxRetries: 3, retryDelay: 50 });
    await rename(tempPath, outputPath);
    return statSync(outputPath).size;
  } catch (error) {
    rmSync(tempPath, { force: true, maxRetries: 3, retryDelay: 50 });
    throw error;
  }
};

const createRestoreReadme = (): string => `# ECHO Next 数据备份

这个备份用于恢复 ECHO Next 的用户数据。它包含设置、曲库索引、账号本地状态、播放记忆、均衡器预设、壁纸、封面缓存和运行时缓存。

导入前 ECHO Next 会先归档当前数据；如果备份里的曲库数据库没有通过健康检查，导入会被拒绝。

备份可能包含账号令牌等敏感信息，请只保存到你信任的磁盘或同步目录。
`;

const createBackupPath = (directory: string, date = new Date()): string =>
  join(directory, `ECHO-NEXT-backup-${timestampForPath(date)}.zip`);

const getDefaultCoverCachePath = (userDataPath: string): string =>
  getDefaultCoverCacheDir(join(userDataPath, libraryFileName));

const resolveCoverCacheSource = (userDataPath: string, settings: AppSettings, warnings: string[]): string => {
  try {
    return getLibraryService().getCoverCacheDir();
  } catch (error) {
    warnings.push(`Cover cache path resolved without library service: ${error instanceof Error ? error.message : String(error)}`);
    return settings.coverCacheDir ? resolve(settings.coverCacheDir) : getDefaultCoverCachePath(userDataPath);
  }
};

const assertSnapshotIsHealthy = (snapshot: Awaited<ReturnType<typeof createDataProtectionSnapshot>>, userDataPath: string): void => {
  const activeDatabasePath = join(userDataPath, libraryFileName);
  const snapshotDatabasePath = join(snapshot.snapshotPath, libraryFileName);
  if (!existsSync(activeDatabasePath)) {
    return;
  }

  if (snapshot.libraryHealth.status !== 'ok' || !existsSync(snapshotDatabasePath)) {
    throw new Error(`曲库数据库未通过健康检查，已拒绝备份：${snapshot.libraryHealth.message ?? snapshot.libraryHealth.status}`);
  }
};

export const exportEchoUserDataBackup = async (
  outputPath: string,
  options: { reason?: DataBackupRunReason; date?: Date } = {},
): Promise<DataBackupExportResult> => {
  const exportedAtDate = options.date ?? new Date();
  const exportedAt = exportedAtDate.toISOString();
  const reason = options.reason ?? 'manual';
  const userDataPath = app.getPath('userData');
  const settings = getAppSettings();
  const warnings: string[] = [];
  const includedEntries: string[] = [];
  const skippedEntries: string[] = [];
  const files: ZipFiles = {};
  const backupDirectory = dirname(outputPath);

  checkpointProtectedLibrary(userDataPath);
  const snapshot = await createDataProtectionSnapshot('manual-library-database-snapshot', userDataPath, exportedAtDate);
  assertSnapshotIsHealthy(snapshot, userDataPath);

  for (const entry of protectedDataEntries) {
    const sourcePath = join(snapshot.snapshotPath, entry.name);
    const entryPath = `user-data/${entry.name}`;
    if (entry.kind === 'directory') {
      await addDirectoryToZip(files, entryPath, sourcePath, warnings, includedEntries, skippedEntries, [backupDirectory]);
    } else {
      await addFileToZip(files, entryPath, sourcePath, warnings, includedEntries, skippedEntries);
    }
  }

  for (const name of metadataFileNames) {
    await addFileToZip(files, `user-data/${name}`, join(userDataPath, name), warnings, includedEntries, skippedEntries);
  }

  for (const name of runtimeCacheDirectories) {
    await addDirectoryToZip(files, `user-data/${name}`, join(userDataPath, name), warnings, includedEntries, skippedEntries, [backupDirectory]);
  }

  const coverCacheSource = resolveCoverCacheSource(userDataPath, settings, warnings);
  await addDirectoryToZip(files, 'cache/cover-cache', coverCacheSource, warnings, includedEntries, skippedEntries, [backupDirectory]);

  files['manifest.json'] = toZipText({
    format: dataBackupFormat,
    version: dataBackupVersion,
    exportedAt,
    reason,
    appVersion: app.getVersion(),
    userDataPath,
    settingsFile: 'user-data/echo-settings.json',
    database: {
      health: snapshot.libraryHealth,
      backupMethod: snapshot.libraryBackupMethod,
    },
    coverCache: {
      sourcePath: coverCacheSource,
      restoredFrom: 'cache/cover-cache',
    },
    snapshot: {
      sourcePath: snapshot.snapshotPath,
      copied: snapshot.copied,
      skipped: snapshot.skipped,
    },
    entries: Object.keys(files).sort(),
  } satisfies Manifest & Record<string, unknown>);
  files['RESTORE.md'] = strToU8(createRestoreReadme());

  const sizeBytes = await writeZipAtomically(outputPath, files);
  return {
    filePath: outputPath,
    exportedAt,
    reason,
    snapshotPath: snapshot.snapshotPath,
    includedEntries: Object.keys(files).sort(),
    skippedEntries: Array.from(new Set(skippedEntries)).sort(),
    warnings,
    sizeBytes,
  };
};

const readManifest = (unzipped: Unzipped): Manifest => {
  const manifestBytes = unzipped['manifest.json'];
  if (!manifestBytes) {
    throw new Error('备份文件缺少 manifest.json。');
  }

  const manifest = JSON.parse(strFromU8(manifestBytes)) as Partial<Manifest>;
  if (manifest.format !== dataBackupFormat || manifest.version !== dataBackupVersion) {
    throw new Error('选中的文件不是受支持的 ECHO Next 数据备份。');
  }

  return manifest as Manifest;
};

const getZipFile = (unzipped: Unzipped, path: string): Uint8Array | null => unzipped[safeZipPath(path)] ?? null;

const readSettingsFromBackup = (unzipped: Unzipped): AppSettings => {
  const settingsBytes = getZipFile(unzipped, 'user-data/echo-settings.json');
  if (!settingsBytes) {
    throw new Error('备份文件缺少设置文件。');
  }

  return normalizeSettings(JSON.parse(strFromU8(settingsBytes)) as unknown);
};

const resolveRestoreTarget = (root: string, relativeZipPath: string): string => {
  const cleanRelativePath = relativeZipPath.replace(/\\/g, '/').replace(/^\/+/u, '');
  if (!cleanRelativePath || cleanRelativePath.split('/').some((part) => part === '..' || part === '')) {
    throw new Error(`备份内路径不安全：${relativeZipPath}`);
  }

  const targetPath = resolve(root, ...cleanRelativePath.split('/'));
  if (!isInsideDirectory(root, targetPath)) {
    throw new Error(`备份内路径越界：${relativeZipPath}`);
  }

  return targetPath;
};

const restoreFile = async (
  unzipped: Unzipped,
  zipPath: string,
  targetPath: string,
  restoredEntries: string[],
  skippedEntries: string[],
): Promise<void> => {
  const bytes = getZipFile(unzipped, zipPath);
  if (!bytes) {
    skippedEntries.push(zipPath);
    return;
  }

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, Buffer.from(bytes));
  restoredEntries.push(zipPath);
};

const restoreDirectory = async (
  unzipped: Unzipped,
  zipRoot: string,
  targetRoot: string,
  restoredEntries: string[],
  skippedEntries: string[],
): Promise<void> => {
  const normalizedRoot = `${safeZipPath(zipRoot).replace(/\/$/u, '')}/`;
  const entries = Object.entries(unzipped).filter(([entryPath]) => entryPath.startsWith(normalizedRoot));
  if (entries.length === 0) {
    skippedEntries.push(zipRoot);
    return;
  }

  await rm(targetRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  for (const [entryPath, bytes] of entries) {
    const relativeZipPath = entryPath.slice(normalizedRoot.length);
    const targetPath = resolveRestoreTarget(targetRoot, relativeZipPath);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, Buffer.from(bytes));
    restoredEntries.push(entryPath);
  }
};

const createRollbackArchive = async (userDataPath: string, date: Date): Promise<string | null> => {
  const rollbackDirectory = join(userDataPath, 'data-protection', importArchiveDirectoryName);
  const rollbackPath = join(rollbackDirectory, `before-data-backup-import-${timestampForPath(date)}.zip`);
  const warnings: string[] = [];
  const includedEntries: string[] = [];
  const skippedEntries: string[] = [];
  const files: ZipFiles = {};

  for (const entry of protectedDataEntries) {
    const sourcePath = join(userDataPath, entry.name);
    if (entry.kind === 'directory') {
      await addDirectoryToZip(files, `user-data/${entry.name}`, sourcePath, warnings, includedEntries, skippedEntries, [rollbackDirectory]);
    } else {
      await addFileToZip(files, `user-data/${entry.name}`, sourcePath, warnings, includedEntries, skippedEntries);
    }
  }
  for (const name of metadataFileNames) {
    await addFileToZip(files, `user-data/${name}`, join(userDataPath, name), warnings, includedEntries, skippedEntries);
  }
  for (const name of runtimeCacheDirectories) {
    await addDirectoryToZip(files, `user-data/${name}`, join(userDataPath, name), warnings, includedEntries, skippedEntries, [rollbackDirectory]);
  }

  files['manifest.json'] = toZipText({
    format: 'echo-next-import-rollback-archive',
    version: 1,
    exportedAt: date.toISOString(),
    note: 'Created before importing an ECHO Next data backup.',
    entries: Object.keys(files).sort(),
    warnings,
  });

  if (Object.keys(files).length <= 1) {
    return null;
  }

  await writeZipAtomically(rollbackPath, files);
  return rollbackPath;
};

const validateBackupDatabase = async (unzipped: Unzipped, userDataPath: string, date: Date): Promise<void> => {
  const databaseBytes = getZipFile(unzipped, 'user-data/echo-library.sqlite');
  if (!databaseBytes) {
    return;
  }

  const tempDirectory = join(userDataPath, 'data-protection', 'restore-validation', timestampForPath(date));
  const tempDatabasePath = join(tempDirectory, libraryFileName);
  await mkdir(tempDirectory, { recursive: true });
  try {
    await writeFile(tempDatabasePath, Buffer.from(databaseBytes));
    const health = checkDatabaseHealth(tempDatabasePath);
    if (health.status !== 'ok') {
      throw new Error(`备份内曲库数据库未通过健康检查：${health.message ?? health.status}`);
    }
  } finally {
    await rm(tempDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
};

const resolveCoverCacheRestoreTarget = async (
  userDataPath: string,
  settings: AppSettings,
  warnings: string[],
): Promise<{ settings: AppSettings; targetPath: string }> => {
  const defaultPath = getDefaultCoverCachePath(userDataPath);
  const preferredPath = settings.coverCacheDir ? resolve(settings.coverCacheDir) : defaultPath;

  try {
    await ensureCoverCacheDirectory(preferredPath);
    return { settings, targetPath: preferredPath };
  } catch (error) {
    warnings.push(`封面缓存目录不可用，已恢复到默认目录：${error instanceof Error ? error.message : String(error)}`);
    await ensureCoverCacheDirectory(defaultPath);
    return { settings: normalizeSettings({ ...settings, coverCacheDir: null }), targetPath: defaultPath };
  }
};

export const importEchoUserDataBackup = async (backupPath: string, date = new Date()): Promise<DataBackupImportResult> => {
  const importedAt = date.toISOString();
  const userDataPath = app.getPath('userData');
  const warnings: string[] = [];
  const restoredEntries: string[] = [];
  const skippedEntries: string[] = [];
  const unzipped = await unzipAsync(new Uint8Array(await readFile(backupPath)));
  readManifest(unzipped);
  const importedSettings = readSettingsFromBackup(unzipped);
  const coverCache = await resolveCoverCacheRestoreTarget(userDataPath, importedSettings, warnings);
  await validateBackupDatabase(unzipped, userDataPath, date);

  try {
    const libraryService = getLibraryService();
    if (libraryService.hasRunningJobs()) {
      throw new Error('曲库扫描运行中，暂时不能导入备份。');
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('曲库扫描运行中')) {
      throw error;
    }
  }

  const manager = getLibraryDatabaseManager();
  const rollbackBackupPath = await manager.runExclusiveMaintenance('data-backup-import', async () => {
    const rollbackPath = await createRollbackArchive(userDataPath, date);

    for (const entry of protectedDataEntries) {
      if (entry.name === 'echo-settings.json') {
        continue;
      }
      if (libraryEntryNames.has(entry.name)) {
        continue;
      }
      if (entry.kind === 'directory') {
        await restoreDirectory(unzipped, `user-data/${entry.name}`, join(userDataPath, entry.name), restoredEntries, skippedEntries);
      } else {
        await restoreFile(unzipped, `user-data/${entry.name}`, join(userDataPath, entry.name), restoredEntries, skippedEntries);
      }
    }

    for (const name of metadataFileNames) {
      await restoreFile(unzipped, `user-data/${name}`, join(userDataPath, name), restoredEntries, skippedEntries);
    }
    for (const name of runtimeCacheDirectories) {
      await restoreDirectory(unzipped, `user-data/${name}`, join(userDataPath, name), restoredEntries, skippedEntries);
    }

    const databaseBytes = getZipFile(unzipped, 'user-data/echo-library.sqlite');
    if (databaseBytes) {
      rmSync(join(userDataPath, libraryWalFileName), { force: true, maxRetries: 3, retryDelay: 50 });
      rmSync(join(userDataPath, libraryShmFileName), { force: true, maxRetries: 3, retryDelay: 50 });
      await restoreFile(unzipped, 'user-data/echo-library.sqlite', join(userDataPath, libraryFileName), restoredEntries, skippedEntries);
      const restoredHealth = checkDatabaseHealth(join(userDataPath, libraryFileName));
      if (restoredHealth.status !== 'ok') {
        throw new Error(`导入后的曲库数据库未通过健康检查：${restoredHealth.message ?? restoredHealth.status}`);
      }
    } else {
      skippedEntries.push('user-data/echo-library.sqlite');
    }

    await restoreDirectory(unzipped, 'cache/cover-cache', coverCache.targetPath, restoredEntries, skippedEntries);
    return rollbackPath;
  });

  return {
    importedAt,
    importedPath: backupPath,
    rollbackBackupPath,
    restoredEntries: Array.from(new Set(restoredEntries)).sort(),
    skippedEntries: Array.from(new Set(skippedEntries)).sort(),
    warnings,
    settings: coverCache.settings,
  };
};

const parseBackupTime = (value: string | null | undefined): number | null => {
  if (!value) {
    return null;
  }

  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
};

const calculateNextBackupAt = (settings: AppSettings, fromTime = Date.now()): string | null => {
  if (settings.autoDataBackupEnabled !== true || !settings.autoDataBackupDirectory) {
    return null;
  }

  const lastRunTime = parseBackupTime(settings.autoDataBackupLastRunAt);
  if (lastRunTime === null) {
    return new Date(fromTime + initialAutoBackupDelayMs).toISOString();
  }

  return new Date(lastRunTime + (settings.autoDataBackupIntervalDays ?? 7) * dayMs).toISOString();
};

export const getDataBackupStatus = (): DataBackupStatus => {
  const settings = getAppSettings();
  return {
    enabled: settings.autoDataBackupEnabled === true,
    directory: settings.autoDataBackupDirectory ?? null,
    intervalDays: settings.autoDataBackupIntervalDays ?? 7,
    lastBackupAt: settings.autoDataBackupLastRunAt ?? null,
    lastBackupPath: settings.autoDataBackupLastPath ?? null,
    lastError: settings.autoDataBackupLastError ?? null,
    nextBackupAt: schedulerNextBackupAt ?? calculateNextBackupAt(settings),
    running: runningBackup !== null,
  };
};

export const runDataBackupNow = async (reason: DataBackupRunReason = 'manual'): Promise<DataBackupExportResult> => {
  if (runningBackup) {
    return runningBackup;
  }

  const settings = getAppSettings();
  if (!settings.autoDataBackupDirectory) {
    throw new Error('请先选择自动备份目录。');
  }

  const outputPath = createBackupPath(settings.autoDataBackupDirectory);
  runningBackup = exportEchoUserDataBackup(outputPath, { reason })
    .then((result) => {
      setAppSettings({
        autoDataBackupLastRunAt: result.exportedAt,
        autoDataBackupLastPath: result.filePath,
        autoDataBackupLastError: null,
      });
      return result;
    })
    .catch((error) => {
      setAppSettings({
        autoDataBackupLastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    })
    .finally(() => {
      runningBackup = null;
      refreshDataBackupScheduler();
    });

  return runningBackup;
};

export const refreshDataBackupScheduler = (): void => {
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }

  const settings = getAppSettings();
  const nextBackupAt = calculateNextBackupAt(settings);
  schedulerNextBackupAt = nextBackupAt;
  if (!nextBackupAt) {
    return;
  }

  const dueInMs = new Date(nextBackupAt).getTime() - Date.now();
  const delayMs = Math.min(maxTimerDelayMs, Math.max(minRescheduleDelayMs, dueInMs));
  schedulerTimer = setTimeout(() => {
    schedulerTimer = null;
    void runDataBackupNow('automatic').catch(() => undefined);
  }, delayMs);
};

export const initializeDataBackupScheduler = (): void => {
  refreshDataBackupScheduler();
};

export const disposeDataBackupScheduler = (): void => {
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
  schedulerNextBackupAt = null;
};
