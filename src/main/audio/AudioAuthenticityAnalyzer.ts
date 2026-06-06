import { existsSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import type { LibraryTrack } from '../../shared/types/library';
import type {
  PluginAudioAnalysisEvidence,
  PluginAudioAnalysisReport,
  PluginAudioAnalysisVerdict,
} from '../../shared/types/plugins';
import {
  isDsdCodec,
  isDsdFilePath,
  readDsdNativeSampleRate,
} from './DsdProbe';

type AudioAuthenticityAnalyzerDependencies = {
  now?: () => Date;
  existsSync?: (path: string) => boolean;
  statSync?: typeof statSync;
  readDsdNativeSampleRate?: (filePath: string) => Promise<number | null>;
};

const losslessCodecs = new Set(['flac', 'alac', 'wav', 'wave', 'aiff', 'aif', 'ape']);
const lossyCodecs = new Set(['mp3', 'aac', 'ogg', 'opus', 'vorbis', 'wma']);
const losslessExtensions = new Set(['.flac', '.alac', '.wav', '.wave', '.aiff', '.aif', '.ape']);
const lossyExtensions = new Set(['.mp3', '.aac', '.m4a', '.ogg', '.opus', '.wma']);
const dsdNativeRateFloor = 1_000_000;
const dsdTextTranscodePattern = /(?:pcm\s*(?:to|2)\s*dsd|upsampl|up[-_\s]?convert|converted\s+to\s+dsd|dsd\s+convert|remodulat|noise[-_\s]?shap|hqplayer|foobar|sacd[-_\s]?r|升频|升采样|升取样|转\s*dsd|轉\s*dsd|转码|轉碼|转制|轉製|假\s*dsd|fake\s*dsd)/iu;

const cleanText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const positiveNumber = (value: unknown): number | null => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null;
};

const normalizedCodecTokens = (codec: string | null): string[] =>
  (codec ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);

const hasCodecToken = (codec: string | null, tokens: Set<string>): boolean =>
  normalizedCodecTokens(codec).some((token) => tokens.has(token));

const evidence = (id: string, severity: PluginAudioAnalysisEvidence['severity'], message: string): PluginAudioAnalysisEvidence => ({
  id,
  severity,
  message,
});

const clampConfidence = (value: number): number =>
  Math.max(0, Math.min(1, Math.round(value * 100) / 100));

const formatKhz = (value: number): string =>
  value >= 1_000_000
    ? `${Math.round(value / 10_000) / 100} MHz`
    : `${Math.round(value / 100) / 10} kHz`;

const formatMbps = (value: number): string =>
  `${Math.round(value / 10_000) / 100} Mbps`;

const dsdFamily = (sampleRate: number): string => {
  const multiple = Math.round(sampleRate / 44_100);
  return multiple >= 64 ? `DSD${multiple}` : `${formatKhz(sampleRate)} DSD`;
};

const observedBitrate = (bitrate: number | null, fileSizeBytes: number | null, durationSeconds: number | null): number | null => {
  if (fileSizeBytes !== null && durationSeconds !== null && durationSeconds > 0) {
    return (fileSizeBytes * 8) / durationSeconds;
  }

  return bitrate;
};

const dsdTextProbe = (track: LibraryTrack, filePath: string | null, codec: string | null): string =>
  [
    filePath,
    codec,
    track.title,
    track.album,
    track.artist,
    track.albumArtist,
    track.genre,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ');

export class AudioAuthenticityAnalyzer {
  private readonly now: () => Date;
  private readonly exists: (path: string) => boolean;
  private readonly stat: typeof statSync;
  private readonly readDsdRate: (filePath: string) => Promise<number | null>;

  constructor(dependencies: AudioAuthenticityAnalyzerDependencies = {}) {
    this.now = dependencies.now ?? (() => new Date());
    this.exists = dependencies.existsSync ?? existsSync;
    this.stat = dependencies.statSync ?? statSync;
    this.readDsdRate = dependencies.readDsdNativeSampleRate ?? readDsdNativeSampleRate;
  }

  async analyzeTrack(track: LibraryTrack): Promise<PluginAudioAnalysisReport> {
    const filePath = cleanText(track.path);
    const codec = cleanText(track.codec);
    const extension = filePath ? extname(filePath).toLowerCase() || null : null;
    const sampleRate = positiveNumber(track.sampleRate);
    const bitDepth = positiveNumber(track.bitDepth);
    const bitrate = positiveNumber(track.bitrate);
    const durationSeconds = positiveNumber(track.duration);
    const fileSizeBytes = this.resolveFileSize(filePath);
    const dsdByName = isDsdFilePath(filePath) || isDsdCodec(codec);
    const dsdNativeSampleRate = dsdByName && filePath && this.exists(filePath)
      ? await this.readDsdRate(filePath)
      : null;
    const items: PluginAudioAnalysisEvidence[] = [];
    const limitations: string[] = [
      'This quick report uses host-controlled metadata, file size, and DSD header checks; it does not prove the original mastering source.',
      'Lossy-to-lossless and PCM-to-DSD conclusions remain probabilistic until spectral analysis is added.',
    ];

    if (!filePath) {
      return this.report(track.id, 'unsupported', 'unknown', 0.1, {
        codec,
        extension,
        sampleRate,
        bitDepth,
        bitrate,
        durationSeconds,
        fileSizeBytes,
        dsdNativeSampleRate,
      }, [evidence('track_path_missing', 'warning', 'Track has no local path exposed to the host analyzer.')], limitations);
    }

    if (dsdByName) {
      items.push(evidence('dsd_container_hint', 'info', 'Track is identified as DSF/DFF/DSD by codec or file extension.'));
      if (dsdNativeSampleRate !== null) {
        items.push(evidence('dsd_header_rate', 'info', `DSD header reports ${dsdFamily(dsdNativeSampleRate)} native rate (${Math.round(dsdNativeSampleRate)} Hz).`));
      } else {
        items.push(evidence('dsd_header_unverified', 'warning', 'No native DSD sample rate was verified from the file header, so the container claim is not enough to trust the source.'));
      }

      const pcmRateMetadata = sampleRate !== null && sampleRate < dsdNativeRateFloor;
      const pcmBitDepthMetadata = bitDepth !== null && bitDepth > 1;
      const textProbe = dsdTextProbe(track, filePath, codec);
      const hasTranscodeTextHint = dsdTextTranscodePattern.test(textProbe);
      const measuredBitrate = observedBitrate(bitrate, fileSizeBytes, durationSeconds);
      let dsdBitrateRisk = false;
      let dsdBitrateWarning = false;

      if (pcmRateMetadata) {
        items.push(evidence('dsd_pcm_rate_metadata', 'warning', `Library metadata exposes PCM-rate ${Math.round(sampleRate)} Hz for a DSD-looking track; this may be a decode path or a PCM-sourced conversion, not proof of native DSD provenance.`));
      }

      if (pcmBitDepthMetadata) {
        items.push(evidence('dsd_pcm_bit_depth_metadata', 'risk', `DSD should be 1-bit at the container level, but metadata reports ${Math.round(bitDepth)} bit PCM-style depth.`));
      }

      if (hasTranscodeTextHint) {
        items.push(evidence('dsd_transcode_text_hint', 'risk', 'Path, title, album, artist, or genre contains wording commonly used for PCM-to-DSD conversion or upsampling.'));
      }

      if (dsdNativeSampleRate !== null && measuredBitrate !== null) {
        const expectedStereoBitrate = dsdNativeSampleRate * 2;
        const ratioToStereo = measuredBitrate / expectedStereoBitrate;
        if (ratioToStereo < 0.35) {
          dsdBitrateRisk = true;
          items.push(evidence('dsd_bitrate_far_below_native', 'risk', `Observed bitrate ${formatMbps(measuredBitrate)} is far below uncompressed stereo ${dsdFamily(dsdNativeSampleRate)} around ${formatMbps(expectedStereoBitrate)}. This is suspicious unless the file uses a known compressed DSD variant.`));
        } else if (ratioToStereo < 0.72) {
          dsdBitrateWarning = true;
          items.push(evidence('dsd_bitrate_below_native', 'warning', `Observed bitrate ${formatMbps(measuredBitrate)} is below normal uncompressed stereo ${dsdFamily(dsdNativeSampleRate)} around ${formatMbps(expectedStereoBitrate)}; treat source authenticity as unproven.`));
        } else {
          items.push(evidence('dsd_bitrate_plausible', 'info', `Observed bitrate ${formatMbps(measuredBitrate)} is plausible for ${dsdFamily(dsdNativeSampleRate)} container data.`));
        }
      } else {
        items.push(evidence('dsd_bitrate_unverified', 'warning', 'No reliable duration/file-size bitrate cross-check was available for the DSD container.'));
      }

      if (hasTranscodeTextHint || dsdBitrateRisk || (pcmRateMetadata && pcmBitDepthMetadata)) {
        return this.report(track.id, 'ready', 'likely_pcm_to_dsd', hasTranscodeTextHint || dsdBitrateRisk ? 0.78 : 0.7, {
          codec,
          extension,
          sampleRate,
          bitDepth,
          bitrate,
          durationSeconds,
          fileSizeBytes,
          dsdNativeSampleRate,
        }, items, limitations);
      }

      if (pcmRateMetadata || pcmBitDepthMetadata || dsdNativeSampleRate === null || dsdBitrateWarning) {
        if (dsdNativeSampleRate === null && pcmRateMetadata) {
          items.push(evidence('dsd_header_missing_pcm_rate', 'risk', 'Track looks like DSD but only PCM-rate metadata was available and the host could not verify a native DSD header.'));
        }
        return this.report(track.id, 'ready', 'dsd_metadata_mismatch', 0.72, {
          codec,
          extension,
          sampleRate,
          bitDepth,
          bitrate,
          durationSeconds,
          fileSizeBytes,
          dsdNativeSampleRate,
        }, items, limitations);
      }
      items.push(evidence('dsd_source_not_proven', 'warning', 'Valid DSD container evidence does not prove the original mastering source; spectral/noise-shaping analysis is still required before calling it true native DSD.'));
      return this.report(track.id, 'ready', 'trusted_dsd_container', 0.54, {
        codec,
        extension,
        sampleRate,
        bitDepth,
        bitrate,
        durationSeconds,
        fileSizeBytes,
        dsdNativeSampleRate,
      }, items, limitations);
    }

    const codecIsLossless = hasCodecToken(codec, losslessCodecs) || (extension !== null && losslessExtensions.has(extension));
    const codecIsLossy = hasCodecToken(codec, lossyCodecs) || (extension !== null && lossyExtensions.has(extension));
    const isHiRes = (sampleRate !== null && sampleRate >= 88_200) || (bitDepth !== null && bitDepth >= 24);
    const longEnoughForBitrateSignal = durationSeconds === null || durationSeconds >= 45;

    if (codecIsLossy) {
      items.push(evidence('lossy_codec', 'info', 'Codec or extension is a known lossy format.'));
      return this.report(track.id, 'ready', 'lossy_source', 0.9, {
        codec,
        extension,
        sampleRate,
        bitDepth,
        bitrate,
        durationSeconds,
        fileSizeBytes,
        dsdNativeSampleRate,
      }, items, limitations);
    }

    if (!codecIsLossless) {
      items.push(evidence('codec_unknown', 'warning', 'Codec is not enough to classify this file as lossless or lossy.'));
      return this.report(track.id, 'ready', 'unknown', 0.3, {
        codec,
        extension,
        sampleRate,
        bitDepth,
        bitrate,
        durationSeconds,
        fileSizeBytes,
        dsdNativeSampleRate,
      }, items, limitations);
    }

    items.push(evidence('lossless_container', 'info', 'Codec or extension is a lossless container.'));
    if (bitrate !== null && longEnoughForBitrateSignal && bitrate < 360_000) {
      items.push(evidence('low_lossless_bitrate', 'risk', 'Average bitrate is unusually low for a normal lossless music file.'));
      return this.report(track.id, 'ready', 'likely_lossy_transcode', 0.68, {
        codec,
        extension,
        sampleRate,
        bitDepth,
        bitrate,
        durationSeconds,
        fileSizeBytes,
        dsdNativeSampleRate,
      }, items, limitations);
    }

    if (isHiRes && bitrate !== null && longEnoughForBitrateSignal && bitrate < 900_000) {
      items.push(evidence('low_hires_bitrate', 'risk', 'Track is marked Hi-Res but has a low average bitrate for 24-bit or high-sample-rate lossless audio.'));
      return this.report(track.id, 'ready', 'likely_fake_hires', 0.64, {
        codec,
        extension,
        sampleRate,
        bitDepth,
        bitrate,
        durationSeconds,
        fileSizeBytes,
        dsdNativeSampleRate,
      }, items, limitations);
    }

    if (sampleRate !== null) {
      items.push(evidence('sample_rate_present', 'info', `Sample rate is ${Math.round(sampleRate)} Hz.`));
    }
    if (bitDepth !== null) {
      items.push(evidence('bit_depth_present', 'info', `Bit depth is ${Math.round(bitDepth)} bit.`));
    }
    if (bitrate !== null) {
      items.push(evidence('bitrate_present', 'info', `Average bitrate is ${Math.round(bitrate)} bps.`));
    }

    return this.report(track.id, 'ready', 'trusted_lossless', isHiRes ? 0.58 : 0.7, {
      codec,
      extension,
      sampleRate,
      bitDepth,
      bitrate,
      durationSeconds,
      fileSizeBytes,
      dsdNativeSampleRate,
    }, items, limitations);
  }

  private resolveFileSize(filePath: string | null): number | null {
    if (!filePath || !this.exists(filePath)) {
      return null;
    }
    try {
      return this.stat(filePath).size;
    } catch {
      return null;
    }
  }

  private report(
    trackId: string,
    status: PluginAudioAnalysisReport['status'],
    verdict: PluginAudioAnalysisVerdict,
    confidence: number,
    metrics: PluginAudioAnalysisReport['metrics'],
    items: PluginAudioAnalysisEvidence[],
    limitations: string[],
  ): PluginAudioAnalysisReport {
    return {
      trackId,
      analyzedAt: this.now().toISOString(),
      status,
      verdict,
      confidence: clampConfidence(confidence),
      metrics,
      evidence: items,
      limitations,
    };
  }
}
