import { createCipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';

const pluginPackageType = 'echo-next-plugin-package';
const pluginPackageVersion = 1;
const connectDonatorUnlockFeatureId = 'connect';
const connectDonatorUnlockPluginId = 'echo.connect-donator-unlock';
const connectDonatorLicenseFileName = 'donator.machine-license.json';
const hwidHashPattern = /^[a-f0-9]{64}$/u;
const donatorLicenseVersion = 1;
const donatorLicenseAlgorithm = 'aes-256-gcm';
const donatorLicenseKey = Buffer.from('H1qOend5BTwz+pFWb6M7WGIDphqgnCNne8R9dB9CJLU=', 'base64');

const usage = `
Usage:
  npm run plugin:connect-donator -- <hwidHash> [--out <file-or-dir>] [--version <semver>] [--force]

Examples:
  npm run plugin:connect-donator -- 0123abcd...cdef
  npm run plugin:connect-donator -- 0123abcd...cdef --out dist/donator-plugins/moe.echo --force
`.trim();

const fail = (message) => {
  console.error(`\n${message}\n\n${usage}`);
  process.exit(1);
};

const normalizeArgs = (argv) => {
  const options = {
    force: false,
    out: null,
    pluginVersion: '1.0.0',
    hwidHashes: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      console.log(usage);
      process.exit(0);
    }
    if (arg === '--force') {
      options.force = true;
      continue;
    }
    if (arg === '--out') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        fail('--out needs a file or directory path.');
      }
      options.out = value;
      index += 1;
      continue;
    }
    if (arg === '--version') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        fail('--version needs a plugin version.');
      }
      options.pluginVersion = value.trim();
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      fail(`Unknown option: ${arg}`);
    }
    options.hwidHashes.push(arg);
  }

  const hwidHashes = [];
  for (const value of options.hwidHashes) {
    for (const part of value.split(',')) {
      const normalized = part.trim().toLowerCase();
      if (!normalized) {
        continue;
      }
      if (!hwidHashPattern.test(normalized)) {
        fail(`Invalid HWID hash: ${part}`);
      }
      if (!hwidHashes.includes(normalized)) {
        hwidHashes.push(normalized);
      }
    }
  }

  if (hwidHashes.length === 0) {
    fail('At least one 64-character SHA-256 HWID hash is required.');
  }
  if (hwidHashes.length > 1) {
    fail('Encrypted machine licenses are one-device packages. Please create one plugin per HWID.');
  }

  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/u.test(options.pluginVersion)) {
    fail(`Invalid plugin version: ${options.pluginVersion}`);
  }

  return { ...options, hwidHashes };
};

const resolveOutputPath = (outValue, firstHwidHash) => {
  const defaultFileName = `${connectDonatorUnlockPluginId}-${firstHwidHash.slice(0, 8)}.echo`;
  if (!outValue) {
    return resolve('dist', 'donator-plugins', defaultFileName);
  }

  const resolved = isAbsolute(outValue) ? outValue : resolve(outValue);
  if (existsSync(resolved) && statSync(resolved).isDirectory()) {
    return join(resolved, defaultFileName);
  }
  if (!extname(resolved)) {
    return join(resolved, defaultFileName);
  }
  return resolved;
};

const createEncryptedLicense = (hwidHash) => {
  const payload = {
    version: 1,
    featureId: connectDonatorUnlockFeatureId,
    pluginId: connectDonatorUnlockPluginId,
    issuedAt: new Date().toISOString(),
    hwidHash,
  };
  const iv = randomBytes(12);
  const cipher = createCipheriv(donatorLicenseAlgorithm, donatorLicenseKey, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return {
    version: donatorLicenseVersion,
    algorithm: donatorLicenseAlgorithm,
    issuedAt: payload.issuedAt,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
};

const createPackage = ({ hwidHashes, pluginVersion }) => {
  return {
    type: pluginPackageType,
    version: pluginPackageVersion,
    exportedAt: new Date().toISOString(),
    manifest: {
      id: connectDonatorUnlockPluginId,
      name: 'Connect Donator Unlock',
      version: pluginVersion,
      apiVersion: 2,
      entry: 'plugin.js',
      permissions: [],
      contributes: {
        commands: [],
        panels: [],
        trackContextMenus: [],
        metadataProviders: [],
        sourceProviders: [],
        lyricsProviders: [],
        coverProviders: [],
        themePresets: [],
        settings: [],
      },
    },
    files: [
      {
        path: 'plugin.js',
        content: '// Connect Donator unlock marker plugin. Keep this plugin installed and enabled.\n',
      },
      {
        path: connectDonatorLicenseFileName,
        content: `${JSON.stringify(createEncryptedLicense(hwidHashes[0]), null, 2)}\n`,
      },
    ],
  };
};

const main = () => {
  const options = normalizeArgs(process.argv.slice(2));
  const outputPath = resolveOutputPath(options.out, options.hwidHashes[0]);
  if (existsSync(outputPath) && !options.force) {
    fail(`Output already exists: ${outputPath}\nUse --force to overwrite it.`);
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  const payload = createPackage(options);
  writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log(`Created ${outputPath}`);
  console.log(`Plugin ID: ${connectDonatorUnlockPluginId}`);
  console.log(`Bound HWID: ${options.hwidHashes[0]}`);
};

main();
