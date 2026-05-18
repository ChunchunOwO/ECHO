import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations';
import { assertDatabaseHealthy, DatabaseHealthError } from './health';

export type EchoDatabase = Database.Database;

const quarantineTimestamp = (): string => new Date().toISOString().replace(/[:.]/g, '-');

const quarantinePathFor = (sourcePath: string, timestamp: string): string =>
  join(dirname(sourcePath), `${basename(sourcePath)}.corrupt-${timestamp}`);

const assertOpenedDatabaseHealthy = (database: EchoDatabase, databasePath: string): void => {
  const row = database.prepare<[], Record<string, unknown>>('PRAGMA quick_check(1)').get();
  const result = String(Object.values(row ?? {})[0] ?? '');

  if (result !== 'ok') {
    throw new Error(`Database quick_check failed after opening ${databasePath}: ${result || 'unknown error'}`);
  }
};

export const quarantineCorruptDatabase = (databasePath: string): string => {
  const timestamp = quarantineTimestamp();
  const quarantinedDatabasePath = quarantinePathFor(databasePath, timestamp);
  const candidates = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].filter((sourcePath) =>
    existsSync(sourcePath),
  );
  const renamed: Array<{ sourcePath: string; targetPath: string }> = [];

  try {
    for (const sourcePath of candidates) {
      const targetPath = quarantinePathFor(sourcePath, timestamp);
      renameSync(sourcePath, targetPath);
      renamed.push({ sourcePath, targetPath });
    }
  } catch (error) {
    for (const { sourcePath, targetPath } of [...renamed].reverse()) {
      try {
        if (existsSync(targetPath) && !existsSync(sourcePath)) {
          renameSync(targetPath, sourcePath);
        }
      } catch {
        // Leave the original failure intact; manual recovery can use the .corrupt copy.
      }
    }

    throw error;
  }

  return quarantinedDatabasePath;
};

export const createDatabase = (databasePath: string): EchoDatabase => {
  if (databasePath !== ':memory:') {
    mkdirSync(dirname(databasePath), { recursive: true });
    try {
      assertDatabaseHealthy(databasePath);
    } catch (error) {
      if (error instanceof DatabaseHealthError && error.health.status === 'corrupt') {
        const quarantinedPath = quarantineCorruptDatabase(databasePath);
        console.warn(
          `[database] Corrupt SQLite database was quarantined at ${quarantinedPath}; creating a clean database.`,
          error,
        );
      } else {
        throw error;
      }
    }
  }

  const database = new Database(databasePath);
  database.pragma('busy_timeout = 5000');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA journal_mode = WAL');
  try {
    runMigrations(database);
    assertOpenedDatabaseHealthy(database, databasePath);
  } catch (error) {
    database.close();
    throw error;
  }

  return database;
};
