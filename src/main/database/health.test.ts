import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from './createDatabase';
import { checkDatabaseHealth, isSqliteCorruptionMessage } from './health';

describe('database health', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'echo-db-health-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('passes quick_check for a healthy SQLite database before migrations', () => {
    const databasePath = join(root, 'library.sqlite');
    const database = new Database(databasePath);
    database.exec('CREATE TABLE sample (id TEXT PRIMARY KEY)');
    database.close();

    expect(checkDatabaseHealth(databasePath).status).toBe('ok');
    const opened = createDatabase(databasePath);
    expect(opened.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tracks'").get()).toBeTruthy();
    opened.close();
  });

  it('quarantines a malformed database before creating a clean replacement', () => {
    const databasePath = join(root, 'library.sqlite');
    writeFileSync(databasePath, 'not sqlite', 'utf8');
    writeFileSync(`${databasePath}-wal`, 'stale wal', 'utf8');
    writeFileSync(`${databasePath}-shm`, 'stale shm', 'utf8');

    expect(checkDatabaseHealth(databasePath).status).toBe('corrupt');
    const opened = createDatabase(databasePath);

    expect(opened.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tracks'").get()).toBeTruthy();
    opened.close();
    expect(checkDatabaseHealth(databasePath).status).toBe('ok');
    expect(readdirSync(root).some((entry) => entry.startsWith('library.sqlite.corrupt-'))).toBe(true);
    expect(readdirSync(root).some((entry) => entry.startsWith('library.sqlite-wal.corrupt-'))).toBe(true);
    expect(readdirSync(root).some((entry) => entry.startsWith('library.sqlite-shm.corrupt-'))).toBe(true);
  });

  it('treats malformed database schema errors as corruption', () => {
    expect(isSqliteCorruptionMessage('malformed database schema (6301a741-3d56-407f-a3d6-77e5a19a8416)')).toBe(true);
  });
});
