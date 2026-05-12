import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import electron from 'electron';
import type { EqBand, EqPreset, EqSavePresetRequest, EqSetBandGainRequest, EqState } from '../../shared/types/eq';
import {
  eqBandCount,
  eqFrequenciesHz,
  eqMaxGainDb,
  eqMaxPreampDb,
  eqMinGainDb,
  eqMinPreampDb,
} from '../../shared/types/eq';

type PendingRequest = {
  resolve: (state: EqState) => void;
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

const builtInPresets: EqPreset[] = [
  { id: 'flat', name: 'Flat', preampDb: 0, bands: createBands(), createdAt: 'built-in', updatedAt: 'built-in', readonly: true },
  { id: 'bass-boost', name: 'Bass Boost', preampDb: -2, bands: createBands([4, 3.5, 2.5, 1, 0, 0, 0, -0.5, -1, -1]), createdAt: 'built-in', updatedAt: 'built-in', readonly: true },
  { id: 'vocal-clear', name: 'Vocal Clear', preampDb: -1.5, bands: createBands([-2, -1.5, -1, 0.5, 1.5, 2.5, 2, 1, 0, -0.5]), createdAt: 'built-in', updatedAt: 'built-in', readonly: true },
  { id: 'treble-sparkle', name: 'Treble Sparkle', preampDb: -2, bands: createBands([-1, -0.8, -0.5, 0, 0, 0.5, 1.2, 2.4, 3.4, 3]), createdAt: 'built-in', updatedAt: 'built-in', readonly: true },
  { id: 'loudness', name: 'Loudness', preampDb: -4, bands: createBands([4, 3.5, 2, 0.5, -0.5, -0.5, 0.3, 1.5, 2.2, 2.4]), createdAt: 'built-in', updatedAt: 'built-in', readonly: true },
  { id: 'night', name: 'Night', preampDb: -4, bands: createBands([-2, -2, -1.5, -0.5, 0, 1, 0.8, -0.5, -2, -3]), createdAt: 'built-in', updatedAt: 'built-in', readonly: true },
  { id: 'headphone-warm', name: 'Headphone Warm', preampDb: -2, bands: createBands([1.5, 2, 2, 1.2, 0.4, 0, -0.4, -0.8, -1, -1.2]), createdAt: 'built-in', updatedAt: 'built-in', readonly: true },
  { id: 'anime-jpop', name: 'Anime / J-Pop', preampDb: -3, bands: createBands([1.5, 1.2, 0.6, -0.5, -0.8, 0.8, 2, 2.6, 2.2, 1]), createdAt: 'built-in', updatedAt: 'built-in', readonly: true },
  { id: 'rock', name: 'Rock', preampDb: -3, bands: createBands([2.5, 2, 1, -0.5, -1, 0, 1.2, 2.3, 2, 1.2]), createdAt: 'built-in', updatedAt: 'built-in', readonly: true },
  { id: 'classical', name: 'Classical', preampDb: -1, bands: createBands([0.5, 0.5, 0, 0, -0.3, -0.2, 0.4, 1, 1.2, 0.8]), createdAt: 'built-in', updatedAt: 'built-in', readonly: true },
];

const defaultState = (): EqState => ({
  enabled: false,
  preampDb: 0,
  bands: createBands(),
  presetId: 'flat',
  presetName: 'Flat',
  clippingRisk: false,
});

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
    const gainDb = Number(input?.gainDb ?? 0);
    const q = Number(input?.q ?? 1);

    if (!Number.isFinite(gainDb) || !Number.isFinite(q) || q <= 0 || q > 12) {
      return null;
    }

    nextBands.push({
      frequencyHz: eqFrequenciesHz[index],
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
  private socket: net.Socket | null = null;
  private pending: PendingRequest[] = [];
  private receiveBuffer = '';
  private readonly presetPath: string;

  constructor(userDataPath = getUserDataPath()) {
    super();
    this.presetPath = join(userDataPath, 'eq-presets.json');
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

    const socket = net.createConnection({ host: '127.0.0.1', port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on('connect', () => {
      void this.syncStateToNative().catch((error: unknown) => {
        this.emit('error', error instanceof Error ? error : new Error(String(error)));
      });
    });
    socket.on('data', (chunk) => this.handleData(chunk));
    socket.on('error', (error) => {
      this.rejectPending(error);
      this.emit('error', error);
    });
    socket.on('close', () => {
      if (this.socket === socket) {
        this.socket = null;
      }
      this.rejectPending(new Error('eq_control_closed'));
    });
  }

  disconnect(): void {
    const socket = this.socket;
    this.socket = null;

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

  listPresets(): EqPreset[] {
    return [...builtInPresets, ...this.readUserPresets()].map((preset) => ({
      ...preset,
      bands: preset.bands.map((band) => ({ ...band })),
    }));
  }

  async setEnabled(enabled: boolean): Promise<EqState> {
    this.state = { ...this.state, enabled };
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
    await this.sendNative({ type: 'eq:set-band-gain', band: request.band, gainDb });
    return this.emitState();
  }

  async setPreamp(preampDb: number): Promise<EqState> {
    const safePreampDb = clamp(Number(preampDb), eqMinPreampDb, eqMaxPreampDb);
    this.state = { ...this.state, preampDb: safePreampDb, presetId: 'custom', presetName: 'Custom' };
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
    await this.sendNative({ type: 'eq:reset' });
    return this.emitState();
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

  private async syncStateToNative(): Promise<void> {
    await this.sendNative({ type: 'eq:set-enabled', enabled: this.state.enabled });
    await this.sendNative({ type: 'eq:set-preset', preampDb: this.state.preampDb, bands: this.state.bands });
  }

  private async sendNative(message: Record<string, unknown>): Promise<EqState> {
    const socket = this.socket;

    if (!socket || socket.destroyed || !socket.writable) {
      return this.getState();
    }

    return new Promise<EqState>((resolve, reject) => {
      this.pending.push({ resolve, reject });
      socket.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          const pending = this.pending.shift();
          pending?.reject(error);
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
      const message = JSON.parse(line) as Partial<EqState> & { type?: string; message?: string };

      if (message.type === 'eq:error') {
        pending?.reject(new Error(message.message ?? 'eq_native_error'));
        return;
      }

      if (message.type === 'eq:state') {
        this.state = {
          ...this.state,
          enabled: Boolean(message.enabled),
          preampDb: clamp(Number(message.preampDb ?? this.state.preampDb), eqMinPreampDb, eqMaxPreampDb),
          bands: validateBands(message.bands) ?? this.state.bands,
          clippingRisk: Boolean(message.clippingRisk),
        };
        this.emitState();
      }

      pending?.resolve(this.getState());
    } catch (error) {
      pending?.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private emitState(): EqState {
    const state = this.getState();
    this.emit('state', state);
    return state;
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
}

let defaultEqBridge: EqBridge | null = null;

export const getEqBridge = (): EqBridge => {
  if (!defaultEqBridge) {
    defaultEqBridge = new EqBridge();
    defaultEqBridge.setMaxListeners(64);
  }
  return defaultEqBridge;
};
