import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { extname } from 'node:path';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import type { Readable } from 'node:stream';
import { resolveHostBinary } from './NativeOutputBridge';
import type { DecoderRun, PcmDecodeRequest } from './audioTypes';

type JuceDecodeChildProcess = ChildProcessByStdio<null, Readable, Readable>;

type JuceDecodeSpawnOptions = {
  stdio: ['ignore', 'pipe', 'pipe'];
  windowsHide: boolean;
};

export type JuceDecodeSpawner = (
  file: string,
  args: string[],
  options: JuceDecodeSpawnOptions,
) => JuceDecodeChildProcess;

export type JuceDecodePipelineDependencies = {
  hostBinary?: string | null;
  spawn?: JuceDecodeSpawner;
  logger?: (message: string) => void;
  readyTimeoutMs?: number;
};

const defaultLogger = (message: string): void => {
  console.warn(message);
};

const defaultReadyTimeoutMs = 5_000;

const getDecoderBackendImpl = (filePath: string): string => {
  const extension = extname(filePath).toLowerCase();

  if (extension === '.flac') {
    return 'juce-flac';
  }

  if (extension === '.mp3') {
    return 'juce-windows-media-mp3';
  }

  if (extension === '.wav' || extension === '.wave') {
    return 'juce-wav';
  }

  return 'juce-audio-format';
};

const formatHostDetailValue = (value: string): string =>
  value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');

const appendTailLine = (lines: string[], line: string): void => {
  const trimmed = line.trim();

  if (!trimmed) {
    return;
  }

  lines.push(trimmed);
  if (lines.length > 8) {
    lines.shift();
  }
};

const createJuceDecodeError = (
  reason: string,
  hostBinary: string,
  args: string[],
  stderrLines: string[],
  metadata: { exitCode?: number | null; signal?: NodeJS.Signals | null } = {},
): Error => {
  const details = [
    `host="${formatHostDetailValue(hostBinary)}"`,
    `args="${formatHostDetailValue(args.join(' '))}"`,
  ];

  if (metadata.exitCode !== undefined && metadata.exitCode !== null) {
    details.push(`exitCode=${metadata.exitCode}`);
  }

  if (metadata.signal) {
    details.push(`signal="${metadata.signal}"`);
  }

  const stderr = stderrLines.join(' | ');
  if (stderr) {
    details.push(`stderrTail="${formatHostDetailValue(stderr)}"`);
  }

  return new Error(`echo-audio-host juce_decode_${reason}; ${details.join('; ')}`);
};

export class JuceDecodePipeline {
  private readonly hostBinary: string | null;
  private readonly spawn: JuceDecodeSpawner;
  private readonly logger: (message: string) => void;
  private readonly readyTimeoutMs: number;

  constructor(dependencies: JuceDecodePipelineDependencies = {}) {
    this.hostBinary = dependencies.hostBinary ?? null;
    this.spawn = dependencies.spawn ?? (nodeSpawn as JuceDecodeSpawner);
    this.logger = dependencies.logger ?? defaultLogger;
    this.readyTimeoutMs = Math.max(250, dependencies.readyTimeoutMs ?? defaultReadyTimeoutMs);
  }

  decodeLocalFile(request: PcmDecodeRequest): DecoderRun {
    const hostBinary = this.hostBinary ?? resolveHostBinary();
    if (!hostBinary) {
      throw new Error('echo-audio-host juce_decode_host_missing');
    }

    const args = [
      '-decode-pcm',
      request.filePath,
      '-ss',
      String(Math.max(0, request.startSeconds)),
      '-sr',
      String(Math.max(1, Math.round(request.decoderOutputSampleRate))),
      '-ch',
      String(Math.max(1, Math.min(8, Math.round(request.channels)))),
    ];

    this.logger(`[JuceDecodePipeline] spawn: ${hostBinary} ${args.join(' ')}`);
    const proc = this.spawn(hostBinary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stream = new PassThrough();
    const stderrLines: string[] = [];
    let stopped = false;
    let readySettled = false;
    let sawPcm = false;
    let readyTimer: NodeJS.Timeout | null = null;

    const stderr = readline.createInterface({ input: proc.stderr });
    stderr.on('line', (line) => {
      appendTailLine(stderrLines, line);
    });

    const settleReady = (callback: () => void): void => {
      if (readySettled) {
        return;
      }

      readySettled = true;
      if (readyTimer) {
        clearTimeout(readyTimer);
        readyTimer = null;
      }
      callback();
    };

    const ready = new Promise<void>((resolve, reject) => {
      readyTimer = setTimeout(() => {
        settleReady(() => reject(createJuceDecodeError('timeout_waiting_for_pcm', hostBinary, args, stderrLines)));
      }, this.readyTimeoutMs);
      readyTimer.unref?.();

      proc.stdout.once('data', () => {
        sawPcm = true;
        settleReady(resolve);
      });
      proc.once('error', (error) => {
        settleReady(() => reject(error));
      });
      proc.once('close', (code, signal) => {
        if (sawPcm || stopped) {
          settleReady(resolve);
          return;
        }

        settleReady(() => reject(createJuceDecodeError('exit_before_pcm', hostBinary, args, stderrLines, { exitCode: code, signal })));
      });
    });

    proc.stdout.on('error', (error) => {
      stream.destroy(error);
    });
    proc.stdout.pipe(stream);

    const done = new Promise<void>((resolve, reject) => {
      proc.once('error', reject);
      proc.once('close', (code, signal) => {
        stderr.close();
        if (stopped || code === 0) {
          resolve();
          return;
        }

        reject(createJuceDecodeError('exit', hostBinary, args, stderrLines, { exitCode: code, signal }));
      });
    });

    return {
      stream,
      ready,
      done,
      waitForExitOnStop: true,
      decoderBackendImpl: getDecoderBackendImpl(request.filePath),
      stop: () => {
        stopped = true;
        stderr.close();
        stream.destroy();
        if (!proc.killed) {
          proc.kill();
        }
      },
    };
  }
}
