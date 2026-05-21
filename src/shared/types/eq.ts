export const eqFrequenciesHz = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;

export const eqBandCount = eqFrequenciesHz.length;
export const eqMinGainDb = -12;
export const eqMaxGainDb = 12;
export const eqMinPreampDb = -12;
export const eqMaxPreampDb = 6;
export const eqMinFrequencyHz = 20;
export const eqMaxFrequencyHz = 20000;
export const eqMinQ = 0.1;
export const eqMaxQ = 12;

export const eqFilterTypes = ['peaking', 'lowShelf', 'highShelf'] as const;

export type EqFilterType = (typeof eqFilterTypes)[number];

export type EqBand = {
  frequencyHz: number;
  gainDb: number;
  q: number;
  filterType?: EqFilterType;
  enabled?: boolean;
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

export type EqSetBandFrequencyRequest = {
  band: number;
  frequencyHz: number;
};

export type EqSetBandQRequest = {
  band: number;
  q: number;
};

export type EqSetBandFilterTypeRequest = {
  band: number;
  filterType: EqFilterType;
};

export type EqSetBandEnabledRequest = {
  band: number;
  enabled: boolean;
};

export type EqSavePresetRequest = {
  id?: string;
  name: string;
  preampDb: number;
  bands: EqBand[];
};

export type EqProfileBindingTarget = {
  outputMode?: string | null;
  outputDeviceId?: string | null;
  outputDeviceName?: string | null;
  outputDeviceType?: string | null;
  outputBackend?: string | null;
  sharedBackend?: string | null;
  deviceIndex?: number | null;
  deviceName?: string | null;
};

export type EqProfileBinding = {
  key: string;
  label: string;
  outputMode: string;
  createdAt: string;
};

export type EqProfile = {
  id: string;
  name: string;
  state: EqState;
  bindings: EqProfileBinding[];
  createdAt: string;
  updatedAt: string;
};

export type EqSaveProfileRequest = {
  id?: string;
  name: string;
  state: EqState;
};

export type EqBindProfileRequest = {
  profileId: string;
  target: EqProfileBindingTarget;
};

export type EqProfileBindingInfo = {
  key: string;
  label: string;
  profileId: string;
  profileName: string;
} | null;
