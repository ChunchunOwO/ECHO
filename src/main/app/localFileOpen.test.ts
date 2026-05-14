import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseLocalAudioFileArguments, resolveLocalAudioFiles } from './localFileOpen';

const getTrackByPathMock = vi.fn();

vi.mock('../library/LibraryService', () => ({
  getLibraryService: () => ({
    getTrackByPath: getTrackByPathMock,
  }),
}));

vi.mock('./windowManager', () => ({
  getMainWindow: () => null,
}));

const tempRoots: string[] = [];

const makeTempRoot = (): string => {
  const root = join(tmpdir(), `echo-next-local-open-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  tempRoots.push(root);
  return root;
};

describe('local file open helpers', () => {
  beforeEach(() => {
    getTrackByPathMock.mockReset();
  });

  it('parses argv as unique directly playable audio files only', () => {
    const root = makeTempRoot();
    const flac = join(root, 'song.flac');
    const cue = join(root, 'song.cue');
    const jpg = join(root, 'cover.jpg');
    const folder = join(root, 'Album');
    mkdirSync(folder);
    writeFileSync(flac, 'not real audio');
    writeFileSync(cue, 'FILE "song.flac" WAVE');
    writeFileSync(jpg, 'image');

    expect(parseLocalAudioFileArguments(['--flag', flac, flac.toUpperCase(), cue, jpg, folder, join(root, 'missing.mp3')])).toEqual([
      resolve(flac),
    ]);
  });

  it('reuses library tracks and creates temporary tracks for unknown files', async () => {
    const root = makeTempRoot();
    const libraryPath = join(root, 'library.flac');
    const temporaryPath = join(root, 'Temporary Song.opus');
    const unsupportedPath = join(root, 'cover.png');
    writeFileSync(libraryPath, 'not real audio');
    writeFileSync(temporaryPath, 'not real audio');
    writeFileSync(unsupportedPath, 'image');
    getTrackByPathMock.mockImplementation((path: string) =>
      path === resolve(libraryPath)
        ? {
            id: 'track-1',
            path,
            title: 'Library Song',
            artist: 'Artist',
            album: '',
            albumArtist: 'Artist',
            trackNo: null,
            discNo: null,
            year: null,
            genre: null,
            duration: 1,
            codec: 'FLAC',
            sampleRate: 44100,
            bitDepth: 16,
            bitrate: null,
            coverId: null,
            coverThumb: null,
            fieldSources: {},
          }
        : null,
    );

    const result = await resolveLocalAudioFiles([libraryPath, temporaryPath, unsupportedPath]);

    expect(result.rejected).toEqual([{ path: resolve(unsupportedPath), reason: 'unsupported' }]);
    expect(result.tracks[0]).toMatchObject({ id: 'track-1', title: 'Library Song' });
    expect(result.tracks[0]?.isTemporary).toBeUndefined();
    expect(result.tracks[1]).toMatchObject({
      id: expect.stringMatching(/^temporary-local:/),
      title: 'Temporary Song',
      isTemporary: true,
      path: resolve(temporaryPath),
    });
  });
});

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
