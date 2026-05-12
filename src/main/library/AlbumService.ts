import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

const normalizeKeyPart = (value: string): string => value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');

export type AlbumKeyInput = {
  albumTitle: string;
  albumArtist: string;
  fallbackArtist: string;
  albumArtistSource?: string;
  year: number | null;
  filePath: string;
  trackId: string;
};

const reliableAlbumArtistSources = new Set(['embedded', 'manual', 'network', 'sidecar']);

export class AlbumService {
  makeAlbumKey(input: AlbumKeyInput): string {
    const normalizedAlbum = normalizeKeyPart(input.albumTitle);

    if (normalizedAlbum.length === 0 || normalizedAlbum === 'unknown album') {
      return `unknown:${input.trackId}`;
    }

    const normalizedAlbumArtist = normalizeKeyPart(input.albumArtist || '');
    const hasReliableAlbumArtist =
      reliableAlbumArtistSources.has(input.albumArtistSource ?? '') &&
      normalizedAlbumArtist.length > 0 &&
      normalizedAlbumArtist !== 'unknown artist';
    const artistOrGrouping = hasReliableAlbumArtist ? normalizedAlbumArtist : `folder:${normalizeKeyPart(dirname(input.filePath))}`;
    const yearPart = input.year ? String(input.year) : '';
    const digest = createHash('sha1')
      .update(`${artistOrGrouping}\u0000${normalizedAlbum}\u0000${yearPart}`)
      .digest('hex');
    return digest;
  }
}
