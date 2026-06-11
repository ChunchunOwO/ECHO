import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createDecipheriv, createHash } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import Database from 'better-sqlite3';
import {
  connectDonatorHwidFileName,
  connectDonatorLicenseFileName,
  connectDonatorUnlockFeatureId,
  connectDonatorUnlockPluginId,
  connectDonatorUnlockVersion,
  type ConnectDonatorUnlockReason,
  type ConnectDonatorUnlockStatus,
} from '../../shared/constants/featureUnlocks';
import { getPluginService } from './PluginService';

type HwidAllowList = {
  allowedHwids?: unknown;
  hwids?: unknown;
};

type EncryptedDonatorLicenseFile = {
  version?: unknown;
  algorithm?: unknown;
  iv?: unknown;
  tag?: unknown;
  ciphertext?: unknown;
};

type DonatorLicensePayload = {
  version?: unknown;
  featureId?: unknown;
  pluginId?: unknown;
  hwidHash?: unknown;
  issuedAt?: unknown;
};

type HwidDecisionStatus = 'allowed' | 'blocked';

const hwidHashPattern = /^[a-f0-9]{64}$/u;
const donatorLicenseVersion = 1;
const donatorLicenseAlgorithm = 'aes-256-gcm';
const donatorLicenseKey = Buffer.from('H1qOend5BTwz+pFWb6M7WGIDphqgnCNne8R9dB9CJLU=', 'base64');
const decisionTableSql = `
CREATE TABLE IF NOT EXISTS donator_feature_hwids (
  feature_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  hwid_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_checksum TEXT,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (feature_id, plugin_id, hwid_hash)
);

CREATE INDEX IF NOT EXISTS idx_donator_feature_hwids_feature_status
ON donator_feature_hwids(feature_id, status);
`;

const nowIso = (): string => new Date().toISOString();

const hashText = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const getWindowsMachineGuid = (): string | null => {
  if (process.platform !== 'win32') {
    return null;
  }

  try {
    const output = execFileSync(
      'reg',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { encoding: 'utf8', timeout: 1_500, windowsHide: true },
    );
    const match = /MachineGuid\s+REG_\w+\s+([^\r\n]+)/iu.exec(output);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
};

const getRawMachineIdentity = (): string => {
  const machineGuid = getWindowsMachineGuid();
  if (machineGuid) {
    return `win:${machineGuid}`;
  }

  let username = 'unknown';
  try {
    username = userInfo().username || username;
  } catch {
    // Fall back to host-only identity.
  }

  return `${process.platform}:${hostname()}:${username}`;
};

const normalizeAllowedHwids = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const allowed: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const normalized = item.trim().toLowerCase();
    if (hwidHashPattern.test(normalized) && !allowed.includes(normalized)) {
      allowed.push(normalized);
    }
  }
  return allowed;
};

const text = (value: unknown): string | null => (typeof value === 'string' ? value.trim() : null);

const decryptDonatorLicensePayload = (file: EncryptedDonatorLicenseFile): DonatorLicensePayload | null => {
  if (
    file.version !== donatorLicenseVersion ||
    file.algorithm !== donatorLicenseAlgorithm ||
    typeof file.iv !== 'string' ||
    typeof file.tag !== 'string' ||
    typeof file.ciphertext !== 'string'
  ) {
    return null;
  }

  try {
    const iv = Buffer.from(file.iv, 'base64');
    const tag = Buffer.from(file.tag, 'base64');
    const ciphertext = Buffer.from(file.ciphertext, 'base64');
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
      return null;
    }
    const decipher = createDecipheriv(donatorLicenseAlgorithm, donatorLicenseKey, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(plaintext) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export class ConnectDonatorUnlockService {
  private readonly databasePath: string;
  private database: Database.Database | null = null;
  private hwidHash: string | null = null;

  constructor(userDataPath = app.getPath('userData')) {
    this.databasePath = join(userDataPath, 'echo-feature-unlocks.sqlite');
  }

  getStatus(): ConnectDonatorUnlockStatus {
    const checkedAt = nowIso();
    const hwidHash = this.getHwidHash();
    const plugin = getPluginService().list().plugins.find((item) => item.id === connectDonatorUnlockPluginId) ?? null;
    const baseStatus = {
      featureId: connectDonatorUnlockFeatureId,
      pluginId: connectDonatorUnlockPluginId,
      requiredVersion: connectDonatorUnlockVersion,
      hwidHash,
      checkedAt,
      pluginInstalled: Boolean(plugin),
      pluginEnabled: plugin?.enabled === true && plugin.disabledByHost !== true && plugin.status !== 'disabled',
    } satisfies Omit<ConnectDonatorUnlockStatus, 'reason' | 'unlocked'>;

    if (!plugin) {
      return this.finishStatus(baseStatus, false, 'plugin-missing', null);
    }
    if (plugin.error || plugin.disabledByHost === true) {
      return this.finishStatus(baseStatus, false, 'plugin-error', null);
    }
    if (!baseStatus.pluginEnabled) {
      return this.finishStatus(baseStatus, false, 'plugin-disabled', null);
    }

    const licensePath = join(plugin.directory, connectDonatorLicenseFileName);
    if (existsSync(licensePath)) {
      try {
        const raw = readFileSync(licensePath, 'utf8');
        const parsed = JSON.parse(raw) as EncryptedDonatorLicenseFile;
        const license = decryptDonatorLicensePayload(parsed);
        const licenseHwidHash = text(license?.hwidHash)?.toLowerCase() ?? '';
        if (
          !license ||
          license.version !== donatorLicenseVersion ||
          license.featureId !== connectDonatorUnlockFeatureId ||
          license.pluginId !== connectDonatorUnlockPluginId ||
          !hwidHashPattern.test(licenseHwidHash)
        ) {
          return this.finishStatus(baseStatus, false, 'license-invalid', hashText(raw));
        }
        if (licenseHwidHash !== hwidHash) {
          return this.finishStatus(baseStatus, false, 'hwid-not-allowed', hashText(raw));
        }
        return this.finishStatus(baseStatus, true, 'unlocked', hashText(raw));
      } catch {
        return this.finishStatus(baseStatus, false, 'license-invalid', null);
      }
    }

    const allowListPath = join(plugin.directory, connectDonatorHwidFileName);
    if (!existsSync(allowListPath)) {
      return this.finishStatus(baseStatus, false, 'hwid-file-missing', null);
    }

    try {
      const raw = readFileSync(allowListPath, 'utf8');
      const parsed = JSON.parse(raw) as HwidAllowList;
      const allowedHwids = normalizeAllowedHwids(parsed.allowedHwids ?? parsed.hwids);
      if (allowedHwids.length === 0) {
        return this.finishStatus(baseStatus, false, 'hwid-file-invalid', hashText(raw));
      }
      if (!allowedHwids.includes(hwidHash)) {
        return this.finishStatus(baseStatus, false, 'hwid-not-allowed', hashText(raw));
      }
      return this.finishStatus(baseStatus, true, 'unlocked', hashText(raw));
    } catch {
      return this.finishStatus(baseStatus, false, 'hwid-file-invalid', null);
    }
  }

  assertUnlocked(): ConnectDonatorUnlockStatus {
    const status = this.getStatus();
    if (!status.unlocked) {
      throw new Error(status.reason === 'hwid-not-allowed' ? 'connect_hwid_not_allowed' : 'connect_donator_unlock_required');
    }
    return status;
  }

  close(): void {
    this.database?.close();
    this.database = null;
  }

  private finishStatus(
    status: Omit<ConnectDonatorUnlockStatus, 'reason' | 'unlocked'>,
    unlocked: boolean,
    reason: ConnectDonatorUnlockReason,
    sourceChecksum: string | null,
  ): ConnectDonatorUnlockStatus {
    this.recordDecision(status.hwidHash, unlocked ? 'allowed' : 'blocked', reason, sourceChecksum, status.checkedAt);
    return { ...status, unlocked, reason };
  }

  private getHwidHash(): string {
    this.hwidHash ??= hashText(`echo-connect-donator:${getRawMachineIdentity()}`);
    return this.hwidHash;
  }

  private getDatabase(): Database.Database {
    if (!this.database) {
      mkdirSync(dirname(this.databasePath), { recursive: true });
      this.database = new Database(this.databasePath);
      this.database.pragma('journal_mode = WAL');
      this.database.pragma('synchronous = NORMAL');
      this.database.exec(decisionTableSql);
    }
    return this.database;
  }

  private recordDecision(
    hwidHash: string,
    status: HwidDecisionStatus,
    reason: ConnectDonatorUnlockReason,
    sourceChecksum: string | null,
    checkedAt: string,
  ): void {
    this.getDatabase()
      .prepare(`
        INSERT INTO donator_feature_hwids (
          feature_id, plugin_id, hwid_hash, status, reason, source_checksum, checked_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(feature_id, plugin_id, hwid_hash) DO UPDATE SET
          status = excluded.status,
          reason = excluded.reason,
          source_checksum = excluded.source_checksum,
          checked_at = excluded.checked_at
      `)
      .run(
        connectDonatorUnlockFeatureId,
        connectDonatorUnlockPluginId,
        hwidHash,
        status,
        reason,
        sourceChecksum,
        checkedAt,
      );
  }
}

let defaultConnectDonatorUnlockService: ConnectDonatorUnlockService | null = null;

export const getConnectDonatorUnlockService = (): ConnectDonatorUnlockService => {
  defaultConnectDonatorUnlockService ??= new ConnectDonatorUnlockService();
  return defaultConnectDonatorUnlockService;
};

export const closeDefaultConnectDonatorUnlockService = (): void => {
  defaultConnectDonatorUnlockService?.close();
  defaultConnectDonatorUnlockService = null;
};
