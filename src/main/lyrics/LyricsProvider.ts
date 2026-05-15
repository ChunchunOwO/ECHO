import { randomUUID } from 'node:crypto';
import type { LyricLine, LyricsProviderId, LyricsQuery, TrackLyrics } from '../../shared/types/lyrics';
import { detectLyricsKind, parsePlainLyrics, parseSyncedLyrics } from './lyricsParser';
import type { NormalizedLyricsQuery } from './lyricsQueryBuilder';

export type { LyricsProviderId };

export type LyricsProviderCapability = {
  synced: boolean;
  plain: boolean;
  translation: boolean;
  romanization: boolean;
  byDuration: boolean;
  byIsrc: boolean;
  byMusicBrainzId: boolean;
  needsAccount: boolean;
};

export type LyricsProviderSearchRequest = {
  query: LyricsQuery;
  normalized: NormalizedLyricsQuery;
  timeoutMs: number;
  signal?: AbortSignal;
};

export type LyricsProviderResult = {
  provider: LyricsProviderId;
  providerLyricsId: string | null;
  title: string;
  artist: string;
  album: string | null;
  durationSeconds: number | null;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
  translationLyrics?: string | null;
  romanizationLyrics?: string | null;
  sourceUrl?: string | null;
  sourceLabel?: string;
  matchReasons?: string[];
  raw?: unknown;
};

export interface LyricsProvider {
  id: LyricsProviderId;
  label: string;
  priority: number;
  capabilities: LyricsProviderCapability;

  search(request: LyricsProviderSearchRequest): Promise<LyricsProviderResult[]>;
  getById?(id: string, request: LyricsProviderSearchRequest): Promise<LyricsProviderResult | null>;
}

const normalizeSecondaryText = (value: string): string | null => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : null;
};

const secondaryTimestampToleranceMs = 350;
const looseSecondaryTimestampToleranceMs = 1500;

const findSyncedSecondaryText = (
  syncedLines: LyricLine[],
  line: LyricLine,
  usedIndexes: Set<number>,
): string | null => {
  if (line.timeMs >= 0) {
    let closestIndex = -1;
    let closestDelta = Number.POSITIVE_INFINITY;

    for (let index = 0; index < syncedLines.length; index += 1) {
      if (usedIndexes.has(index)) {
        continue;
      }

      const delta = Math.abs(syncedLines[index].timeMs - line.timeMs);
      if (delta === 0) {
        usedIndexes.add(index);
        return syncedLines[index].text;
      }

      if (delta < closestDelta) {
        closestDelta = delta;
        closestIndex = index;
      }
    }

    if (closestIndex >= 0 && closestDelta <= secondaryTimestampToleranceMs) {
      usedIndexes.add(closestIndex);
      return syncedLines[closestIndex].text;
    }
  }

  return null;
};

const assignLooseSecondaryByNearestLine = (
  lines: LyricLine[],
  syncedLines: LyricLine[],
  usedSecondaryIndexes: Set<number>,
): Map<number, string> => {
  const pairs: Array<{ lineIndex: number; secondaryIndex: number; delta: number }> = [];
  for (let secondaryIndex = 0; secondaryIndex < syncedLines.length; secondaryIndex += 1) {
    if (usedSecondaryIndexes.has(secondaryIndex)) {
      continue;
    }

    const secondaryLine = syncedLines[secondaryIndex];
    let closestLineIndex = -1;
    let closestDelta = Number.POSITIVE_INFINITY;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      if (line.timeMs < 0) {
        continue;
      }

      const delta = Math.abs(secondaryLine.timeMs - line.timeMs);
      if (delta < closestDelta) {
        closestDelta = delta;
        closestLineIndex = lineIndex;
      }
    }

    if (closestLineIndex >= 0 && closestDelta <= looseSecondaryTimestampToleranceMs) {
      pairs.push({ lineIndex: closestLineIndex, secondaryIndex, delta: closestDelta });
    }
  }

  const assignedLines = new Set<number>();
  const assignments = new Map<number, string>();
  for (const pair of pairs.sort((left, right) => left.delta - right.delta)) {
    if (assignedLines.has(pair.lineIndex) || usedSecondaryIndexes.has(pair.secondaryIndex)) {
      continue;
    }

    assignedLines.add(pair.lineIndex);
    usedSecondaryIndexes.add(pair.secondaryIndex);
    assignments.set(pair.lineIndex, syncedLines[pair.secondaryIndex].text);
  }

  return assignments;
};

const mergeSecondaryLines = (
  lines: LyricLine[],
  secondaryLyrics: string | null | undefined,
  field: 'romanization' | 'translation',
): LyricLine[] => {
  if (!secondaryLyrics || lines.length === 0) {
    return lines;
  }

  const syncedSecondary = parseSyncedLyrics(secondaryLyrics)
    .map((line) => ({ ...line, text: normalizeSecondaryText(line.text) ?? '' }))
    .filter((line) => line.text.length > 0);
  if (syncedSecondary.length > 0) {
    const usedIndexes = new Set<number>();
    let changed = false;
    const canFallbackByIndex = syncedSecondary.length === lines.length;
    const looseAssignments = assignLooseSecondaryByNearestLine(lines, syncedSecondary, usedIndexes);

    const nextLines = lines.map((line, index) => {
      const syncedText = findSyncedSecondaryText(syncedSecondary, line, usedIndexes);
      const secondaryText = syncedText ?? (
        canFallbackByIndex && !usedIndexes.has(index) ? syncedSecondary[index]?.text : null
      ) ?? looseAssignments.get(index) ?? null;
      if (!secondaryText || line[field] === secondaryText) {
        return line;
      }

      if (canFallbackByIndex && syncedText === null) {
        usedIndexes.add(index);
      }

      changed = true;
      return { ...line, [field]: secondaryText };
    });

    return changed ? nextLines : lines;
  }

  const plainSecondary = parsePlainLyrics(secondaryLyrics);
  if (plainSecondary.length === 0) {
    return lines;
  }

  let changed = false;
  const nextLines = lines.map((line, index) => {
    const secondaryText = normalizeSecondaryText(plainSecondary[index]?.text ?? '');
    if (!secondaryText || line[field] === secondaryText) {
      return line;
    }

    changed = true;
    return { ...line, [field]: secondaryText };
  });

  return changed ? nextLines : lines;
};

export const providerResultToTrackLyrics = (
  query: LyricsQuery,
  result: LyricsProviderResult,
  score: number | null,
): TrackLyrics | null => {
  const kind = detectLyricsKind({
    syncedLyrics: result.syncedLyrics,
    plainLyrics: result.plainLyrics,
    instrumental: result.instrumental,
  });
  const lines =
    kind === 'synced'
      ? parseSyncedLyrics(result.syncedLyrics ?? '')
      : kind === 'plain'
        ? parsePlainLyrics(result.plainLyrics ?? '')
        : [];
  const linesWithRomanization = mergeSecondaryLines(lines, result.romanizationLyrics, 'romanization');
  const linesWithSecondaryText = mergeSecondaryLines(linesWithRomanization, result.translationLyrics, 'translation');

  if (kind === 'empty') {
    return null;
  }

  const timestamp = new Date().toISOString();
  return {
    id: randomUUID(),
    trackId: query.trackId ?? null,
    provider: result.provider,
    providerLyricsId: result.providerLyricsId,
    kind,
    title: result.title,
    artist: result.artist,
    album: result.album,
    durationSeconds: result.durationSeconds,
    lines: linesWithSecondaryText,
    plainText: result.plainLyrics,
    syncedText: result.syncedLyrics,
    offsetMs: 0,
    score,
    cachedAt: timestamp,
    updatedAt: timestamp,
  };
};

const emptyCapability: LyricsProviderCapability = {
  synced: false,
  plain: false,
  translation: false,
  romanization: false,
  byDuration: false,
  byIsrc: false,
  byMusicBrainzId: false,
  needsAccount: false,
};

export class StubLyricsProvider implements LyricsProvider {
  capabilities: LyricsProviderCapability = { ...emptyCapability };

  constructor(
    readonly id: Exclude<LyricsProviderId, 'local' | 'lrclib' | 'manual'>,
    readonly label: string,
    readonly priority: number,
  ) {}

  async search(): Promise<LyricsProviderResult[]> {
    // Reserved for future provider integrations. Do not perform network work here.
    return [];
  }
}
