export const eqFrequenciesHz = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;

export const eqBandCount = eqFrequenciesHz.length;
export const eqMinGainDb = -12;
export const eqMaxGainDb = 12;
export const eqMinPreampDb = -12;
export const eqMaxPreampDb = 6;

export type EqBand = {
  frequencyHz: number;
  gainDb: number;
  q: number;
};

export type EqState = {
  enabled: boolean;
  preampDb: number;
  bands: EqBand[];
  presetId: string;
  presetName: string;
  clippingRisk: boolean;
};

export type EqPreset = {
  id: string;
  name: string;
  preampDb: number;
  bands: EqBand[];
  createdAt: string;
  updatedAt: string;
  readonly: boolean;
};

export type EqSetBandGainRequest = {
  band: number;
  gainDb: number;
};

export type EqSavePresetRequest = {
  id?: string;
  name: string;
  preampDb: number;
  bands: EqBand[];
};
