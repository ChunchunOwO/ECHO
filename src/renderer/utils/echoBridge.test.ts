// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('renderer EQ bridge fallback', () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
    delete (window as unknown as { echo?: unknown }).echo;
  });

  it('persists EQ presets and channel balance without the Electron preload bridge', async () => {
    const { getEqBridge } = await import('./echoBridge');
    const eq = getEqBridge();

    expect(eq).toBeTruthy();

    await eq?.setBandGain({ band: 2, gainDb: 4.5 });
    await eq?.setBandQ({ band: 2, q: 2.5 });
    await eq?.setBandFilterType({ band: 2, filterType: 'highShelf' });
    await eq?.setBandEnabled({ band: 2, enabled: false });
    const savedPreset = await eq?.savePreset({
      name: 'Browser Bright',
      preampDb: -4,
      bands: (await eq.getState()).bands,
    });
    await eq?.setPreset(savedPreset?.id ?? '');
    const savedProfile = await eq?.saveProfile({
      name: 'Browser Desk',
      state: await eq.getState(),
    });
    await eq?.bindProfileToOutput({
      profileId: savedProfile?.id ?? '',
      target: { outputMode: 'shared', outputDeviceId: 'browser-device', outputDeviceName: 'Browser Device' },
    });
    await eq?.setChannelBalanceState({ enabled: true, balance: 0.25, monoMode: 'sum' });

    vi.resetModules();
    const { getEqBridge: getReloadedEqBridge } = await import('./echoBridge');
    const reloaded = getReloadedEqBridge();
    const presets = await reloaded?.listPresets();
    const profiles = await reloaded?.listProfiles();
    const state = await reloaded?.getState();
    const binding = await reloaded?.getProfileBinding({ outputMode: 'shared', outputDeviceId: 'browser-device', outputDeviceName: 'Browser Device' });
    const channelBalance = await reloaded?.getChannelBalanceState();

    expect(presets?.some((preset) => preset.id === 'browser-bright')).toBe(true);
    expect(profiles?.some((profile) => profile.id === 'browser-desk')).toBe(true);
    expect(state).toMatchObject({ presetId: 'browser-bright', presetName: 'Browser Bright', preampDb: -4 });
    expect(state?.bands[2]).toMatchObject({ q: 2.5, filterType: 'highShelf', enabled: false });
    expect(binding).toMatchObject({ profileId: 'browser-desk', profileName: 'Browser Desk' });
    expect(channelBalance).toMatchObject({ enabled: true, balance: 0.25, monoMode: 'sum' });
  });
});
