import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteLibraryTrack, RemoteMetadataResult, RemoteSource } from '../../../shared/types/remoteSources';
import type { RemoteSourceSecret } from './remoteTypes';
import { RemoteBackgroundJobQueue } from './RemoteBackgroundJobQueue';

const serviceMocks = vi.hoisted(() => ({
  getLyricsForTrack: vi.fn(),
  searchNetworkCandidates: vi.fn(),
}));

vi.mock('../../lyrics/LyricsService', () => ({
  getLyricsService: () => ({
    getLyricsForTrack: serviceMocks.getLyricsForTrack,
  }),
}));

vi.mock('../../mv/MvService', () => ({
  getMvService: () => ({
    searchNetworkCandidates: serviceMocks.searchNetworkCandidates,
  }),
}));

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error('Timed out waiting for queue');
};

const makeSource = (): RemoteSourceSecret => ({
  id: 'source-1',
  provider: 'webdav',
  displayName: 'WebDAV',
  status: 'enabled',
  baseUrl: 'https://example.test/dav',
  username: null,
  authType: 'none',
  config: {},
  syncMode: 'index',
  lastTestAt: null,
  lastSyncAt: null,
  lastError: null,
  indexedTrackCount: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  secret: null,
});

const makeTrack = (): RemoteLibraryTrack => ({
  id: 'remote-track-1',
  sourceId: 'source-1',
  provider: 'webdav',
  remotePath: '/music/track.flac',
  stableKey: 'stable-1',
  title: 'track',
  artist: 'Unknown Artist',
  album: '',
  albumArtist: 'Unknown Artist',
  trackNo: null,
  discNo: null,
  year: null,
  genre: null,
  duration: null,
  codec: null,
  sampleRate: null,
  bitDepth: null,
  bitrate: null,
  sizeBytes: 1024,
  modifiedAt: '2026-01-01T00:00:00.000Z',
  etag: '"abc"',
  coverId: null,
  coverThumb: null,
  metadataStatus: 'pending',
  lyricsStatus: 'pending',
  mvStatus: 'pending',
  availability: 'available',
  fieldSources: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const makeMetadata = (): RemoteMetadataResult => ({
  status: 'partial',
  title: 'track',
  artist: 'Unknown Artist',
  album: '',
  albumArtist: 'Unknown Artist',
  trackNo: null,
  discNo: null,
  year: null,
  genre: null,
  duration: 123.4,
  codec: 'flac',
  sampleRate: 48000,
  bitDepth: 24,
  bitrate: null,
  fieldSources: { duration: 'range' },
  warnings: [],
  errors: [],
});

describe('RemoteBackgroundJobQueue', () => {
  beforeEach(() => {
    serviceMocks.getLyricsForTrack.mockReset().mockResolvedValue(null);
    serviceMocks.searchNetworkCandidates.mockReset().mockResolvedValue([]);
  });

  it('runs metadata jobs with bounded queue status and updates indexed tracks', async () => {
    const source = makeSource();
    const track = makeTrack();
    const readMetadata = vi.fn().mockResolvedValue(makeMetadata());
    const updates: string[] = [];
    const store = {
      getTracksForBackgroundJobs: vi.fn().mockReturnValue([track]),
      getTrack: vi.fn(() => track),
      getSource: vi.fn(() => source),
      getSourceWithSecret: vi.fn(() => source),
      updateTrackJobStatus: vi.fn((_trackId: string, _kind: string, status: string) => {
        updates.push(status);
        track.metadataStatus = status as RemoteLibraryTrack['metadataStatus'];
      }),
      updateTrackMetadata: vi.fn((_trackId: string, update: Partial<RemoteLibraryTrack>) => {
        Object.assign(track, update);
        return track;
      }),
    };
    const queue = new RemoteBackgroundJobQueue(store as never, () => ({ readMetadata } as never));

    const initial = queue.enqueueSource(source.id, ['metadata']);
    expect(initial.pending.metadata).toBe(1);

    await waitFor(() => queue.getStatus(source.id).completed.metadata === 1);

    expect(readMetadata).toHaveBeenCalledTimes(1);
    expect(store.updateTrackMetadata).toHaveBeenCalledWith(
      track.id,
      expect.objectContaining({
        duration: 123.4,
        codec: 'flac',
        metadataStatus: 'partial',
      }),
    );
    expect(updates).toContain('searching');
    expect(queue.getStatus(source.id).pending.metadata).toBe(0);
  });

  it('honors global pause and playback-aware concurrency limits', async () => {
    const source = { ...makeSource(), config: { metadataConcurrency: 4 } };
    const track = makeTrack();
    const readMetadata = vi.fn().mockResolvedValue(makeMetadata());
    const store = {
      getTracksForBackgroundJobs: vi.fn().mockReturnValue([track]),
      getTrack: vi.fn(() => track),
      getSource: vi.fn(() => source),
      getSourceWithSecret: vi.fn(() => source),
      updateTrackJobStatus: vi.fn(),
      updateTrackMetadata: vi.fn((_trackId: string, update: Partial<RemoteLibraryTrack>) => {
        Object.assign(track, update);
        return track;
      }),
    };
    const queue = new RemoteBackgroundJobQueue(store as never, () => ({ readMetadata } as never));

    queue.setPlaybackActive(true);
    expect(queue.getStatus(source.id).concurrency.metadata).toBe(1);

    queue.setGlobalPaused(true);
    queue.enqueueSource(source.id, ['metadata']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readMetadata).not.toHaveBeenCalled();
    expect(queue.getStatus(source.id).pending.metadata).toBe(1);

    queue.setGlobalPaused(false);
    await waitFor(() => queue.getStatus(source.id).completed.metadata === 1);
    expect(readMetadata).toHaveBeenCalledTimes(1);
  });

  it('runs lyrics and MV jobs only after metadata is matchable', async () => {
    const source = makeSource();
    const track = makeTrack();
    const metadata = {
      ...makeMetadata(),
      status: 'ok',
      title: 'Echo Song',
      artist: 'Echo Artist',
      album: 'Echo Album',
      albumArtist: 'Echo Artist',
      duration: 188,
    } satisfies RemoteMetadataResult;
    const readMetadata = vi.fn().mockResolvedValue(metadata);
    serviceMocks.getLyricsForTrack.mockResolvedValue({ id: 'lyrics-1' });
    serviceMocks.searchNetworkCandidates.mockResolvedValue([{ id: 'mv-1' }]);
    const store = {
      getTracksForBackgroundJobs: vi.fn().mockReturnValue([track]),
      getTrack: vi.fn(() => track),
      getSource: vi.fn(() => source),
      getSourceWithSecret: vi.fn(() => source),
      updateTrackJobStatus: vi.fn((_trackId: string, kind: string, status: string) => {
        if (kind === 'metadata' || kind === 'duration-backfill') {
          track.metadataStatus = status as RemoteLibraryTrack['metadataStatus'];
        } else if (kind === 'lyrics') {
          track.lyricsStatus = status as RemoteLibraryTrack['lyricsStatus'];
        } else if (kind === 'mv') {
          track.mvStatus = status as RemoteLibraryTrack['mvStatus'];
        }
      }),
      updateTrackMetadata: vi.fn((_trackId: string, update: Partial<RemoteLibraryTrack>) => {
        Object.assign(track, update);
        return track;
      }),
    };
    const queue = new RemoteBackgroundJobQueue(store as never, () => ({ readMetadata } as never));

    queue.enqueueSource(source.id, ['metadata']);

    await waitFor(() => queue.getStatus(source.id).completed.metadata === 1);
    await waitFor(() => queue.getStatus(source.id).completed.lyrics === 1 && queue.getStatus(source.id).completed.mv === 1);

    expect(serviceMocks.getLyricsForTrack).toHaveBeenCalledWith(track.id);
    expect(serviceMocks.searchNetworkCandidates).toHaveBeenCalledWith(track.id);
    expect(track.lyricsStatus).toBe('ok');
    expect(track.mvStatus).toBe('ok');
  });

  it('does not enqueue lyrics or MV matching for filename-only fallback metadata', async () => {
    const source = makeSource();
    const track = makeTrack();
    const store = {
      getTracksForBackgroundJobs: vi.fn().mockReturnValue([track]),
      getTrack: vi.fn(() => track),
      getSource: vi.fn(() => source),
      getSourceWithSecret: vi.fn(() => source),
      updateTrackJobStatus: vi.fn(),
      updateTrackMetadata: vi.fn(),
    };
    const queue = new RemoteBackgroundJobQueue(store as never, () => ({ readMetadata: vi.fn() } as never));

    const status = queue.enqueueSource(source.id, ['lyrics', 'mv']);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(status.pending.lyrics).toBe(0);
    expect(status.pending.mv).toBe(0);
    expect(serviceMocks.getLyricsForTrack).not.toHaveBeenCalled();
    expect(serviceMocks.searchNetworkCandidates).not.toHaveBeenCalled();
  });
});
