import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { EqBridge } from './EqBridge';

const tempDirs: string[] = [];

const createBridge = (): EqBridge => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-next-eq-'));
  tempDirs.push(dir);
  return new EqBridge(dir);
};

afterEach(() => {
  tempDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

describe('EqBridge protocol validation', () => {
  it('rejects invalid band indexes', async () => {
    const bridge = createBridge();

    await expect(bridge.setBandGain({ band: 99, gainDb: 2 })).rejects.toThrow('invalid_eq_band_index');
  });

  it('clamps gain and preamp ranges before updating state', async () => {
    const bridge = createBridge();

    await bridge.setBandGain({ band: 2, gainDb: 50 });
    await bridge.setPreamp(-40);

    const state = bridge.getState();
    expect(state.bands[2].gainDb).toBe(12);
    expect(state.preampDb).toBe(-12);
  });

  it('refuses malformed preset data', () => {
    const bridge = createBridge();

    expect(() =>
      bridge.savePreset({
        name: 'Broken',
        preampDb: 0,
        bands: [{ frequencyHz: 31, gainDb: 0, q: 1 }],
      }),
    ).toThrow('invalid_eq_preset');
  });

  it('persists user presets outside the audio callback path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'echo-next-eq-'));
    tempDirs.push(dir);
    const bridge = new EqBridge(dir);
    const state = bridge.getState();

    bridge.savePreset({
      name: 'Desk Headphones',
      preampDb: -2,
      bands: state.bands,
    });

    const reloaded = new EqBridge(dir);
    expect(reloaded.listPresets().some((preset) => preset.name === 'Desk Headphones')).toBe(true);
  });
});
