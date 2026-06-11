import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const hashFileSha256 = (filePath) =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });

const normalizeRelativePath = (value) => value.split(sep).join('/');

const addFileInfo = async (resourcesDir, files, filePath) => {
  files.push({
    path: normalizeRelativePath(relative(resourcesDir, filePath)),
    sha256: await hashFileSha256(filePath),
    size: (await stat(filePath)).size,
  });
};

const addResourcePath = async (resourcesDir, files, relativePath) => {
  const filePath = join(resourcesDir, relativePath);
  if (!existsSync(filePath)) {
    return;
  }

  const info = await stat(filePath);
  if (info.isFile()) {
    await addFileInfo(resourcesDir, files, filePath);
    return;
  }

  if (!info.isDirectory()) {
    return;
  }

  const entries = await readdir(filePath, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    await addResourcePath(resourcesDir, files, join(relativePath, entry.name));
  }
};

export default async function afterPack(context) {
  const resourcesDir = join(context.appOutDir, 'resources');
  const files = [];
  const candidateFiles = [
    'app.asar',
    'echo-audio-host.exe',
    'echo-smtc-host.exe',
    'echo-native-scanner.exe',
    'airplayRaopHelper.cjs',
    'tools/ffmpeg.exe',
    'tools/yt-dlp.exe',
    'tools/NCMConverter.exe',
  ];

  for (const relativePath of candidateFiles) {
    await addResourcePath(resourcesDir, files, relativePath);
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

  const manifest = {
    schemaVersion: 1,
    appId: context.packager.appInfo.id,
    productName: context.packager.appInfo.productName,
    version: context.packager.appInfo.version,
    generatedAt: new Date().toISOString(),
    files,
  };

  await writeFile(join(resourcesDir, 'echo-integrity.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[afterPack:integrity] wrote ${files.length} file hash(es) to resources/echo-integrity.json`);
}
