import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SUPPORTED_AUDIO_EXTENSIONS } from '../../../shared/constants/audioExtensions';
import type { ScannedFile, ScanOptions } from '../libraryTypes';
import type { FileScanner } from './FileScanner';

export class TsFileScanner implements FileScanner {
  async *scanFolder(folderPath: string, options: ScanOptions = {}): AsyncIterable<ScannedFile> {
    const extensions = new Set(options.audioExtensions?.map((extension) => extension.toLocaleLowerCase()) ?? SUPPORTED_AUDIO_EXTENSIONS);
    yield* this.walk(resolve(folderPath), extensions, options.signal);
  }

  private async *walk(directoryPath: string, audioExtensions: Set<string>, signal: AbortSignal | undefined): AsyncIterable<ScannedFile> {
    if (signal?.aborted) {
      return;
    }

    const entries = await readdir(directoryPath, { withFileTypes: true });

    for (const entry of entries) {
      if (signal?.aborted) {
        return;
      }

      const entryPath = join(directoryPath, entry.name);

      if (entry.isDirectory()) {
        yield* this.walk(entryPath, audioExtensions, signal);
        continue;
      }

      if (!entry.isFile() || !audioExtensions.has(this.getExtension(entry.name))) {
        continue;
      }

      const fileStat = await stat(entryPath);

      yield {
        path: resolve(entryPath),
        sizeBytes: fileStat.size,
        mtimeMs: Math.round(fileStat.mtimeMs),
      };
    }
  }

  private getExtension(fileName: string): string {
    const index = fileName.lastIndexOf('.');
    return index >= 0 ? fileName.slice(index).toLocaleLowerCase() : '';
  }
}
