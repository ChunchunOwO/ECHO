import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PackageIntegrityManifest } from './packageIntegrity';
import { isPackageIntegrityEnforced, verifyPackageIntegrity } from './packageIntegrity';

const tempDirs: string[] = [];

const makeTempResources = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-integrity-'));
  tempDirs.push(dir);
  return dir;
};

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('isPackageIntegrityEnforced', () => {
  it('only enforces in packaged builds unless explicitly disabled', () => {
    expect(isPackageIntegrityEnforced(false, {})).toBe(false);
    expect(isPackageIntegrityEnforced(true, {})).toBe(true);
    expect(isPackageIntegrityEnforced(true, { ECHO_DISABLE_PACKAGE_INTEGRITY: '1' })).toBe(false);
  });
});

describe('verifyPackageIntegrity', () => {
  const writeManifest = (resourcesPath: string, manifest: PackageIntegrityManifest): string => {
    const manifestPath = join(resourcesPath, 'echo-integrity.json');
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifestPath;
  };

  it('verifies manifest-listed resource hashes', async () => {
    const resourcesPath = makeTempResources();
    const filePath = join(resourcesPath, 'app.asar');
    writeFileSync(filePath, 'asar bytes');
    const manifestPath = writeManifest(resourcesPath, {
      schemaVersion: 1,
      appId: 'app.echo.next',
      productName: 'ECHO NEXT',
      version: '26.6.9',
      generatedAt: '2026-06-11T00:00:00.000Z',
      files: [{ path: 'app.asar', sha256: sha256('asar bytes'), size: 10 }],
    });

    await expect(verifyPackageIntegrity({ resourcesPath, manifestPath, isPackaged: true, env: {} })).resolves.toEqual({
      ok: true,
      skipped: false,
      verified: ['app.asar'],
      warnings: [],
      errors: [],
    });
  });

  it('does not block legacy manifests when app.asar is a loose app directory', async () => {
    const resourcesPath = makeTempResources();
    mkdirSync(join(resourcesPath, 'app.asar'));
    writeFileSync(join(resourcesPath, 'app.asar', 'package.json'), '{}');
    const manifestPath = writeManifest(resourcesPath, {
      schemaVersion: 1,
      appId: 'app.echo.next',
      productName: 'ECHO NEXT',
      version: '26.6.11',
      generatedAt: '2026-06-11T00:00:00.000Z',
      files: [{ path: 'app.asar', sha256: sha256('old packed asar'), size: 15 }],
    });

    const result = await verifyPackageIntegrity({ resourcesPath, manifestPath, isPackaged: true, env: {} });

    expect(result.ok).toBe(true);
    expect(result.verified).toEqual(['app.asar/']);
    expect(result.warnings).toEqual(['app.asar: loose directory layout; legacy file hash skipped']);
    expect(result.errors).toEqual([]);
  });

  it('reports changed files without throwing', async () => {
    const resourcesPath = makeTempResources();
    const filePath = join(resourcesPath, 'tools');
    mkdirSync(filePath);
    writeFileSync(join(filePath, 'ffmpeg.exe'), 'changed!');
    const manifestPath = writeManifest(resourcesPath, {
      schemaVersion: 1,
      appId: 'app.echo.next',
      productName: 'ECHO NEXT',
      version: '26.6.9',
      generatedAt: '2026-06-11T00:00:00.000Z',
      files: [{ path: 'tools/ffmpeg.exe', sha256: sha256('expected'), size: 8 }],
    });

    const result = await verifyPackageIntegrity({ resourcesPath, manifestPath, isPackaged: true, env: {} });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['tools/ffmpeg.exe: sha256 mismatch']);
  });

  it('rejects unsafe manifest paths', async () => {
    const resourcesPath = makeTempResources();
    const manifestPath = writeManifest(resourcesPath, {
      schemaVersion: 1,
      appId: 'app.echo.next',
      productName: 'ECHO NEXT',
      version: '26.6.9',
      generatedAt: '2026-06-11T00:00:00.000Z',
      files: [{ path: '../outside.exe', sha256: sha256('x'), size: 1 }],
    });

    const result = await verifyPackageIntegrity({ resourcesPath, manifestPath, isPackaged: true, env: {} });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['../outside.exe: unsafe resource path']);
  });
});
