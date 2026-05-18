import { describe, expect, it } from 'vitest';
import { analyzePcmTransitionSegment } from './AutomixAnalyzer';

const samplesForSeconds = (seconds: number, sampleRate: number, value: number): Float32Array =>
  new Float32Array(Math.max(0, Math.round(seconds * sampleRate))).fill(value);

const concatSamples = (...segments: Float32Array[]): Float32Array => {
  const totalLength = segments.reduce((sum, segment) => sum + segment.length, 0);
  const output = new Float32Array(totalLength);
  let offset = 0;
  for (const segment of segments) {
    output.set(segment, offset);
    offset += segment.length;
  }
  return output;
};

describe('AutomixAnalyzer PCM helpers', () => {
  it('detects leading and trailing silence and returns a normalized energy curve', () => {
    const sampleRate = 1000;
    const samples = concatSamples(
      samplesForSeconds(1.2, sampleRate, 0),
      samplesForSeconds(2.4, sampleRate, 0.35),
      samplesForSeconds(0.8, sampleRate, 0),
    );

    const analysis = analyzePcmTransitionSegment(samples, { sampleRate, buckets: 8 });

    expect(analysis.leadingSilenceSeconds).toBeCloseTo(1.2, 1);
    expect(analysis.trailingSilenceSeconds).toBeCloseTo(0.8, 1);
    expect(analysis.rmsDb).toBeLessThan(0);
    expect(analysis.energyCurve).toHaveLength(8);
    expect(Math.max(...analysis.energyCurve)).toBeCloseTo(1, 1);
    expect(analysis.energyCurve[0]).toBe(0);
  });
});
