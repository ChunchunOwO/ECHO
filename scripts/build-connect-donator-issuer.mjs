import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const projectPath = resolve('tools', 'connect-donator-issuer', 'EchoConnectDonatorIssuer.csproj');
const publishDirectory = resolve('tools', 'connect-donator-issuer', 'bin', 'Release', 'net8.0', 'win-x64', 'publish');
const publishedExe = join(publishDirectory, 'ECHOConnectDonatorIssuer.exe');
const outputDirectory = resolve('dist', 'donator-issuer');
const outputExe = join(outputDirectory, 'ECHO-Connect-Donator-Unlock-Issuer.exe');

const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

run('dotnet', [
  'publish',
  projectPath,
  '-c',
  'Release',
  '-r',
  'win-x64',
  '--self-contained',
  'true',
  '-p:PublishSingleFile=true',
  '-p:EnableCompressionInSingleFile=true',
]);

if (!existsSync(publishedExe)) {
  console.error(`Published exe not found: ${publishedExe}`);
  process.exit(1);
}

mkdirSync(outputDirectory, { recursive: true });
copyFileSync(publishedExe, outputExe);
console.log(`Created ${outputExe}`);
