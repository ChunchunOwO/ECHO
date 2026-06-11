import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { app, dialog } from 'electron';

export type PackageIntegrityManifestFile = {
  path: string;
  sha256: string;
  size: number;
};

export type PackageIntegrityManifest = {
  schemaVersion: 1;
  appId: string;
  productName: string;
  version: string;
  generatedAt: string;
  files: PackageIntegrityManifestFile[];
};

export type PackageIntegrityVerificationResult = {
  ok: boolean;
  skipped: boolean;
  verified: string[];
  warnings: string[];
  errors: string[];
};

const integrityManifestFileName = 'echo-integrity.json';
const disableIntegrityEnv = 'ECHO_DISABLE_PACKAGE_INTEGRITY';
const getDefaultIsPackaged = (): boolean => app?.isPackaged === true;

export const resolvePackageIntegrityManifestPath = (resourcesPath = process.resourcesPath): string =>
  join(resourcesPath, integrityManifestFileName);

export const isPackageIntegrityEnforced = (
  isPackaged = getDefaultIsPackaged(),
  env: NodeJS.ProcessEnv = process.env,
): boolean => isPackaged && env[disableIntegrityEnv] !== '1';

const isSafeRelativeResourcePath = (value: string): boolean => {
  if (!value || isAbsolute(value)) {
    return false;
  }

  const normalized = normalize(value);
  return normalized !== '..' && !normalized.startsWith(`..${sep}`) && !normalized.includes(`${sep}..${sep}`);
};

const hashFileSha256 = (filePath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });

const readManifest = async (manifestPath: string): Promise<PackageIntegrityManifest> => {
  const raw = await readFile(manifestPath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<PackageIntegrityManifest>;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.files)) {
    throw new Error('invalid integrity manifest schema');
  }

  return parsed as PackageIntegrityManifest;
};

export const verifyPackageIntegrity = async ({
  resourcesPath = process.resourcesPath,
  manifestPath = resolvePackageIntegrityManifestPath(resourcesPath),
  isPackaged = getDefaultIsPackaged(),
  env = process.env,
}: {
  resourcesPath?: string;
  manifestPath?: string;
  isPackaged?: boolean;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<PackageIntegrityVerificationResult> => {
  if (!isPackageIntegrityEnforced(isPackaged, env)) {
    return { ok: true, skipped: true, verified: [], warnings: [], errors: [] };
  }

  const verified: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  let manifest: PackageIntegrityManifest;

  try {
    manifest = await readManifest(manifestPath);
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      verified,
      warnings,
      errors: [`manifest: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  for (const file of manifest.files) {
    if (!isSafeRelativeResourcePath(file.path)) {
      errors.push(`${file.path || '<empty>'}: unsafe resource path`);
      continue;
    }

    const filePath = join(resourcesPath, file.path);
    try {
      const info = await stat(filePath);
      if (!info.isFile()) {
        if (file.path === 'app.asar' && info.isDirectory()) {
          warnings.push('app.asar: loose directory layout; legacy file hash skipped');
          verified.push('app.asar/');
          continue;
        }

        errors.push(`${file.path}: not a file`);
        continue;
      }

      if (info.size !== file.size) {
        errors.push(`${file.path}: size mismatch`);
        continue;
      }

      const digest = await hashFileSha256(filePath);
      if (digest !== file.sha256) {
        errors.push(`${file.path}: sha256 mismatch`);
        continue;
      }

      verified.push(file.path);
    } catch (error) {
      errors.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    ok: errors.length === 0,
    skipped: false,
    verified,
    warnings,
    errors,
  };
};

export const runPackageIntegrityGuard = async (): Promise<boolean> => {
  const result = await verifyPackageIntegrity();
  if (result.ok) {
    return true;
  }

  const detail = result.errors.slice(0, 8).join('\n');
  dialog.showErrorBox(
    'ECHO integrity check failed',
    `The installed application files do not match the packaged integrity manifest.\n\n${detail}`,
  );
  app.quit();
  return false;
};
