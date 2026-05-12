import { randomUUID } from 'node:crypto';
import { basename, dirname } from 'node:path';
import type { EchoDatabase } from '../../database/createDatabase';
import type { FieldSources } from '../libraryTypes';
import type {
  AppliedNetworkFields,
  NetworkCoverCandidateInput,
  NetworkDecision,
  NetworkMetadataCandidateInput,
  NetworkMissingMetadataTarget,
  NetworkTrackLookup,
  StoredNetworkCoverCandidate,
  StoredNetworkMetadataCandidate,
} from './networkTypes';
import type { LibraryTrack, MissingMetadataReason } from '../../../shared/types/library';

type DbRow = Record<string, unknown>;

const nowIso = (): string => new Date().toISOString();
const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
const numberOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const providerName = (value: unknown): StoredNetworkMetadataCandidate['provider'] =>
  value === 'musicbrainz' ||
  value === 'cover-art-archive' ||
  value === 'netease-cloud-music' ||
  value === 'qq-music'
    ? value
    : 'mock';

const parseJsonObject = (value: unknown): Record<string, string> => {
  if (typeof value !== 'string') {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
};

export class NetworkMetadataStore {
  constructor(private readonly database: EchoDatabase) {}

  transaction<T>(work: () => T): T {
    if (this.database.inTransaction) {
      return work();
    }

    return this.database.transaction(work)();
  }

  getTrackLookup(trackId: string): NetworkTrackLookup | null {
    this.repairStaleReadiness(trackId);

    const row = this.getRow(
      `SELECT id, path, title, artist, album, album_artist, duration, track_no, year,
        field_sources_json, embedded_metadata_status, embedded_cover_status
       FROM tracks
       WHERE id = ? AND missing = 0`,
      trackId,
    );

    if (!row) {
      return null;
    }

    const filePath = String(row.path);
    return {
      trackId: String(row.id),
      title: String(row.title ?? ''),
      artist: String(row.artist ?? ''),
      album: String(row.album ?? ''),
      albumArtist: String(row.album_artist ?? ''),
      duration: Number(row.duration ?? 0),
      trackNo: numberOrNull(row.track_no),
      year: numberOrNull(row.year),
      filename: basename(filePath),
      folder: basename(dirname(filePath)),
      fieldSources: parseJsonObject(row.field_sources_json) as FieldSources,
      embeddedMetadataStatus: this.embeddedStatus(row.embedded_metadata_status),
      embeddedCoverStatus: this.embeddedStatus(row.embedded_cover_status),
    };
  }

  findMissingMetadataTargets(limit = 25): NetworkMissingMetadataTarget[] {
    this.repairStaleReadiness();

    const rows = this.allRows(
      `SELECT
        tracks.id, tracks.path, tracks.title, tracks.artist, tracks.album, tracks.album_artist,
        tracks.track_no, tracks.disc_no, tracks.year, tracks.genre, tracks.duration, tracks.codec,
        tracks.sample_rate, tracks.bit_depth, tracks.bitrate, tracks.cover_id, tracks.metadata_status,
        tracks.embedded_metadata_status, tracks.embedded_cover_status, tracks.network_metadata_status,
        tracks.field_sources_json, covers.source_type
       FROM tracks
       LEFT JOIN covers ON covers.id = tracks.cover_id
       WHERE tracks.missing = 0
       AND (
        covers.id IS NULL
        OR covers.source_type IS NULL
        OR covers.source_type = 'default'
        OR lower(trim(tracks.artist)) = ''
        OR lower(trim(tracks.artist)) = 'unknown artist'
        OR json_extract(tracks.field_sources_json, '$.title') IN ('unknown', 'filename_fallback')
        OR json_extract(tracks.field_sources_json, '$.artist') IN ('unknown', 'filename_fallback')
        OR json_extract(tracks.field_sources_json, '$.album') IN ('unknown', 'filename_fallback')
        OR json_extract(tracks.field_sources_json, '$.albumArtist') IN ('unknown', 'artist_fallback', 'filename_fallback')
       )
       ORDER BY tracks.path COLLATE NOCASE ASC
       LIMIT ?`,
      Math.max(1, Math.min(500, limit)),
    );
    const targets: NetworkMissingMetadataTarget[] = [];

    for (const row of rows) {
      const fieldSources = parseJsonObject(row.field_sources_json) as FieldSources;
      const reasons = this.missingReasons(row, fieldSources);

      if (!reasons.length) {
        continue;
      }

      const track = this.mapTrack(row, fieldSources);
      const filePath = String(row.path);
      targets.push({
        track,
        reasons,
        coverSource: textOrNull(row.source_type),
        trackId: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        albumArtist: track.albumArtist,
        duration: track.duration,
        trackNo: track.trackNo,
        year: track.year,
        filename: basename(filePath),
        folder: basename(dirname(filePath)),
        fieldSources,
        embeddedMetadataStatus: this.embeddedStatus(row.embedded_metadata_status),
        embeddedCoverStatus: this.embeddedStatus(row.embedded_cover_status),
      });

      if (targets.length >= limit) {
        break;
      }
    }

    return targets;
  }

  listTrackMetadataCandidates(trackId: string): StoredNetworkMetadataCandidate[] {
    return this.allRows(
      `SELECT * FROM network_metadata_candidates
       WHERE track_id = ?
       AND id NOT IN (
        SELECT candidate_id FROM network_metadata_decisions
        WHERE track_id = ? AND decision = 'rejected'
       )
       ORDER BY score DESC, created_at DESC`,
      trackId,
      trackId,
    ).map((row) => this.mapMetadataCandidate(row));
  }

  listTrackCoverCandidates(trackId: string): StoredNetworkCoverCandidate[] {
    return this.allRows(
      `SELECT * FROM network_cover_candidates
       WHERE track_id = ?
       ORDER BY score DESC, created_at DESC`,
      trackId,
    ).map((row) => this.mapCoverCandidate(row));
  }

  upsertMetadataCandidate(trackId: string, albumId: string | null, candidate: NetworkMetadataCandidateInput, score: number): StoredNetworkMetadataCandidate {
    const existing = this.getRow(
      `SELECT id FROM network_metadata_candidates
       WHERE track_id = ? AND provider = ? AND provider_item_id = ?`,
      trackId,
      candidate.provider,
      candidate.providerItemId,
    );
    const id = textOrNull(existing?.id) ?? randomUUID();
    const createdAt = nowIso();

    this.database
      .prepare(
        `INSERT INTO network_metadata_candidates (
          id, track_id, album_id, provider, provider_item_id, title, artist, album, album_artist,
          year, genre, duration, track_no, disc_no, cover_url, score, raw_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          artist = excluded.artist,
          album = excluded.album,
          album_artist = excluded.album_artist,
          year = excluded.year,
          genre = excluded.genre,
          duration = excluded.duration,
          track_no = excluded.track_no,
          disc_no = excluded.disc_no,
          cover_url = excluded.cover_url,
          score = excluded.score,
          raw_json = excluded.raw_json`,
      )
      .run(
        id,
        trackId,
        albumId,
        candidate.provider,
        candidate.providerItemId,
        candidate.title,
        candidate.artist,
        candidate.album,
        candidate.albumArtist,
        candidate.year,
        candidate.genre,
        candidate.duration,
        candidate.trackNo,
        candidate.discNo,
        candidate.coverUrl,
        score,
        JSON.stringify(candidate.raw ?? {}),
        createdAt,
      );

    this.database.prepare("UPDATE tracks SET network_metadata_status = 'candidate_found', updated_at = ? WHERE id = ?").run(createdAt, trackId);
    return this.mapMetadataCandidate(this.getRow('SELECT * FROM network_metadata_candidates WHERE id = ?', id)!);
  }

  upsertCoverCandidate(trackId: string | null, albumId: string | null, candidate: NetworkCoverCandidateInput): StoredNetworkCoverCandidate {
    const id = randomUUID();
    const createdAt = nowIso();

    this.database
      .prepare(
        `INSERT INTO network_cover_candidates (
          id, track_id, album_id, provider, cover_url, width, height, mime_type, score,
          cached_thumb_path, cached_large_path, raw_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        trackId,
        albumId,
        candidate.provider,
        candidate.coverUrl,
        candidate.width,
        candidate.height,
        candidate.mimeType,
        candidate.score,
        null,
        null,
        JSON.stringify(candidate.raw ?? {}),
        createdAt,
      );

    return this.mapCoverCandidate(this.getRow('SELECT * FROM network_cover_candidates WHERE id = ?', id)!);
  }

  recordDecision(trackId: string, candidateId: string, decision: NetworkDecision, appliedFields: AppliedNetworkFields): void {
    this.database
      .prepare(
        `INSERT INTO network_metadata_decisions (id, track_id, candidate_id, decision, applied_fields_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), trackId, candidateId, decision, JSON.stringify(appliedFields), nowIso());
  }

  getMetadataCandidate(candidateId: string): StoredNetworkMetadataCandidate | null {
    const row = this.getRow('SELECT * FROM network_metadata_candidates WHERE id = ?', candidateId);
    return row ? this.mapMetadataCandidate(row) : null;
  }

  getCoverCandidate(candidateId: string): StoredNetworkCoverCandidate | null {
    const row = this.getRow('SELECT * FROM network_cover_candidates WHERE id = ?', candidateId);
    return row ? this.mapCoverCandidate(row) : null;
  }

  hasRejectedDecision(trackId: string, candidateId: string): boolean {
    const row = this.getRow(
      "SELECT id FROM network_metadata_decisions WHERE track_id = ? AND candidate_id = ? AND decision = 'rejected' LIMIT 1",
      trackId,
      candidateId,
    );
    return Boolean(row);
  }

  repairStaleReadiness(trackId?: string): void {
    if (this.hasActiveScanJob() || !this.hasFinishedScanJob()) {
      return;
    }

    const whereTrack = trackId ? 'AND tracks.id = ?' : '';
    const rows = this.allRows(
      `SELECT tracks.id, tracks.field_sources_json, tracks.embedded_metadata_status, tracks.embedded_cover_status,
        covers.source_type
       FROM tracks
       LEFT JOIN covers ON covers.id = tracks.cover_id
       WHERE tracks.missing = 0
       ${whereTrack}
       AND (
        tracks.embedded_metadata_status IN ('pending', 'reading')
        OR tracks.embedded_cover_status IN ('pending', 'reading')
       )`,
      ...(trackId ? [trackId] : []),
    );

    const statement = this.database.prepare(
      `UPDATE tracks SET embedded_metadata_status = ?, embedded_cover_status = ?, updated_at = ?
       WHERE id = ?`,
    );
    const timestamp = nowIso();

    for (const row of rows) {
      const fieldSources = parseJsonObject(row.field_sources_json);
      const hasEmbeddedMetadata = ['title', 'artist', 'album', 'albumArtist', 'trackNo', 'discNo', 'year', 'genre'].some(
        (key) => fieldSources[key] === 'embedded',
      );
      const currentMetadataStatus = this.embeddedStatus(row.embedded_metadata_status);
      const currentCoverStatus = this.embeddedStatus(row.embedded_cover_status);
      const nextMetadataStatus =
        currentMetadataStatus === 'pending' || currentMetadataStatus === 'reading'
          ? hasEmbeddedMetadata
            ? 'present'
            : 'missing'
          : currentMetadataStatus;
      const nextCoverStatus =
        currentCoverStatus === 'pending' || currentCoverStatus === 'reading'
          ? row.source_type === 'embedded'
            ? 'present'
            : 'missing'
          : currentCoverStatus;

      statement.run(nextMetadataStatus, nextCoverStatus, timestamp, String(row.id));
    }
  }

  private hasActiveScanJob(): boolean {
    const row = this.getRow("SELECT id FROM scan_jobs WHERE status IN ('queued', 'running') LIMIT 1");
    return Boolean(row);
  }

  private hasFinishedScanJob(): boolean {
    const row = this.getRow("SELECT id FROM scan_jobs WHERE status IN ('completed', 'failed', 'cancelled') LIMIT 1");
    return Boolean(row);
  }

  private embeddedStatus(value: unknown): NetworkTrackLookup['embeddedMetadataStatus'] {
    if (value === 'pending' || value === 'reading' || value === 'present' || value === 'missing' || value === 'error') {
      return value;
    }

    return 'pending';
  }

  private missingReasons(row: DbRow, fieldSources: FieldSources): MissingMetadataReason[] {
    const reasons = new Set<MissingMetadataReason>();
    const artist = String(row.artist ?? '').trim().toLocaleLowerCase();
    const sourceType = textOrNull(row.source_type);

    if (!sourceType || sourceType === 'default') {
      reasons.add('missing_cover');
    }

    if (!artist || artist === 'unknown artist' || fieldSources.artist === 'unknown') {
      reasons.add('unknown_artist');
    }

    for (const key of ['title', 'artist', 'album', 'albumArtist'] as const) {
      if (fieldSources[key] === 'filename_fallback' || fieldSources[key] === 'artist_fallback') {
        reasons.add('filename_fallback');
      }

      if (fieldSources[key] === 'unknown') {
        reasons.add('unknown_field');
      }
    }

    return [...reasons];
  }

  private mapTrack(row: DbRow, fieldSources: FieldSources): LibraryTrack {
    return {
      id: String(row.id),
      path: String(row.path),
      title: String(row.title ?? ''),
      artist: String(row.artist ?? ''),
      album: String(row.album ?? ''),
      albumArtist: String(row.album_artist ?? ''),
      trackNo: numberOrNull(row.track_no),
      discNo: numberOrNull(row.disc_no),
      year: numberOrNull(row.year),
      genre: textOrNull(row.genre),
      duration: Number(row.duration ?? 0),
      codec: textOrNull(row.codec),
      sampleRate: numberOrNull(row.sample_rate),
      bitDepth: numberOrNull(row.bit_depth),
      bitrate: numberOrNull(row.bitrate),
      coverId: textOrNull(row.cover_id),
      coverThumb: textOrNull(row.cover_id) ? `echo-cover://thumb/${encodeURIComponent(String(row.cover_id))}` : null,
      metadataStatus: textOrNull(row.metadata_status) ?? 'ok',
      embeddedMetadataStatus: this.embeddedStatus(row.embedded_metadata_status),
      embeddedCoverStatus: this.embeddedStatus(row.embedded_cover_status),
      networkMetadataStatus: this.networkStatus(row.network_metadata_status),
      fieldSources,
    };
  }

  private networkStatus(value: unknown): LibraryTrack['networkMetadataStatus'] {
    if (
      value === 'none' ||
      value === 'pending' ||
      value === 'candidate_found' ||
      value === 'applied_missing_only' ||
      value === 'rejected' ||
      value === 'error'
    ) {
      return value;
    }

    return 'none';
  }

  private mapMetadataCandidate(row: DbRow): StoredNetworkMetadataCandidate {
    return {
      id: String(row.id),
      trackId: String(row.track_id),
      albumId: textOrNull(row.album_id),
      provider: providerName(row.provider),
      providerItemId: String(row.provider_item_id),
      title: textOrNull(row.title),
      artist: textOrNull(row.artist),
      album: textOrNull(row.album),
      albumArtist: textOrNull(row.album_artist),
      year: numberOrNull(row.year),
      genre: textOrNull(row.genre),
      duration: numberOrNull(row.duration),
      trackNo: numberOrNull(row.track_no),
      discNo: numberOrNull(row.disc_no),
      coverUrl: textOrNull(row.cover_url),
      score: Number(row.score ?? 0),
      raw: JSON.parse(String(row.raw_json || '{}')) as unknown,
      createdAt: String(row.created_at),
    };
  }

  private mapCoverCandidate(row: DbRow): StoredNetworkCoverCandidate {
    return {
      id: String(row.id),
      trackId: textOrNull(row.track_id),
      albumId: textOrNull(row.album_id),
      provider: providerName(row.provider),
      coverUrl: String(row.cover_url),
      width: numberOrNull(row.width),
      height: numberOrNull(row.height),
      mimeType: textOrNull(row.mime_type),
      score: Number(row.score ?? 0),
      cachedThumbPath: textOrNull(row.cached_thumb_path),
      cachedLargePath: textOrNull(row.cached_large_path),
      raw: JSON.parse(String(row.raw_json || '{}')) as unknown,
      createdAt: String(row.created_at),
    };
  }

  private getRow(sql: string, ...params: unknown[]): DbRow | null {
    return this.database.prepare<unknown[], DbRow>(sql).get(...params) ?? null;
  }

  private allRows(sql: string, ...params: unknown[]): DbRow[] {
    return this.database.prepare<unknown[], DbRow>(sql).all(...params);
  }
}
