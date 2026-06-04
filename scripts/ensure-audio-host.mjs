import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), '..');
const sourceRoots = [join(projectRoot, 'native', 'audio-host'), join(projectRoot, 'native', 'audio-engine')];
const targetPath = join(
  projectRoot,
  'electron-app',
  'build',
  process.platform === 'win32' ? 'echo-audio-host.exe' : 'echo-audio-host',
);

const getLatestSourceMtime = (directory) => {
  let latest = 0;

  if (!existsSync(directory)) {
    return latest;
  }

  for (const name of readdirSync(directory)) {
    const filePath = join(directory, name);
    const stats = statSync(filePath);

    if (stats.isDirectory()) {
      latest = Math.max(latest, getLatestSourceMtime(filePath));
    } else {
      latest = Math.max(latest, stats.mtimeMs);
    }
  }

  return latest;
};

const run = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
};

try {
  if (process.env.ECHO_SKIP_AUDIO_HOST_BUILD === '1') {
    console.log('[ensure:audio-host] skipped because ECHO_SKIP_AUDIO_HOST_BUILD=1');
    process.exit(0);
  }

  const targetMtime = existsSync(targetPath) ? statSync(targetPath).mtimeMs : 0;
  const latestSourceMtime = Math.max(...sourceRoots.map(getLatestSourceMtime));

  if (targetMtime > 0 && targetMtime >= latestSourceMtime) {
    console.log(`[ensure:audio-host] ${targetPath} is up to date.`);
    process.exit(0);
  }

  if (targetMtime > 0) {
    console.log('[ensure:audio-host] Native audio host is older than source; rebuilding...');
  } else {
    console.log('[ensure:audio-host] Native audio host is missing; building...');
  }

  run(process.execPath, [join(projectRoot, 'scripts', 'build-audio-host.mjs')]);
} catch (error) {
  console.error('[ensure:audio-host] Native audio host is required for local playback.');
  console.error(
    process.platform === 'win32'
      ? '[ensure:audio-host] Requirements: CMake, Visual Studio 2022 Build Tools, Windows SDK, and network access for JUCE 8.0.12.'
      : '[ensure:audio-host] Requirements: CMake, a C++17 compiler, Linux audio development libraries required by JUCE, and network access for JUCE 8.0.12.',
  );
  console.error(`[ensure:audio-host] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
