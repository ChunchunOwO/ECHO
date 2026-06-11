import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createCipheriv, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectDonatorHwidFileName,
  connectDonatorLicenseFileName,
  connectDonatorUnlockPluginId,
} from '../../shared/constants/featureUnlocks';

const mocks = vi.hoisted(() => ({
  plugins: [] as Array<{
    id: string;
    directory: string;
    enabled: boolean;
    disabledByHost: boolean;
    status: string;
    error: string | null;
  }>,
  decisions: [] as Array<{ feature_id: string; status: string; reason: string }>,
  execSql: [] as string[],
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
  },
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => '    MachineGuid    REG_SZ    TEST-MACHINE-GUID\r\n'),
}));

vi.mock('better-sqlite3', () => ({
  default: class FakeDatabase {
    constructor(readonly databasePath: string) {}
    pragma = vi.fn();
    exec(sql: string): void {
      mocks.execSql.push(sql);
    }
    prepare(sql: string) {
      return {
        run: (featureId: string, _pluginId: string, _hwidHash: string, status: string, reason: string) => {
          mocks.decisions.push({ feature_id: featureId, status, reason });
        },
        get: (featureId: string) => mocks.decisions.find((item) => item.feature_id === featureId) ?? null,
      };
    }
    close = vi.fn();
  },
}));

vi.mock('./PluginService', () => ({
  getPluginService: () => ({
    list: () => ({ directory: 'D:\\Echo\\plugins', plugins: mocks.plugins }),
  }),
}));

const tempRoots: string[] = [];

const createTempRoot = (): string => {
  const root = join(tmpdir(), `echo-connect-unlock-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  tempRoots.push(root);
  return root;
};

const writeAllowList = (pluginDirectory: string, hwidHash: string): void => {
  writeFileSync(
    join(pluginDirectory, connectDonatorHwidFileName),
    `${JSON.stringify({ version: 1, featureId: 'connect', allowedHwids: [hwidHash] }, null, 2)}\n`,
    'utf8',
  );
};

const writeEncryptedLicense = (pluginDirectory: string, hwidHash: string): void => {
  const key = Buffer.from('H1qOend5BTwz+pFWb6M7WGIDphqgnCNne8R9dB9CJLU=', 'base64');
  const iv = randomBytes(12);
  const payload = JSON.stringify({
    version: 1,
    featureId: 'connect',
    pluginId: connectDonatorUnlockPluginId,
    issuedAt: new Date(0).toISOString(),
    hwidHash,
  });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  writeFileSync(
    join(pluginDirectory, connectDonatorLicenseFileName),
    `${JSON.stringify({
      version: 1,
      algorithm: 'aes-256-gcm',
      issuedAt: new Date(0).toISOString(),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    }, null, 2)}\n`,
    'utf8',
  );
};

describe('ConnectDonatorUnlockService', () => {
  beforeEach(() => {
    mocks.plugins = [];
    mocks.decisions = [];
    mocks.execSql = [];
    vi.resetModules();
  });

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates the decision table and blocks when the unlock plugin is missing', async () => {
    const root = createTempRoot();
    const { ConnectDonatorUnlockService } = await import('./ConnectDonatorUnlockService');
    const service = new ConnectDonatorUnlockService(root);

    const status = service.getStatus();

    expect(status).toMatchObject({
      unlocked: false,
      pluginInstalled: false,
      reason: 'plugin-missing',
    });
    expect(status.hwidHash).toMatch(/^[a-f0-9]{64}$/u);
    service.close();

    expect(mocks.execSql.join('\n')).toContain('CREATE TABLE IF NOT EXISTS donator_feature_hwids');
    expect(mocks.decisions.at(-1)).toEqual({ feature_id: 'connect', status: 'blocked', reason: 'plugin-missing' });
  });

  it('unlocks when the enabled plugin has an encrypted license for the current HWID hash', async () => {
    const root = createTempRoot();
    const pluginDirectory = join(root, 'plugins', connectDonatorUnlockPluginId);
    mkdirSync(pluginDirectory, { recursive: true });

    const { ConnectDonatorUnlockService } = await import('./ConnectDonatorUnlockService');
    const service = new ConnectDonatorUnlockService(root);
    const initialStatus = service.getStatus();
    writeEncryptedLicense(pluginDirectory, initialStatus.hwidHash);
    mocks.plugins = [{
      id: connectDonatorUnlockPluginId,
      directory: pluginDirectory,
      enabled: true,
      disabledByHost: false,
      status: 'running',
      error: null,
    }];

    const unlockedStatus = service.getStatus();
    service.close();

    expect(unlockedStatus).toMatchObject({
      unlocked: true,
      pluginInstalled: true,
      pluginEnabled: true,
      reason: 'unlocked',
    });
    expect(readFileSync(join(pluginDirectory, connectDonatorLicenseFileName), 'utf8')).not.toContain(unlockedStatus.hwidHash);
  });

  it('blocks an enabled plugin when the encrypted license belongs to another HWID hash', async () => {
    const root = createTempRoot();
    const pluginDirectory = join(root, 'plugins', connectDonatorUnlockPluginId);
    mkdirSync(pluginDirectory, { recursive: true });
    writeEncryptedLicense(pluginDirectory, '1111111111111111111111111111111111111111111111111111111111111111');
    mocks.plugins = [{
      id: connectDonatorUnlockPluginId,
      directory: pluginDirectory,
      enabled: true,
      disabledByHost: false,
      status: 'running',
      error: null,
    }];

    const { ConnectDonatorUnlockService } = await import('./ConnectDonatorUnlockService');
    const service = new ConnectDonatorUnlockService(root);
    const status = service.getStatus();
    service.close();

    expect(status.unlocked).toBe(false);
    expect(status.reason).toBe('hwid-not-allowed');
  });

  it('keeps legacy HWID allowlist packages working', async () => {
    const root = createTempRoot();
    const pluginDirectory = join(root, 'plugins', connectDonatorUnlockPluginId);
    mkdirSync(pluginDirectory, { recursive: true });

    const { ConnectDonatorUnlockService } = await import('./ConnectDonatorUnlockService');
    const service = new ConnectDonatorUnlockService(root);
    const initialStatus = service.getStatus();
    writeAllowList(pluginDirectory, initialStatus.hwidHash);
    mocks.plugins = [{
      id: connectDonatorUnlockPluginId,
      directory: pluginDirectory,
      enabled: true,
      disabledByHost: false,
      status: 'running',
      error: null,
    }];

    const status = service.getStatus();
    service.close();

    expect(status.unlocked).toBe(true);
    expect(status.reason).toBe('unlocked');
  });
});
