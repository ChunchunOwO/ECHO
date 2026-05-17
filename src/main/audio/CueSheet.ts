import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { decodeTextFileBytes } from '../../shared/utils/decodeTextFile';

export type CueTrack = {
  cuePath: string;
  audioPath: string;
  trackNumber: number;
  title: string | null;
  performer: string | null;
  album: string | null;
  albumArtist: string | null;
  startSeconds: number;
  endSeconds: number | null;
};

export type CueSheet = {
  cuePath: string;
  title: string | null;
  performer: string | null;
  tracks: CueTrack[];
};

const cueTrackSuffixPattern = /#cueTrack=(\d+)$/iu;

const decodeCueText = (buffer: Buffer): string => decodeTextFileBytes(buffer);

const cueValue = (line: string, command: string): string | null => {
  const pattern = new RegExp(`^${command}\\s+(?:"([^"]*)"|(.*))$`, 'iu');
  const match = line.match(pattern);
  const value = match?.[1] ?? match?.[2];
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const cueFileValue = (line: string): string | null => {
  const match = line.match(/^FILE\s+(?:"([^"]+)"|(\S+))/iu);
  const value = match?.[1] ?? match?.[2];
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const parseIndexTime = (value: string): number | null => {
  const match = value.match(/^(\d+):(\d{2}):(\d{2})$/u);
  if (!match) {
    return null;
  }

  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  const frames = Number(match[3]);
  if (!Number.isFinite(minutes) || seconds > 59 || frames > 74) {
    return null;
  }

  return minutes * 60 + seconds + frames / 75;
};

export const splitCueTrackPath = (filePath: string): { cuePath: string; trackNumber: number | null } => {
  const match = filePath.match(cueTrackSuffixPattern);
  if (!match) {
    return { cuePath: resolve(filePath), trackNumber: null };
  }

  return {
    cuePath: resolve(filePath.slice(0, match.index)),
    trackNumber: Number(match[1]),
  };
};

export const createCueTrackPath = (cuePath: string, trackNumber: number): string => `${resolve(cuePath)}#cueTrack=${trackNumber}`;

export const isCueTrackPath = (filePath: string): boolean => cueTrackSuffixPattern.test(filePath);

export const isCueSheetPath = (filePath: string): boolean => extname(splitCueTrackPath(filePath).cuePath).toLowerCase() === '.cue';

export const readCueSheet = (filePath: string): CueSheet => {
  const { cuePath, trackNumber } = splitCueTrackPath(filePath);
  const text = decodeCueText(readFileSync(cuePath));
  const cueDir = dirname(cuePath);
  let album: string | null = null;
  let albumArtist: string | null = null;
  let currentAudioPath: string | null = null;
  let currentTrack:
    | {
        trackNumber: number;
        title: string | null;
        performer: string | null;
        audioPath: string | null;
        startSeconds: number | null;
      }
    | null = null;
  const tracks: CueTrack[] = [];

  const commitTrack = (): void => {
    if (!currentTrack || currentTrack.startSeconds === null) {
      currentTrack = null;
      return;
    }

    const audioPath = currentTrack.audioPath ?? currentAudioPath;
    if (!audioPath) {
      currentTrack = null;
      return;
    }

    const previous = tracks.at(-1);
    if (previous && previous.audioPath === audioPath) {
      previous.endSeconds = currentTrack.startSeconds;
    }

    tracks.push({
      cuePath,
      audioPath,
      trackNumber: currentTrack.trackNumber,
      title: currentTrack.title,
      performer: currentTrack.performer,
      album,
      albumArtist,
      startSeconds: currentTrack.startSeconds,
      endSeconds: null,
    });
    currentTrack = null;
  };

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const fileValue = cueFileValue(line);
    if (fileValue) {
      commitTrack();
      currentAudioPath = resolve(cueDir, fileValue);
      continue;
    }

    const trackMatch = line.match(/^TRACK\s+(\d+)\s+\S+/iu);
    if (trackMatch) {
      commitTrack();
      currentTrack = {
        trackNumber: Number(trackMatch[1]),
        title: null,
        performer: null,
        audioPath: currentAudioPath,
        startSeconds: null,
      };
      continue;
    }

    const title = cueValue(line, 'TITLE');
    if (title) {
      if (currentTrack) {
        currentTrack.title = title;
      } else {
        album = title;
      }
      continue;
    }

    const performer = cueValue(line, 'PERFORMER');
    if (performer) {
      if (currentTrack) {
        currentTrack.performer = performer;
      } else {
        albumArtist = performer;
      }
      continue;
    }

    const indexMatch = line.match(/^INDEX\s+01\s+(\d+:\d{2}:\d{2})$/iu);
    if (indexMatch && currentTrack) {
      currentTrack.startSeconds = parseIndexTime(indexMatch[1]);
    }
  }

  commitTrack();

  const filteredTracks = tracks.filter((track) => existsSync(track.audioPath));
  return {
    cuePath,
    title: album,
    performer: albumArtist,
    tracks: trackNumber ? filteredTracks.filter((track) => track.trackNumber === trackNumber) : filteredTracks,
  };
};

export const resolveCueTrack = (filePath: string): CueTrack | null => {
  if (!isCueSheetPath(filePath)) {
    return null;
  }

  const sheet = readCueSheet(filePath);
  return sheet.tracks[0] ?? null;
};
