import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';
import type { AudioLevelTelemetry, ChannelBalanceState } from '../../shared/types/audio';
import type { EqState } from '../../shared/types/eq';

export type PcmLevelSnapshot = {
  inputPeakDb: number | null;
  inputRmsDb: number | null;
  clipCount: number;
  lastClipAt: string | null;
};

export type AudioLevelEstimate = AudioLevelTelemetry;

const meterSource = 'pre_native_estimated_post_dsp' as const;
const defaultMaxObservedSamplesPerChunk = 8192;

const dbFromLinear = (value: number): number | null => {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.round(20 * Math.log10(value) * 10) / 10;
};

const linearGainToDb = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) {
    return -Infinity;
  }

  return 20 * Math.log10(value);
};

const computeChannelBalanceGainDb = (state: ChannelBalanceState): number => {
  const balance = Math.max(-1, Math.min(1, state.balance));

  if (!state.constantPower) {
    const left = state.leftGainDb + linearGainToDb(balance > 0 ? 1 - balance : 1);
    const right = state.rightGainDb + linearGainToDb(balance < 0 ? 1 + balance : 1);
    return Math.max(0, left, right);
  }

  const pan = (balance + 1) * Math.PI * 0.25;
  const compensation = Math.sqrt(2);
  const left = state.leftGainDb + linearGainToDb(Math.min(1, Math.cos(pan) * compensation));
  const right = state.rightGainDb + linearGainToDb(Math.min(1, Math.sin(pan) * compensation));
  return Math.max(0, left, right);
};

export const computeDspEstimatedGainDb = (eqState: EqState, channelBalanceState: ChannelBalanceState): number => {
  const eqGainDb = eqState.enabled
    ? eqState.preampDb + Math.max(0, ...eqState.bands.map((band) => (band.enabled === false ? 0 : band.gainDb)))
    : 0;
  const channelGainDb = channelBalanceState.enabled ? computeChannelBalanceGainDb(channelBalanceState) : 0;

  return Math.round((eqGainDb + channelGainDb) * 10) / 10;
};

const addDb = (value: number | null, gainDb: number): number | null =>
  value === null ? null : Math.round((value + gainDb) * 10) / 10;

export const createAudioLevelTelemetry = (
  snapshot: PcmLevelSnapshot,
  eqState: EqState,
  channelBalanceState: ChannelBalanceState,
): AudioLevelEstimate => {
  const estimatedGainDb = computeDspEstimatedGainDb(eqState, channelBalanceState);
  const estimatedOutputPeakDb = addDb(snapshot.inputPeakDb, estimatedGainDb);
  const estimatedOutputRmsDb = addDb(snapshot.inputRmsDb, estimatedGainDb);

  return {
    inputPeakDb: snapshot.inputPeakDb,
    inputRmsDb: snapshot.inputRmsDb,
    estimatedOutputPeakDb,
    estimatedOutputRmsDb,
    headroomDb: estimatedOutputPeakDb === null ? null : Math.round(-estimatedOutputPeakDb * 10) / 10,
    clipCount: snapshot.clipCount,
    lastClipAt: snapshot.lastClipAt,
    meterSource,
  };
};

export class PcmLevelMeterTransform extends Transform {
  private readonly intervalMs: number;
  private readonly onSnapshot: (snapshot: PcmLevelSnapshot) => void;
  private readonly maxObservedSamplesPerChunk: number;
  private remainder = Buffer.alloc(0);
  private gain = 1;
  private peakAbs = 0;
  private sumSquares = 0;
  private sampleCount = 0;
  private clipCount = 0;
  private lastClipAt: string | null = null;
  private lastEmitAt = 0;

  constructor(
    onSnapshot: (snapshot: PcmLevelSnapshot) => void,
    intervalMs = 100,
    maxObservedSamplesPerChunk = defaultMaxObservedSamplesPerChunk,
  ) {
    super();
    this.onSnapshot = onSnapshot;
    this.intervalMs = intervalMs;
    this.maxObservedSamplesPerChunk = Math.max(1, Math.round(maxObservedSamplesPerChunk));
  }

  setGain(gain: number): void {
    this.gain = Number.isFinite(gain) ? Math.max(0, Math.min(1, gain)) : 1;
  }

  getSnapshot(): PcmLevelSnapshot {
    return {
      inputPeakDb: dbFromLinear(this.peakAbs),
      inputRmsDb: this.sampleCount > 0 ? dbFromLinear(Math.sqrt(this.sumSquares / this.sampleCount)) : null,
      clipCount: this.clipCount,
      lastClipAt: this.lastClipAt,
    };
  }

  reset(): void {
    this.remainder = Buffer.alloc(0);
    this.peakAbs = 0;
    this.sumSquares = 0;
    this.sampleCount = 0;
    this.clipCount = 0;
    this.lastClipAt = null;
    this.lastEmitAt = 0;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.observe(chunk);
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    if (this.remainder.length >= 4) {
      this.observe(Buffer.alloc(0));
    }
    this.emitSnapshot(true);
    callback();
  }

  private observe(chunk: Buffer): void {
    const input = this.remainder.length > 0 ? Buffer.concat([this.remainder, chunk]) : chunk;
    const completeBytes = input.length - (input.length % 4);
    this.remainder = completeBytes < input.length ? Buffer.from(input.subarray(completeBytes)) : Buffer.alloc(0);

    this.observeSamples(input, completeBytes);

    this.emitSnapshot(false);
  }

  private observeSamples(input: Buffer, completeBytes: number): void {
    const totalSamples = completeBytes / 4;
    if (totalSamples <= 0) {
      return;
    }

    if (totalSamples <= this.maxObservedSamplesPerChunk) {
      for (let index = 0; index < totalSamples; index += 1) {
        this.observeSample(input, index * 4);
      }
      return;
    }

    if (this.maxObservedSamplesPerChunk === 1) {
      this.observeSample(input, 0);
      return;
    }

    const step = (totalSamples - 1) / (this.maxObservedSamplesPerChunk - 1);
    let previousIndex = -1;
    for (let sample = 0; sample < this.maxObservedSamplesPerChunk; sample += 1) {
      const sampleIndex = Math.min(totalSamples - 1, Math.round(sample * step));
      if (sampleIndex === previousIndex) {
        continue;
      }
      previousIndex = sampleIndex;
      this.observeSample(input, sampleIndex * 4);
    }
  }

  private observeSample(input: Buffer, offset: number): void {
    const sample = input.readFloatLE(offset) * this.gain;

    if (!Number.isFinite(sample)) {
      return;
    }

    const absSample = Math.abs(sample);
    this.peakAbs = Math.max(this.peakAbs, absSample);
    this.sumSquares += sample * sample;
    this.sampleCount += 1;

    if (absSample >= 1) {
      this.clipCount += 1;
      this.lastClipAt = new Date().toISOString();
    }
  }

  private emitSnapshot(force: boolean): void {
    const now = Date.now();

    if (!force && now - this.lastEmitAt < this.intervalMs) {
      return;
    }

    this.lastEmitAt = now;
    this.onSnapshot(this.getSnapshot());
  }
}
