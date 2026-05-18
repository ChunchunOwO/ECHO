import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), '..');
const require = createRequire(import.meta.url);

const fail = (message, details = []) => {
  console.error(`[build:airplay-raop] ${message}`);
  for (const detail of details) {
    console.error(`[build:airplay-raop] ${detail}`);
  }
  process.exitCode = 1;
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: false,
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
};

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const findVisualStudio = () => {
  const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
  if (!existsSync(vswhere)) {
    return null;
  }

  const result = spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.Component.MSBuild', '-property', 'installationPath'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  const installationPath = result.stdout.trim();
  if (!installationPath) {
    return null;
  }

  const msbuild = join(installationPath, 'MSBuild', 'Current', 'Bin', 'MSBuild.exe');
  const vcToolsDir = join(installationPath, 'VC', 'Tools', 'MSVC');
  if (!existsSync(msbuild) || !existsSync(vcToolsDir)) {
    return null;
  }

  const tools = spawnSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `$ErrorActionPreference='Stop'; Get-ChildItem -LiteralPath '${vcToolsDir.replaceAll("'", "''")}' -Directory | Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName`,
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  const latestVcTools = tools.status === 0 ? tools.stdout.trim() : '';
  const vcBin = latestVcTools ? join(latestVcTools, 'bin', 'Hostx64', 'x64') : null;
  return { installationPath, msbuild, vcToolsDir, vcBin: vcBin && existsSync(join(vcBin, 'cl.exe')) ? vcBin : null };
};

const opensslCandidates = [
  process.env.OPENSSL_ROOT_DIR,
  process.env.OPENSSL_DIR,
  'C:\\Program Files\\OpenSSL-Win64',
  'C:\\Program Files (x86)\\OpenSSL-Win64',
  'C:\\vcpkg\\installed\\x64-windows',
].filter(Boolean);

const findOpenSsl = () => {
  for (const root of opensslCandidates) {
    const include = join(root, 'include', 'openssl', 'ssl.h');
    const lib = join(root, 'lib');
    if (existsSync(include) && existsSync(lib)) {
      return root;
    }
  }

  return null;
};

const findGitBash = () => {
  const candidates = [
    'F:\\Git\\bin',
    'F:\\Git\\usr\\bin',
    'C:\\Program Files\\Git\\bin',
    'C:\\Program Files\\Git\\usr\\bin',
  ];
  return candidates.find((candidate) => existsSync(join(candidate, 'bash.exe'))) ?? null;
};

const findPython = () => {
  const candidates = [
    process.env.PYTHON,
    'C:\\Users\\Moe\\AppData\\Local\\Programs\\Python\\Python313\\python.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const result = spawnSync('where.exe', ['python'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  return result.status === 0
    ? result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null
    : null;
};

const createPython3Shim = (pythonPath) => {
  const shimDir = join(projectRoot, '.codex-tmp', 'airplay-build-bin');
  mkdirSync(shimDir, { recursive: true });
  const shim = join(shimDir, 'python3');
  const bashPath = pythonPath.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
  writeFileSync(shim, `#!/usr/bin/env bash\nexec "${bashPath}" "$@"\n`, 'utf8');
  chmodSync(shim, 0o755);
  return shimDir;
};

const toGypPath = (path) => path.replaceAll('\\', '/');

const patchNodeLibraopWindowsBuild = (openSslRoot) => {
  const packageRoot = dirname(require.resolve('@lox-audioserver/node-libraop/package.json'));
  const queueStubPath = join(packageRoot, 'native', 'raop_client_queue_stub.c');
  writeFileSync(queueStubPath, [
    '#include <stdint.h>',
    'struct raopcl_s;',
    'uint32_t raopcl_queue_len(struct raopcl_s *p) { (void)p; return 0; }',
    'uint32_t raopcl_queued_frames(struct raopcl_s *p) { (void)p; return 0; }',
    '',
  ].join('\n'), 'utf8');

  const bindingPath = join(packageRoot, 'binding.gyp');
  let binding = readFileSync(bindingPath, 'utf8');
  if (!binding.includes('native/raop_client_queue_stub.c')) {
    binding = binding.replace(
      '"native/log_stub.c",',
      '"native/log_stub.c",\n        "native/raop_client_queue_stub.c",',
    );
  }
  const includeDir = toGypPath(join(openSslRoot, 'include'));
  if (!binding.includes(includeDir)) {
    binding = binding.replace(
      '"native",',
      `"${includeDir}",\n        "native",`,
    );
  }
  const libPaths = [
    toGypPath(join(openSslRoot, 'lib', 'libssl.lib')),
    toGypPath(join(openSslRoot, 'lib', 'libcrypto.lib')),
    toGypPath(join(openSslRoot, 'lib', 'pthreadVC3.lib')),
  ];
  for (const libPath of libPaths) {
    if (!binding.includes(libPath)) {
      binding = binding.replace(
        '"-lbcrypt"',
        `"${libPath}",\n            "-lbcrypt"`,
      );
    }
  }
  binding = binding
    .replace(/\s*"-lssl",?\r?\n/g, '')
    .replace(/\s*"-lcrypto",?\r?\n/g, '')
    .replace(/\s*"-lpthreadVC3",?\r?\n/g, '');
  if (!binding.includes('SSL_STATIC_LIB')) {
    binding = binding.replace(
      '"NAPI_DISABLE_CPP_EXCEPTIONS"',
      '"SSL_STATIC_LIB", "NAPI_DISABLE_CPP_EXCEPTIONS"',
    );
  }
  writeFileSync(bindingPath, binding, 'utf8');

  const platformPath = join(packageRoot, 'vendor', 'libraop', 'crosstools', 'src', 'platform.h');
  let platform = readFileSync(platformPath, 'utf8');
  if (!platform.includes('#include <sys/timeb.h>\n#include <pthread.h>')) {
    platform = platform.replace(
      '#include <sys/timeb.h>',
      '#include <sys/timeb.h>\n#include <pthread.h>',
    );
    writeFileSync(platformPath, platform, 'utf8');
  }

  const serverPath = join(packageRoot, 'vendor', 'libraop', 'src', 'raop_server.c');
  let server = readFileSync(serverPath, 'utf8');
  server = server.replace(
    'port.offset = rand() % port_range;',
    'port.offset = 0;',
  );
  server = server.replace(
    [
      '\t\tht = raopst_init(ctx->host, ctx->peer, ctx->streamer.codec, ctx->streamer.metadata, ctx->drift, true, ctx->latencies,',
      '\t\t\t\t\t\t\tctx->rtsp.aeskey, ctx->rtsp.aesiv, ctx->rtsp.fmtp,',
      '\t\t\t\t\t\t\tcport, tport, ctx, event_cb, http_cb, ctx->ports.base,',
      '\t\t\t\t\t\t\tctx->ports.range, ctx->http_length);',
    ].join('\n'),
    [
      '\t\tunsigned short stream_base = ctx->ports.base ? ctx->ports.base + 1 : 0;',
      '\t\tunsigned short stream_range = ctx->ports.range > 1 ? ctx->ports.range - 1 : ctx->ports.range;',
      '\t\tht = raopst_init(ctx->host, ctx->peer, ctx->streamer.codec, ctx->streamer.metadata, ctx->drift, true, ctx->latencies,',
      '\t\t\t\t\t\t\tctx->rtsp.aeskey, ctx->rtsp.aesiv, ctx->rtsp.fmtp,',
      '\t\t\t\t\t\t\tcport, tport, ctx, event_cb, http_cb, stream_base,',
      '\t\t\t\t\t\t\tstream_range, ctx->http_length);',
    ].join('\n'),
  );
  writeFileSync(serverPath, server, 'utf8');
};

const copyRuntimeDlls = (openSslRoot) => {
  const packageRoot = dirname(require.resolve('@lox-audioserver/node-libraop/package.json'));
  const releaseDir = join(packageRoot, 'build', 'Release');
  const prebuildDir = join(packageRoot, 'prebuilds', 'win32-x64');
  mkdirSync(prebuildDir, { recursive: true });
  const releaseNode = join(releaseDir, 'raop_addon.node');
  if (existsSync(releaseNode)) {
    copyFileSync(releaseNode, join(prebuildDir, 'raop_addon.node.napi.node'));
    console.log('[build:airplay-raop] Prebuild: win32-x64/raop_addon.node.napi.node');
  }
  const runtimeDlls = [
    'libssl-3-x64.dll',
    'libcrypto-3-x64.dll',
    'pthreadVC3.dll',
  ];
  for (const dll of runtimeDlls) {
    const source = join(openSslRoot, 'bin', dll);
    if (existsSync(source)) {
      copyFileSync(source, join(releaseDir, dll));
      copyFileSync(source, join(prebuildDir, dll));
      console.log(`[build:airplay-raop] Runtime DLL: ${dll}`);
    }
  }
};

try {
  if (process.platform !== 'win32') {
    fail('This spike build script currently targets Windows only.');
    process.exit();
  }

  const visualStudio = findVisualStudio();
  if (!visualStudio) {
    fail('Visual Studio 2022 Build Tools with MSBuild were not found.', [
      'Install VS 2022 Build Tools with Desktop development with C++ and Windows SDK.',
    ]);
    process.exit();
  }

  const openSslRoot = findOpenSsl();
  if (!openSslRoot) {
    fail('OpenSSL x64 headers/libs were not found.', [
      'Install Win64 OpenSSL or vcpkg openssl:x64-windows.',
      'Set OPENSSL_ROOT_DIR to the folder that contains include\\openssl\\ssl.h and lib\\.',
      'The currently detected OpenSSL-Win32 runtime folder is not enough for native compilation.',
    ]);
    process.exit();
  }
  const gitBashBin = findGitBash();
  if (!gitBashBin) {
    fail('Git Bash was not found, but node-libraop needs bash to prepare vendored libraop sources.', [
      'Install Git for Windows or make bash.exe available on PATH before C:\\Windows\\system32\\bash.exe.',
    ]);
    process.exit();
  }
  const pythonPath = findPython();
  if (!pythonPath) {
    fail('Python was not found for the libraop preparation script.', [
      'Install Python 3 and make python.exe available on PATH.',
    ]);
    process.exit();
  }
  const pythonShimDir = createPython3Shim(pythonPath);

  try {
    require.resolve('@lox-audioserver/node-libraop/package.json');
  } catch {
    fail('@lox-audioserver/node-libraop is not installed in node_modules.', [
      'Run npm install --include=optional --ignore-scripts first, then rerun npm run build:airplay-raop.',
    ]);
    process.exit();
  }
  patchNodeLibraopWindowsBuild(openSslRoot);

  const env = {
    ...process.env,
    OPENSSL_ROOT_DIR: openSslRoot,
    npm_config_build_from_source: 'true',
    npm_config_openssl_root: openSslRoot,
    INCLUDE: [
      join(openSslRoot, 'include'),
      process.env.INCLUDE ?? '',
    ].filter(Boolean).join(';'),
    LIB: [
      join(openSslRoot, 'lib'),
      process.env.LIB ?? '',
    ].filter(Boolean).join(';'),
    PATH: [
      pythonShimDir,
      gitBashBin,
      dirname(visualStudio.msbuild),
      visualStudio.vcBin,
      join(openSslRoot, 'bin'),
      process.env.PATH ?? '',
    ].filter(Boolean).join(';'),
  };

  console.log(`[build:airplay-raop] Visual Studio: ${visualStudio.installationPath}`);
  if (visualStudio.vcBin) {
    console.log(`[build:airplay-raop] MSVC x64: ${visualStudio.vcBin}`);
  }
  console.log(`[build:airplay-raop] OpenSSL: ${openSslRoot}`);
  console.log(`[build:airplay-raop] Bash: ${join(gitBashBin, 'bash.exe')}`);
  console.log(`[build:airplay-raop] Python: ${pythonPath}`);
  if (process.platform === 'win32') {
    run('cmd.exe', ['/d', '/s', '/c', `${npmCommand} rebuild @lox-audioserver/node-libraop --build-from-source`], { env });
  } else {
    run(npmCommand, ['rebuild', '@lox-audioserver/node-libraop', '--build-from-source'], { env });
  }
  console.log('[build:airplay-raop] RAOP native module rebuilt.');
  copyRuntimeDlls(openSslRoot);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const details = [message];
  if (message.includes('EPERM') && message.includes('node-libraop') && message.includes('.dll')) {
    details.push('Close any running ECHO/Electron process that has loaded the AirPlay native DLLs, then rerun npm run build:airplay-raop.');
  }
  fail('Failed to build AirPlay RAOP native module.', details);
}
