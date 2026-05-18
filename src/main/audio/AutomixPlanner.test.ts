import { describe, expect, it } from 'vitest';
import {
  planAutomixTransition,
  type TrackTransitionAnalysis,
} from './AutomixPlanner';

const makeAnalysis = (patch: Partial<TrackTransitionAnalysis> = {}): TrackTransitionAnalysis => {
  const durationSeconds = patch.durationSeconds ?? 180;
  return {
    status: 'complete',
    durationSeconds,
    introStartSeconds: 0,
    introEndSeconds: 12,
    outroStartSeconds: Math.max(0, durationSeconds - 24),
    outroEndSeconds: durationSeconds,
    leadingSilenceSeconds: 0,
    trailingSilenceSeconds: 0,
    rmsDb: -16,
    lufsDb: -16,
    energyCurve: [0.12, 0.35, 0.64, 0.76, 0.82, 0.78, 0.72, 0.68, 0.61, 0.55, 0.48, 0.41],
    bpm: 124,
    beatOffsetMs: 0,
    beatConfidence: 0.9,
    ...patch,
  };
};

describe('AutomixPlanner', () => {
  it('skips next-track intro silence and trims current trailing silence before a beat-aligned transition', () => {
    const plan = planAutomixTransition({
      currentProbe: { durationSeconds: 180 },
      nextProbe: { durationSeconds: 210 },
      currentAnalysis: makeAnalysis({ trailingSilenceSeconds: 3.4, bpm: 124, beatConfidence: 0.93 }),
      nextAnalysis: makeAnalysis({ durationSeconds: 210, leadingSilenceSeconds: 2.5, bpm: 123.5, beatConfidence: 0.91 }),
      maxTransitionSeconds: 12,
      beatAlignEnabled: true,
    });

    expect(plan).not.toBeNull();
    expect(plan?.mode).toBe('beatAligned');
    expect(plan?.beatAligned).toBe(true);
    expect(plan?.skipIntroSilence).toBe(true);
    expect(plan?.nextStartSeconds).toBeGreaterThanOrEqual(2.46);
    expect(plan?.currentEndSeconds).toBeLessThan(180);
    expect(plan?.overlapSeconds).toBeGreaterThanOrEqual(7);
    expect(plan?.curve).toBe('hsin');
  });

  it('uses energyFade when beat confidence is weak but energy curves are available', () => {
    const plan = planAutomixTransition({
      currentProbe: { durationSeconds: 160 },
      nextProbe: { durationSeconds: 170 },
      currentAnalysis: makeAnalysis({ durationSeconds: 160, bpm: 118, beatConfidence: 0.31 }),
      nextAnalysis: makeAnalysis({ durationSeconds: 170, bpm: 146, beatConfidence: 0.2, rmsDb: -20, lufsDb: -20 }),
      maxTransitionSeconds: 10,
      beatAlignEnabled: true,
    });

    expect(plan?.mode).toBe('energyFade');
    expect(plan?.beatAligned).toBe(false);
    expect(plan?.nextGainDb).toBeGreaterThan(0);
    expect(plan?.fallbackReason).toBeNull();
  });

  it('falls back to a short gapless fade for short tracks', () => {
    const plan = planAutomixTransition({
      currentProbe: { durationSeconds: 18 },
      nextProbe: { durationSeconds: 32 },
      currentAnalysis: makeAnalysis({ durationSeconds: 18, bpm: 128, beatConfidence: 0.9 }),
      nextAnalysis: makeAnalysis({ durationSeconds: 32, bpm: 128, beatConfidence: 0.9 }),
      maxTransitionSeconds: 12,
      beatAlignEnabled: true,
    });

    expect(plan?.mode).toBe('gaplessFallback');
    expect(plan?.fallbackReason).toBe('short_track');
    expect(plan?.overlapSeconds).toBeLessThanOrEqual(2.5);
    expect(plan?.curve).toBe('qsin');
  });

  it('moves the transition before a weak fade-out tail', () => {
    const plan = planAutomixTransition({
      currentProbe: { durationSeconds: 180 },
      nextProbe: { durationSeconds: 180 },
      currentAnalysis: makeAnalysis({
        durationSeconds: 180,
        bpm: 111,
        beatConfidence: 0.25,
        energyCurve: [0.2, 0.55, 0.78, 0.86, 0.8, 0.72, 0.65, 0.5, 0.28, 0.16, 0.09, 0.04],
      }),
      nextAnalysis: makeAnalysis({ durationSeconds: 180, bpm: 142, beatConfidence: 0.25 }),
      maxTransitionSeconds: 12,
    });

    expect(plan?.mode).toBe('energyFade');
    expect(plan?.currentEndSeconds).toBeLessThanOrEqual(172);
    expect(plan?.overlapSeconds).toBeGreaterThanOrEqual(7);
  });

  it('returns null when there is not enough remaining audio to build a transition', () => {
    const plan = planAutomixTransition({
      currentProbe: { durationSeconds: 120 },
      nextProbe: { durationSeconds: 120 },
      currentStartSeconds: 117,
      currentAnalysis: makeAnalysis({ durationSeconds: 120 }),
      nextAnalysis: makeAnalysis({ durationSeconds: 120 }),
      maxTransitionSeconds: 12,
    });

    expect(plan).toBeNull();
  });

  it('clamps loudness compensation to avoid abrupt level jumps', () => {
    const plan = planAutomixTransition({
      currentProbe: { durationSeconds: 140 },
      nextProbe: { durationSeconds: 140 },
      currentAnalysis: makeAnalysis({ durationSeconds: 140, rmsDb: -12, lufsDb: -12, bpm: 110, beatConfidence: 0.25 }),
      nextAnalysis: makeAnalysis({ durationSeconds: 140, rmsDb: -2, lufsDb: -2, bpm: 150, beatConfidence: 0.25 }),
      maxTransitionSeconds: 12,
    });

    expect(plan?.mode).toBe('energyFade');
    expect(plan?.nextGainDb).toBe(-5.5);
    expect(plan?.currentGainDb).toBeLessThanOrEqual(0);
  });
});
