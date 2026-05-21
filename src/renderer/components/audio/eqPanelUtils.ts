import type { ChannelBalanceState } from '../../../shared/types/audio';
import {
  channelBalanceMaxBalance,
  channelBalanceMaxGainDb,
  channelBalanceMinBalance,
  channelBalanceMinGainDb,
} from '../../../shared/types/audio';
import type { EqBand, EqState } from '../../../shared/types/eq';
import {
  eqFrequenciesHz,
  eqMaxFrequencyHz,
  eqMaxGainDb,
  eqMaxPreampDb,
  eqMinFrequencyHz,
  eqMinGainDb,
  eqMinPreampDb,
} from '../../../shared/types/eq';

export type EqCurvePoint = {
  x: number;
  y: number;
};

const curveMinFrequencyHz = 20;
const curveMaxFrequencyHz = 20000;

export const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

export const formatDb = (value: number): string => `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`;

export const formatFrequencyLabel = (frequencyHz: number): string => {
  if (frequencyHz >= 1000) {
    const khz = frequencyHz / 1000;
    return `${Number.isInteger(khz) ? khz : khz.toFixed(1)}k`;
  }

  return String(frequencyHz);
};

export const computeRecommendedPreamp = (eqState: Pick<EqState, 'bands'>): number => {
  const maxBandGainDb = computeMaxBandGainDb(eqState.bands);
  return maxBandGainDb === 0 ? 0 : clamp(-maxBandGainDb, eqMinPreampDb, 0);
};

export const computeMaxBandGainDb = (bands: EqBand[]): number =>
  Math.max(0, ...bands.map((band) => (band.enabled === false ? 0 : band.gainDb)));

export const computeEstimatedPeakGain = (eqState: Pick<EqState, 'preampDb' | 'bands'>): number =>
  Math.round((eqState.preampDb + computeMaxBandGainDb(eqState.bands)) * 10) / 10;

export const computeLoudnessMatchedPreamp = (
  source: Pick<EqState, 'preampDb' | 'bands'>,
  target: Pick<EqState, 'preampDb' | 'bands'>,
): number => {
  const desiredPeakGain = computeEstimatedPeakGain(source);
  const targetMaxBandGain = computeMaxBandGainDb(target.bands);
  return Math.round(clamp(desiredPeakGain - targetMaxBandGain, eqMinPreampDb, eqMaxPreampDb) * 10) / 10;
};

export const snapBandFrequency = (frequencyHz: number): number => {
  const safeFrequencyHz = clamp(frequencyHz, eqMinFrequencyHz, eqMaxFrequencyHz);
  return eqFrequenciesHz.reduce((nearest, candidate) => {
    const currentDistance = Math.abs(Math.log2(safeFrequencyHz / nearest));
    const nextDistance = Math.abs(Math.log2(safeFrequencyHz / candidate));
    return nextDistance < currentDistance ? candidate : nearest;
  }, eqFrequenciesHz[0]);
};

export const resolveBandFrequency = (frequencyHz: number, unlocked: boolean): number => {
  const safeFrequencyHz = clamp(frequencyHz, eqMinFrequencyHz, eqMaxFrequencyHz);
  return unlocked ? Math.round(safeFrequencyHz) : snapBandFrequency(safeFrequencyHz);
};

export type EqSnapshot = {
  preampDb: number;
  bands: EqBand[];
  presetId: string;
  presetName: string;
  clippingRisk: boolean;
};

export const captureEqSnapshot = (state: Pick<EqState, 'preampDb' | 'bands'> & Partial<Pick<EqState, 'presetId' | 'presetName' | 'clippingRisk'>>): EqSnapshot => ({
  preampDb: state.preampDb,
  bands: state.bands.map((band) => ({ ...band })),
  presetId: state.presetId ?? 'custom',
  presetName: state.presetName ?? 'Custom',
  clippingRisk: Boolean(state.clippingRisk),
});

export const createEqHistorySnapshot = captureEqSnapshot;

export type PresetCategory = 'target' | 'genre' | 'utility' | 'user';

export type PresetMetadata = {
  category: PresetCategory;
  targetTypeKey: string;
  purposeKey: string;
  scenarioKey: string;
  cautionKey: string;
  approximation: boolean;
};

const targetMetadata = (targetTypeKey: string): PresetMetadata => ({
  category: 'target',
  targetTypeKey,
  purposeKey: 'settings.eq.preset.meta.targetPurpose',
  scenarioKey: 'settings.eq.preset.meta.targetScenario',
  cautionKey: 'settings.eq.preset.meta.approximationCaution',
  approximation: true,
});

const genreMetadata = (targetTypeKey: string): PresetMetadata => ({
  category: 'genre',
  targetTypeKey,
  purposeKey: 'settings.eq.preset.meta.genrePurpose',
  scenarioKey: 'settings.eq.preset.meta.genreScenario',
  cautionKey: 'settings.eq.preset.meta.tasteCaution',
  approximation: false,
});

const utilityMetadata = (targetTypeKey: string): PresetMetadata => ({
  category: 'utility',
  targetTypeKey,
  purposeKey: 'settings.eq.preset.meta.utilityPurpose',
  scenarioKey: 'settings.eq.preset.meta.utilityScenario',
  cautionKey: 'settings.eq.preset.meta.utilityCaution',
  approximation: false,
});

const presetMetadataMap: Record<string, PresetMetadata> = {
  flat: utilityMetadata('settings.eq.preset.meta.type.flat'),
  'bass-boost': genreMetadata('settings.eq.preset.meta.type.bassBoost'),
  'vocal-clear': utilityMetadata('settings.eq.preset.meta.type.vocalClear'),
  'treble-sparkle': genreMetadata('settings.eq.preset.meta.type.trebleSparkle'),
  loudness: utilityMetadata('settings.eq.preset.meta.type.loudness'),
  night: utilityMetadata('settings.eq.preset.meta.type.night'),
  'headphone-warm': genreMetadata('settings.eq.preset.meta.type.headphoneWarm'),
  'anime-jpop': genreMetadata('settings.eq.preset.meta.type.animeJpop'),
  rock: genreMetadata('settings.eq.preset.meta.type.rock'),
  classical: genreMetadata('settings.eq.preset.meta.type.classical'),
  'harman-target': targetMetadata('settings.eq.preset.meta.type.harmanTarget'),
  'harman-in-ear': targetMetadata('settings.eq.preset.meta.type.harmanInEar'),
  'diffuse-field': targetMetadata('settings.eq.preset.meta.type.diffuseField'),
  'bk-room-curve': targetMetadata('settings.eq.preset.meta.type.bkRoomCurve'),
  'studio-neutral': utilityMetadata('settings.eq.preset.meta.type.studioNeutral'),
  'classic-smiley': genreMetadata('settings.eq.preset.meta.type.classicSmiley'),
  'vinyl-warmth': genreMetadata('settings.eq.preset.meta.type.vinylWarmth'),
  'broadcast-voice': utilityMetadata('settings.eq.preset.meta.type.broadcastVoice'),
};

export const describePreset = (presetId: string): PresetMetadata | null => presetMetadataMap[presetId] ?? null;

const gainToDb = (gain: number): number => (gain > 0 ? 20 * Math.log10(gain) : -Infinity);

export const computeEffectiveChannelGains = (
  channelBalance: Pick<ChannelBalanceState, 'balance' | 'leftGainDb' | 'rightGainDb' | 'constantPower'>,
): { leftDb: number; rightDb: number } => {
  const safeBalance = clamp(channelBalance.balance, channelBalanceMinBalance, channelBalanceMaxBalance);

  if (!channelBalance.constantPower) {
    return {
      leftDb: channelBalance.leftGainDb + gainToDb(safeBalance > 0 ? 1 - safeBalance : 1),
      rightDb: channelBalance.rightGainDb + gainToDb(safeBalance < 0 ? 1 + safeBalance : 1),
    };
  }

  const pan = (safeBalance + 1) * Math.PI * 0.25;
  const compensation = Math.sqrt(2);
  return {
    leftDb: channelBalance.leftGainDb + gainToDb(Math.min(1, Math.cos(pan) * compensation)),
    rightDb: channelBalance.rightGainDb + gainToDb(Math.min(1, Math.sin(pan) * compensation)),
  };
};

const gainToCurveY = (gainDb: number): number => {
  const normalized = (clamp(gainDb, eqMinGainDb, eqMaxGainDb) - eqMinGainDb) / (eqMaxGainDb - eqMinGainDb);
  return clamp(1 - normalized, 0, 1);
};

const frequencyToCurveX = (frequencyHz: number): number => {
  const minLog = Math.log10(curveMinFrequencyHz);
  const maxLog = Math.log10(curveMaxFrequencyHz);
  const currentLog = Math.log10(clamp(frequencyHz, curveMinFrequencyHz, curveMaxFrequencyHz));
  return clamp((currentLog - minLog) / (maxLog - minLog), 0, 1);
};

export const computeEqCurvePoints = (bands: EqBand[]): EqCurvePoint[] =>
  bands
    .map((band) => ({
      x: frequencyToCurveX(band.frequencyHz),
      y: gainToCurveY(band.enabled === false ? 0 : band.gainDb),
    }))
    .sort((a, b) => a.x - b.x);

export const clampChannelBalancePatch = (patch: Partial<ChannelBalanceState>): Partial<ChannelBalanceState> => {
  const nextPatch = { ...patch };

  if (typeof nextPatch.balance === 'number') {
    nextPatch.balance = clamp(nextPatch.balance, channelBalanceMinBalance, channelBalanceMaxBalance);
  }

  if (typeof nextPatch.leftGainDb === 'number') {
    nextPatch.leftGainDb = clamp(nextPatch.leftGainDb, channelBalanceMinGainDb, channelBalanceMaxGainDb);
  }

  if (typeof nextPatch.rightGainDb === 'number') {
    nextPatch.rightGainDb = clamp(nextPatch.rightGainDb, channelBalanceMinGainDb, channelBalanceMaxGainDb);
  }

  return nextPatch;
};
