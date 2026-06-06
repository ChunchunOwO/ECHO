import { describe, expect, it } from 'vitest';
import type { LibraryTrack } from '../../shared/types/library';
import { AudioAuthenticityAnalyzer } from './AudioAuthenticityAnalyzer';

const track = (overrides: Partial<LibraryTrack>): LibraryTrack => ({
  id: 'track-1',
  mediaType: 'local',
  path: 'D:\\Music\\Song.flac',
  sourceId: null,
  provider: null,
  providerTrackId: null,
  remotePath: null,
  stableKey: 'track-1',
  title: 'Song',
  artist: 'Artist',
  album: 'Album',
  albumArtist: 'Artist',
  trackNo: null,
  discNo: null,
  year: null,
  genre: null,
  duration: 180,
  codec: 'FLAC',
  sampleRate: 44_100,
  bitDepth: 16,
  bitrate: 920_000,
  bpm: null,
  coverId: null,
  coverThumb: null,
  metadataStatus: 'complete',
  embeddedMetadataStatus: 'present',
  embeddedCoverStatus: 'missing',
  networkMetadataStatus: 'none',
  fieldSources: {},
  unavailable: false,
  ...overrides,
} as LibraryTrack);

describe('AudioAuthenticityAnalyzer', () => {
  it('marks normal lossless containers as trusted with explicit evidence', async () => {
    const analyzer = new AudioAuthenticityAnalyzer({
      now: () => new Date('2026-06-06T00:00:00.000Z'),
      existsSync: () => false,
    });

    await expect(analyzer.analyzeTrack(track({}))).resolves.toMatchObject({
      trackId: 'track-1',
      analyzedAt: '2026-06-06T00:00:00.000Z',
      status: 'ready',
      verdict: 'trusted_lossless',
      metrics: {
        codec: 'FLAC',
        extension: '.flac',
        sampleRate: 44_100,
        bitDepth: 16,
        bitrate: 920_000,
      },
      evidence: expect.arrayContaining([
        expect.objectContaining({ id: 'lossless_container' }),
      ]),
    });
  });

  it('flags unusually low bitrate lossless containers as likely transcodes', async () => {
    const analyzer = new AudioAuthenticityAnalyzer({ existsSync: () => false });

    await expect(analyzer.analyzeTrack(track({ bitrate: 256_000 }))).resolves.toMatchObject({
      verdict: 'likely_lossy_transcode',
      confidence: 0.68,
      evidence: expect.arrayContaining([
        expect.objectContaining({ id: 'low_lossless_bitrate', severity: 'risk' }),
      ]),
    });
  });

  it('treats valid DSD headers as container evidence instead of proof of native source', async () => {
    const analyzer = new AudioAuthenticityAnalyzer({
      existsSync: () => true,
      readDsdNativeSampleRate: async () => 2_822_400,
    });

    await expect(analyzer.analyzeTrack(track({
      path: 'D:\\Music\\Dsd.dsf',
      codec: 'DSF',
      sampleRate: 2_822_400,
      bitDepth: 1,
      bitrate: 5_644_800,
    }))).resolves.toMatchObject({
      verdict: 'trusted_dsd_container',
      confidence: 0.54,
      metrics: {
        dsdNativeSampleRate: 2_822_400,
      },
      evidence: expect.arrayContaining([
        expect.objectContaining({ id: 'dsd_header_rate' }),
        expect.objectContaining({ id: 'dsd_bitrate_plausible' }),
        expect.objectContaining({ id: 'dsd_source_not_proven', severity: 'warning' }),
      ]),
    });
  });

  it('flags PCM-rate and PCM-depth DSD metadata as likely PCM-to-DSD conversion', async () => {
    const analyzer = new AudioAuthenticityAnalyzer({
      existsSync: () => true,
      readDsdNativeSampleRate: async () => 2_822_400,
    });

    await expect(analyzer.analyzeTrack(track({
      path: 'D:\\Music\\PCM2DSD\\Song.dsf',
      codec: 'DSF',
      sampleRate: 44_100,
      bitDepth: 24,
      bitrate: 1_200_000,
    }))).resolves.toMatchObject({
      verdict: 'likely_pcm_to_dsd',
      confidence: 0.78,
      evidence: expect.arrayContaining([
        expect.objectContaining({ id: 'dsd_pcm_rate_metadata', severity: 'warning' }),
        expect.objectContaining({ id: 'dsd_pcm_bit_depth_metadata', severity: 'risk' }),
        expect.objectContaining({ id: 'dsd_transcode_text_hint', severity: 'risk' }),
      ]),
    });
  });

  it('downgrades DSD containers when only PCM-rate metadata is available', async () => {
    const analyzer = new AudioAuthenticityAnalyzer({
      existsSync: () => true,
      readDsdNativeSampleRate: async () => 2_822_400,
    });

    await expect(analyzer.analyzeTrack(track({
      path: 'D:\\Music\\Dsd.dsf',
      codec: 'DSF',
      sampleRate: 44_100,
      bitDepth: 1,
      bitrate: 5_644_800,
    }))).resolves.toMatchObject({
      verdict: 'dsd_metadata_mismatch',
      evidence: expect.arrayContaining([
        expect.objectContaining({ id: 'dsd_pcm_rate_metadata', severity: 'warning' }),
      ]),
    });
  });
});
