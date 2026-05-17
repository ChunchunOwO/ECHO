import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import electron from 'electron';
import type { ChannelBalanceMonoMode, ChannelBalanceState } from '../../shared/types/audio';
import {
  channelBalanceMaxBalance,
  channelBalanceMaxGainDb,
  channelBalanceMinBalance,
  channelBalanceMinGainDb,
} from '../../shared/types/audio';
import type { EqBand, EqPreset, EqSavePresetRequest, EqSetBandFrequencyRequest, EqSetBandGainRequest, EqState } from '../../shared/types/eq';
import {
  eqBandCount,
  eqFrequenciesHz,
  eqMaxFrequencyHz,
  eqMaxGainDb,
  eqMaxPreampDb,
  eqMinFrequencyHz,
  eqMinGainDb,
  eqMinPreampDb,
} from '../../shared/types/eq';
import { defaultChannelBalanceSettings, getAppSettings, setAppSettings } from '../app/appSettings';

type PendingRequest = {
  resolve: (state: EqState | ChannelBalanceState) => void;
  reject: (error: Error) => void;
};

const controlPortBase = 45210;
let nextControlPort = controlPortBase;

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const nowIso = (): string => new Date().toISOString();

const createBands = (gains: number[] = []): EqBand[] =>
  eqFrequenciesHz.map((frequencyHz, index) => ({
    frequencyHz,
    gainDb: clamp(Number(gains[index] ?? 0), eqMinGainDb, eqMaxGainDb),
    q: 1,
  }));

type BuiltInPresetDefinition = {
  id: string;
  name: string;
  preampDb: number;
  gains: number[];
};

const builtInPresetDefinitions: BuiltInPresetDefinition[] = [
  { id: 'flat', name: 'Flat', preampDb: 0, gains: [] },
  { id: 'bass-boost', name: 'Bass Boost', preampDb: -8, gains: [7.5, 6.8, 5, 2.3, 0.5, -0.4, -1, -1.6, -2.2, -2.8] },
  { id: 'vocal-clear', name: 'Vocal Clear', preampDb: -6, gains: [-6, -5, -3, 0.5, 2.8, 4.5, 3.8, 2, -0.8, -2.8] },
  { id: 'treble-sparkle', name: 'Treble Sparkle', preampDb: -7, gains: [-3, -2.5, -1.8, -0.8, 0, 0.8, 2.8, 4.8, 6.2, 5.5] },
  { id: 'loudness', name: 'Loudness', preampDb: -8, gains: [7.5, 6.8, 4.4, 1.2, -1.6, -1.8, 0.6, 2.8, 4.6, 5.2] },
  { id: 'night', name: 'Night', preampDb: -2, gains: [-6.5, -5.8, -3.6, -1.2, 0, 1.2, 0.6, -1.8, -4.5, -6.5] },
  { id: 'headphone-warm', name: 'Headphone Warm', preampDb: -6, gains: [5, 5.3, 4, 2, 0.5, -0.4, -1.1, -1.8, -2.6, -3.5] },
  { id: 'anime-jpop', name: 'Anime / J-Pop', preampDb: -6, gains: [3, 2.3, 0.5, -1.8, -2.2, 1.2, 3.8, 5.5, 4.6, 2.2] },
  { id: 'rock', name: 'Rock', preampDb: -6, gains: [5.5, 4.6, 1.8, -2, -3, -0.6, 2.2, 4.5, 3.8, 2] },
  { id: 'classical', name: 'Classical', preampDb: -4, gains: [1.8, 1.4, 0.3, -0.4, -1, -0.5, 1, 2.8, 3.5, 2.2] },
  { id: 'harman-target', name: 'Harman Target', preampDb: -6, gains: [6, 5.8, 4.5, 2, 0.5, 0, 2.5, 3.5, 2, 0.5] },
  { id: 'harman-in-ear', name: 'Harman In-Ear', preampDb: -8, gains: [8, 7, 5.5, 2.5, 0, -0.5, 2.5, 4, 3, 1.5] },
  { id: 'diffuse-field', name: 'Diffuse Field', preampDb: -7, gains: [-5.5, -4.8, -2.8, -0.8, 0.6, 2, 5.5, 6.2, 3.8, 0.8] },
  { id: 'bk-room-curve', name: 'B&K Room Curve', preampDb: -6, gains: [5.5, 4.8, 3.4, 1.7, 0.5, -0.8, -2, -3.2, -4.4, -5.4] },
  { id: 'studio-neutral', name: 'Studio Neutral', preampDb: -2, gains: [-1.5, -1.8, -1, -0.2, 0.2, 1.1, 2, 1.6, 0.2, -1.2] },
  { id: 'classic-smiley', name: 'Classic Smiley', preampDb: -8, gains: [7, 6, 3, -2.8, -4.5, -3.2, 1, 4, 6.2, 7] },
  { id: 'vinyl-warmth', name: 'Vinyl Warmth', preampDb: -6, gains: [5, 4.4, 2.8, 1, 0, -0.7, -1.6, -2.8, -4, -5.2] },
  { id: 'broadcast-voice', name: 'Broadcast Voice', preampDb: -6, gains: [-8, -6.5, -3.4, 1.5, 4, 5.5, 4.4, 1.5, -2.5, -5.5] },
];

const builtInPresets: EqPreset[] = builtInPresetDefinitions.map((preset) => ({
  id: preset.id,
  name: preset.name,
  preampDb: preset.preampDb,
  bands: createBands(preset.gains),
  createdAt: 'built-in',
  updatedAt: 'built-in',
  readonly: true,
}));

const defaultState = (): EqState => ({
  enabled: false,
  preampDb: 0,
  bands: createBands(),
  presetId: 'flat',
  presetName: 'Flat',
  clippingRisk: false,
});

const normalizeState = (value: unknown): EqState | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const input = value as Partial<EqState>;
  const preampDb = Number(input.preampDb ?? 0);
  const bands = validateBands(input.bands);

  if (!Number.isFinite(preampDb) || !bands) {
    return null;
  }

  return {
    enabled: input.enabled === true,
    preampDb: clamp(preampDb, eqMinPreampDb, eqMaxPreampDb),
    bands,
    presetId: typeof input.presetId === 'string' && input.presetId.trim() ? input.presetId.trim().slice(0, 64) : 'flat',
    presetName: typeof input.presetName === 'string' && input.presetName.trim() ? input.presetName.trim().slice(0, 64) : 'Flat',
    clippingRisk: false,
  };
};

const monoModes = new Set<ChannelBalanceMonoMode>(['off', 'sum', 'left', 'right']);

const defaultChannelBalanceState = (): ChannelBalanceState => ({
  ...defaultChannelBalanceSettings,
  clippingRisk: false,
});

const normalizeChannelBalancePatch = (
  patch: Partial<ChannelBalanceState>,
  fallback: ChannelBalanceState,
): ChannelBalanceState => {
  const balance = Number(patch.balance ?? fallback.balance);
  const leftGainDb = Number(patch.leftGainDb ?? fallback.leftGainDb);
  const rightGainDb = Number(patch.rightGainDb ?? fallback.rightGainDb);
  const monoMode = typeof patch.monoMode === 'string' && monoModes.has(patch.monoMode) ? patch.monoMode : fallback.monoMode;

  return {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : fallback.enabled,
    balance: Number.isFinite(balance) ? clamp(balance, channelBalanceMinBalance, channelBalanceMaxBalance) : fallback.balance,
    leftGainDb: Number.isFinite(leftGainDb) ? clamp(leftGainDb, channelBalanceMinGainDb, channelBalanceMaxGainDb) : fallback.leftGainDb,
    rightGainDb: Number.isFinite(rightGainDb) ? clamp(rightGainDb, channelBalanceMinGainDb, channelBalanceMaxGainDb) : fallback.rightGainDb,
    swapLeftRight: typeof patch.swapLeftRight === 'boolean' ? patch.swapLeftRight : fallback.swapLeftRight,
    monoMode,
    invertLeft: typeof patch.invertLeft === 'boolean' ? patch.invertLeft : fallback.invertLeft,
    invertRight: typeof patch.invertRight === 'boolean' ? patch.invertRight : fallback.invertRight,
    constantPower: typeof patch.constantPower === 'boolean' ? patch.constantPower : fallback.constantPower,
    clippingRisk: typeof patch.clippingRisk === 'boolean' ? patch.clippingRisk : fallback.clippingRisk,
  };
};

const getUserDataPath = (): string => {
  const app = (electron as unknown as { app?: { getPath: (name: string) => string } }).app;

  try {
    return app?.getPath('userData') ?? process.cwd();
  } catch {
    return process.cwd();
  }
};

const sanitizePresetId = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || `preset-${Date.now()}`;

const validateBands = (bands: unknown): EqBand[] | null => {
  if (!Array.isArray(bands) || bands.length !== eqBandCount) {
    return null;
  }

  const nextBands: EqBand[] = [];

  for (let index = 0; index < eqBandCount; index += 1) {
    const input = bands[index] as Partial<EqBand> | null;
    const frequencyHz = Number(input?.frequencyHz ?? eqFrequenciesHz[index]);
    const gainDb = Number(input?.gainDb ?? 0);
    const q = Number(input?.q ?? 1);

    if (
      !Number.isFinite(frequencyHz) ||
      frequencyHz < eqMinFrequencyHz ||
      frequencyHz > eqMaxFrequencyHz ||
      !Number.isFinite(gainDb) ||
      !Number.isFinite(q) ||
      q <= 0 ||
      q > 12
    ) {
      return null;
    }

    nextBands.push({
      frequencyHz,
      gainDb: clamp(gainDb, eqMinGainDb, eqMaxGainDb),
      q,
    });
  }

  return nextBands;
};

const normalizePreset = (value: unknown, readonlyFallback = false): EqPreset | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const input = value as Partial<EqPreset>;
  const id = typeof input.id === 'string' && input.id.trim() ? sanitizePresetId(input.id) : null;
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 64) : null;
  const preampDb = Number(input.preampDb ?? 0);
  const bands = validateBands(input.bands);

  if (!id || !name || !Number.isFinite(preampDb) || !bands) {
    return null;
  }

  return {
    id,
    name,
    preampDb: clamp(preampDb, eqMinPreampDb, eqMaxPreampDb),
    bands,
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : nowIso(),
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : nowIso(),
    readonly: input.readonly ?? readonlyFallback,
  };
};

export class EqBridge extends EventEmitter {
  private state: EqState = defaultState();
  private channelBalanceState: ChannelBalanceState = defaultChannelBalanceState();
  private socket: net.Socket | null = null;
  private activeControlPort: number | null = null;
  private nativeSyncTargetEqState: EqState | null = null;
  private pending: PendingRequest[] = [];
  private receiveBuffer = '';
  private readonly presetPath: string;
  private readonly statePath: string;

  constructor(userDataPath = getUserDataPath()) {
    super();
    this.presetPath = join(userDataPath, 'eq-presets.json');
    this.statePath = join(userDataPath, 'eq-state.json');
    this.state = this.readPersistedState();
    try {
      this.channelBalanceState = normalizeChannelBalancePatch(getAppSettings().channelBalance, defaultChannelBalanceState());
    } catch {
      this.channelBalanceState = defaultChannelBalanceState();
    }
    this.on('error', () => undefined);
  }

  reserveControlPort(): number {
    const port = nextControlPort;
    nextControlPort += 1;

    if (nextControlPort > controlPortBase + 900) {
      nextControlPort = controlPortBase;
    }

    return port;
  }

  connect(port: number): void {
    this.disconnect();

    if (!port || port <= 0) {
      return;
    }

    const socket = net.createConnection({ host: '127.0.0.1', port, timeout: 5000 });
    this.socket = socket;
    this.activeControlPort = port;
    socket.setNoDelay(true);
    socket.on('connect', () => {
      if (this.socket !== socket) {
        return;
      }

      socket.setTimeout(0);
      socket.setKeepAlive(true, 30000);
      void this.syncStateToNative().catch((error: unknown) => {
        this.emit('error', error instanceof Error ? error : new Error(String(error)));
      });
    });
    socket.on('timeout', () => {
      socket.destroy(new Error('eq_control_connection_timeout'));
    });
    socket.on('data', (chunk) => this.handleData(chunk));
    socket.on('error', (error) => {
      if (this.socket !== socket) {
        return;
      }

      this.rejectPending(error);
      this.emit('error', error);
    });
    socket.on('close', () => {
      if (this.socket !== socket) {
        return;
      }

      this.socket = null;
      this.activeControlPort = null;
      this.rejectPending(new Error('eq_control_closed'));
    });
  }

  disconnect(expectedPort?: number | null): void {
    if (expectedPort && this.activeControlPort !== expectedPort) {
      return;
    }

    const socket = this.socket;
    this.socket = null;
    this.activeControlPort = null;

    if (socket) {
      socket.destroy();
    }

    this.rejectPending(new Error('eq_control_disconnected'));
  }

  getState(): EqState {
    return {
      ...this.state,
      bands: this.state.bands.map((band) => ({ ...band })),
    };
  }

  getChannelBalanceState(): ChannelBalanceState {
    return { ...this.channelBalanceState };
  }

  listPresets(): EqPreset[] {
    return [...builtInPresets, ...this.readUserPresets()].map((preset) => ({
      ...preset,
      bands: preset.bands.map((band) => ({ ...band })),
    }));
  }

  async setEnabled(enabled: boolean): Promise<EqState> {
    this.state = { ...this.state, enabled };
    this.persistState();
    await this.sendNative({ type: 'eq:set-enabled', enabled });
    return this.emitState();
  }

  async setBandGain(request: EqSetBandGainRequest): Promise<EqState> {
    if (!Number.isInteger(request.band) || request.band < 0 || request.band >= eqBandCount) {
      throw new Error('invalid_eq_band_index');
    }

    const gainDb = clamp(Number(request.gainDb), eqMinGainDb, eqMaxGainDb);
    const bands = this.state.bands.map((band, index) => (index === request.band ? { ...band, gainDb } : band));
    this.state = { ...this.state, bands, presetId: 'custom', presetName: 'Custom' };
    this.persistState();
    await this.sendNative({ type: 'eq:set-band-gain', band: request.band, gainDb });
    return this.emitState();
  }

  async setBandFrequency(request: EqSetBandFrequencyRequest): Promise<EqState> {
    if (!Number.isInteger(request.band) || request.band < 0 || request.band >= eqBandCount) {
      throw new Error('invalid_eq_band_index');
    }

    const frequencyHz = clamp(Number(request.frequencyHz), eqMinFrequencyHz, eqMaxFrequencyHz);

    if (!Number.isFinite(frequencyHz)) {
      throw new Error('invalid_eq_band_frequency');
    }

    const bands = this.state.bands.map((band, index) => (index === request.band ? { ...band, frequencyHz } : band));
    this.state = { ...this.state, bands, presetId: 'custom', presetName: 'Custom' };
    this.persistState();
    await this.sendNative({ type: 'eq:set-band-frequency', band: request.band, frequencyHz });
    return this.emitState();
  }

  async setPreamp(preampDb: number): Promise<EqState> {
    const safePreampDb = clamp(Number(preampDb), eqMinPreampDb, eqMaxPreampDb);
    this.state = { ...this.state, preampDb: safePreampDb, presetId: 'custom', presetName: 'Custom' };
    this.persistState();
    await this.sendNative({ type: 'eq:set-preamp', preampDb: safePreampDb });
    return this.emitState();
  }

  async setPreset(presetId: string): Promise<EqState> {
    const preset = this.listPresets().find((item) => item.id === presetId);

    if (!preset) {
      throw new Error('eq_preset_not_found');
    }

    this.state = {
      enabled: this.state.enabled,
      preampDb: preset.preampDb,
      bands: preset.bands.map((band) => ({ ...band })),
      presetId: preset.id,
      presetName: preset.name,
      clippingRisk: false,
    };
    this.persistState();
    await this.sendNative({ type: 'eq:set-preset', preampDb: preset.preampDb, bands: preset.bands });
    return this.emitState();
  }

  async reset(): Promise<EqState> {
    const flat = builtInPresets[0];
    this.state = {
      enabled: this.state.enabled,
      preampDb: flat.preampDb,
      bands: flat.bands.map((band) => ({ ...band })),
      presetId: flat.id,
      presetName: flat.name,
      clippingRisk: false,
    };
    this.persistState();
    await this.sendNative({ type: 'eq:set-preset', preampDb: flat.preampDb, bands: flat.bands });
    return this.emitState();
  }

  async setChannelBalanceState(patch: Partial<ChannelBalanceState>): Promise<ChannelBalanceState> {
    this.channelBalanceState = normalizeChannelBalancePatch(patch, this.channelBalanceState);
    this.persistChannelBalanceState();
    await this.sendNativeChannelBalance({ type: 'channelBalance.setState', state: this.channelBalanceState });
    return this.emitChannelBalanceState();
  }

  async resetChannelBalance(): Promise<ChannelBalanceState> {
    this.channelBalanceState = defaultChannelBalanceState();
    this.persistChannelBalanceState();
    await this.sendNativeChannelBalance({ type: 'channelBalance.reset' });
    return this.emitChannelBalanceState();
  }

  savePreset(request: EqSavePresetRequest): EqPreset {
    const normalized = normalizePreset({
      id: request.id ?? sanitizePresetId(request.name),
      name: request.name,
      preampDb: request.preampDb,
      bands: request.bands,
      readonly: false,
    });

    if (!normalized) {
      throw new Error('invalid_eq_preset');
    }

    const presets = this.readUserPresets();
    const existingIndex = presets.findIndex((preset) => preset.id === normalized.id);
    const existing = existingIndex >= 0 ? presets[existingIndex] : null;
    const preset: EqPreset = {
      ...normalized,
      createdAt: existing?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
      readonly: false,
    };

    if (builtInPresets.some((item) => item.id === preset.id)) {
      throw new Error('cannot_overwrite_builtin_eq_preset');
    }

    if (existingIndex >= 0) {
      presets[existingIndex] = preset;
    } else {
      presets.push(preset);
    }

    this.writeUserPresets(presets);
    this.state = {
      ...this.state,
      preampDb: preset.preampDb,
      bands: preset.bands.map((band) => ({ ...band })),
      presetId: preset.id,
      presetName: preset.name,
      clippingRisk: false,
    };
    this.persistState();
    this.emitState();
    return preset;
  }

  deletePreset(presetId: string): EqPreset[] {
    if (builtInPresets.some((preset) => preset.id === presetId)) {
      throw new Error('cannot_delete_builtin_eq_preset');
    }

    const presets = this.readUserPresets().filter((preset) => preset.id !== presetId);
    this.writeUserPresets(presets);
    return this.listPresets();
  }

  async syncStateToNative(): Promise<void> {
    const eqState = this.getState();
    const channelBalanceState = this.getChannelBalanceState();

    this.nativeSyncTargetEqState = eqState;
    try {
      await this.sendNative({ type: 'eq:set-enabled', enabled: eqState.enabled });
      await this.sendNative({ type: 'eq:set-preset', preampDb: eqState.preampDb, bands: eqState.bands });
    } finally {
      this.nativeSyncTargetEqState = null;
      this.state = eqState;
      this.emitState();
    }

    await this.sendNativeChannelBalance({ type: 'channelBalance.setState', state: channelBalanceState });
  }

  private async sendNative(message: Record<string, unknown>): Promise<EqState> {
    const socket = this.socket;

    if (!socket || socket.destroyed || !socket.writable) {
      return this.getState();
    }

    return new Promise<EqState>((resolve, reject) => {
      this.pending.push({ resolve: (state) => resolve(state as EqState), reject });
      socket.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          this.rejectPending(error);
        }
      });
    });
  }

  private async sendNativeChannelBalance(message: Record<string, unknown>): Promise<ChannelBalanceState> {
    const socket = this.socket;

    if (!socket || socket.destroyed || !socket.writable) {
      return this.getChannelBalanceState();
    }

    return new Promise<ChannelBalanceState>((resolve, reject) => {
      this.pending.push({ resolve: (state) => resolve(state as ChannelBalanceState), reject });
      socket.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          this.rejectPending(error);
        }
      });
    });
  }

  private handleData(chunk: Buffer): void {
    this.receiveBuffer += chunk.toString('utf8');
    let newlineIndex = this.receiveBuffer.indexOf('\n');

    while (newlineIndex >= 0) {
      const line = this.receiveBuffer.slice(0, newlineIndex).trim();
      this.receiveBuffer = this.receiveBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.receiveBuffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    const pending = this.pending.shift();

    if (!line) {
      pending?.resolve(this.getState());
      return;
    }

    try {
      const message = JSON.parse(line) as Partial<EqState & ChannelBalanceState> & { type?: string; message?: string };

      if (message.type === 'eq:error') {
        pending?.reject(new Error(message.message ?? 'eq_native_error'));
        return;
      }

      if (message.type === 'eq:state') {
        const syncTarget = this.nativeSyncTargetEqState;
        this.state = syncTarget
          ? {
              ...syncTarget,
              clippingRisk: Boolean(message.clippingRisk),
            }
          : {
              ...this.state,
              enabled: Boolean(message.enabled),
              preampDb: clamp(Number(message.preampDb ?? this.state.preampDb), eqMinPreampDb, eqMaxPreampDb),
              bands: validateBands(message.bands) ?? this.state.bands,
              clippingRisk: Boolean(message.clippingRisk),
            };
        this.emitState();
      }

      if (message.type === 'channelBalance:state') {
        this.channelBalanceState = normalizeChannelBalancePatch(message, this.channelBalanceState);
        this.emitChannelBalanceState();
      }

      pending?.resolve(message.type === 'channelBalance:state' ? this.getChannelBalanceState() : this.getState());
    } catch (error) {
      pending?.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private emitState(): EqState {
    const state = this.getState();
    this.emit('state', state);
    return state;
  }

  private emitChannelBalanceState(): ChannelBalanceState {
    const state = this.getChannelBalanceState();
    this.emit('channelBalanceState', state);
    return state;
  }

  private persistChannelBalanceState(): void {
    try {
      setAppSettings({ channelBalance: this.channelBalanceState });
    } catch {
      // Tests and early startup can run without a ready Electron app path.
    }
  }

  private rejectPending(error: Error): void {
    const pending = this.pending;
    this.pending = [];
    pending.forEach((request) => request.reject(error));
  }

  private readUserPresets(): EqPreset[] {
    if (!existsSync(this.presetPath)) {
      return [];
    }

    try {
      const parsed = JSON.parse(readFileSync(this.presetPath, 'utf8')) as unknown;

      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed
        .map((item) => normalizePreset(item, false))
        .filter((preset): preset is EqPreset => Boolean(preset && !preset.readonly));
    } catch {
      return [];
    }
  }

  private writeUserPresets(presets: EqPreset[]): void {
    mkdirSync(dirname(this.presetPath), { recursive: true });
    writeFileSync(this.presetPath, JSON.stringify(presets, null, 2), 'utf8');
  }

  private readPersistedState(): EqState {
    if (!existsSync(this.statePath)) {
      return defaultState();
    }

    try {
      return normalizeState(JSON.parse(readFileSync(this.statePath, 'utf8'))) ?? defaultState();
    } catch {
      return defaultState();
    }
  }

  private persistState(): void {
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      writeFileSync(this.statePath, `${JSON.stringify(this.getState(), null, 2)}\n`, 'utf8');
    } catch {
      // Persistence is best-effort; audio controls should still work if the profile path is unavailable.
    }
  }
}

let defaultEqBridge: EqBridge | null = null;

export const getEqBridge = (): EqBridge => {
  if (!defaultEqBridge) {
    defaultEqBridge = new EqBridge();
    defaultEqBridge.setMaxListeners(64);
  }
  return defaultEqBridge;
};
