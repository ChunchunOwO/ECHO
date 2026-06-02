// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AudioStatus, ChannelBalanceState } from '../../../shared/types/audio';
import type { EqPreset, EqState } from '../../../shared/types/eq';
import { I18nProvider } from '../../i18n/I18nProvider';
import { EqPanel } from './EqPanel';

const bands = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map((frequencyHz) => ({
  frequencyHz,
  gainDb: 0,
  q: 1,
  filterType: 'peaking' as const,
  enabled: true,
}));

const eqState = (overrides: Partial<EqState> = {}): EqState => ({
  enabled: false,
  preampDb: 0,
  bands,
  presetId: 'flat',
  presetName: 'Flat',
  clippingRisk: false,
  ...overrides,
});

const presets: EqPreset[] = [
  { id: 'flat', name: 'Flat', preampDb: 0, bands, createdAt: 'built-in', updatedAt: 'built-in', readonly: true },
  { id: 'rock', name: 'Rock', preampDb: -3, bands, createdAt: 'built-in', updatedAt: 'built-in', readonly: true },
  { id: 'harman-target', name: 'Harman Target', preampDb: -5, bands, createdAt: 'built-in', updatedAt: 'built-in', readonly: true },
  { id: 'subsonic-filter', name: 'Subsonic Filter', preampDb: -2, bands: bands.map((band, index) => (index === 0 ? { ...band, frequencyHz: 24, filterType: 'highPass' as const } : band)), createdAt: 'built-in', updatedAt: 'built-in', readonly: true },
  { id: 'sibilance-tamer', name: 'Sibilance Tamer', preampDb: -4, bands: bands.map((band, index) => (index === 8 ? { ...band, frequencyHz: 8200, filterType: 'notch' as const, q: 6 } : band)), createdAt: 'built-in', updatedAt: 'built-in', readonly: true },
  { id: 'bluetooth-speaker-cleanup', name: 'Bluetooth Speaker Cleanup', preampDb: -3, bands: bands.map((band, index) => (index === 9 ? { ...band, frequencyHz: 18000, filterType: 'lowPass' as const } : band)), createdAt: 'built-in', updatedAt: 'built-in', readonly: true },
  { id: 'user-bright', name: 'User Bright', preampDb: -4, bands, createdAt: 'now', updatedAt: 'now', readonly: false },
];

const channelBalanceState = (overrides: Partial<ChannelBalanceState> = {}): ChannelBalanceState => ({
  enabled: false,
  balance: 0,
  leftGainDb: 0,
  rightGainDb: 0,
  swapLeftRight: false,
  monoMode: 'off',
  invertLeft: false,
  invertRight: false,
  constantPower: true,
  clippingRisk: false,
  ...overrides,
});

const audioStatus: AudioStatus = {
  host: 'ready',
  state: 'playing',
  outputDeviceId: null,
  outputDeviceName: null,
  outputDeviceType: null,
  outputBackend: 'wasapi-exclusive',
  activeOutputBackendImpl: null,
  outputMode: 'exclusive',
  useJuceOutputRequested: false,
  useJuceDecodeRequested: false,
  activeDecodeBackendImpl: null,
  volume: 1,
  playbackRate: 1,
  playbackSpeedMode: 'nightcore',
  currentFilePath: null,
  currentTrackId: null,
  durationSeconds: 0,
  positionSeconds: 0,
  channels: 2,
  codec: 'FLAC',
  bitDepth: 24,
  bitrate: 1400000,
  fileSampleRate: 44100,
  decoderOutputSampleRate: 44100,
  requestedOutputSampleRate: 44100,
  actualDeviceSampleRate: 44100,
  sharedDeviceSampleRate: null,
  resampling: false,
  bitPerfectCandidate: false,
  sampleRateMismatch: false,
  eqEnabled: true,
  channelBalanceEnabled: false,
  dspActive: true,
  preampDb: 0,
  eqPresetName: 'Flat',
  clippingRisk: false,
  bitPerfectDisabledReason: 'eq_enabled',
  warnings: ['eq_enabled_bit_perfect_disabled'],
  error: null,
};

const renderEqPanel = (status: AudioStatus | null = audioStatus): ReturnType<typeof render> =>
  render(
    <I18nProvider>
      <EqPanel audioStatus={status} />
    </I18nProvider>,
  );

const showAdvancedEqTools = async (): Promise<void> => {
  fireEvent.click(await screen.findByRole('button', { name: 'Pro' }));
};

beforeEach(() => {
  window.localStorage.setItem('echo-next.locale', 'en-US');
  window.localStorage.removeItem('echo-next.eq.uiMode');
  window.localStorage.removeItem('echo-next.eq.spectrumAnalyzer');
  window.localStorage.removeItem('echo-next.eq.analyzerMode');
  window.localStorage.removeItem('echo-next.eq.autoGainEnabled');
  const currentState = eqState({
    bands: bands.map((band, index) => (index === 1 ? { ...band, gainDb: 6 } : band)),
  });

  window.echo = {
    eq: {
      getState: vi.fn().mockResolvedValue(currentState),
      listPresets: vi.fn().mockResolvedValue(presets),
      setEnabled: vi.fn().mockImplementation((enabled: boolean) => Promise.resolve(eqState({ enabled }))),
      setBandGain: vi.fn().mockImplementation(({ band, gainDb }: { band: number; gainDb: number }) =>
        Promise.resolve(eqState({ presetId: 'custom', presetName: 'Custom', bands: bands.map((item, index) => (index === band ? { ...item, gainDb } : item)) })),
      ),
      setBandFrequency: vi.fn().mockImplementation(({ band, frequencyHz }: { band: number; frequencyHz: number }) =>
        Promise.resolve(eqState({ presetId: 'custom', presetName: 'Custom', bands: bands.map((item, index) => (index === band ? { ...item, frequencyHz } : item)) })),
      ),
      setBandQ: vi.fn().mockImplementation(({ band, q }: { band: number; q: number }) =>
        Promise.resolve(eqState({ presetId: 'custom', presetName: 'Custom', bands: bands.map((item, index) => (index === band ? { ...item, q } : item)) })),
      ),
      setBandFilterType: vi.fn().mockImplementation(({ band, filterType }: { band: number; filterType: 'peaking' | 'lowShelf' | 'highShelf' | 'lowPass' | 'highPass' | 'notch' }) =>
        Promise.resolve(eqState({ presetId: 'custom', presetName: 'Custom', bands: bands.map((item, index) => (index === band ? { ...item, filterType } : item)) })),
      ),
      setBandEnabled: vi.fn().mockImplementation(({ band, enabled }: { band: number; enabled: boolean }) =>
        Promise.resolve(eqState({ presetId: 'custom', presetName: 'Custom', bands: bands.map((item, index) => (index === band ? { ...item, enabled } : item)) })),
      ),
      setPreamp: vi.fn().mockImplementation((preampDb: number) => Promise.resolve(eqState({ preampDb }))),
      setPreset: vi.fn().mockImplementation((presetId: string) => Promise.resolve(eqState({ presetId, presetName: presetId === 'rock' ? 'Rock' : 'User Bright' }))),
      reset: vi.fn().mockResolvedValue(eqState()),
      savePreset: vi.fn().mockResolvedValue(presets[2]),
      exportPreset: vi.fn().mockResolvedValue('D:\\Exports\\Desk Headphones.json'),
      importPreset: vi.fn().mockResolvedValue(presets.find((preset) => preset.id === 'user-bright')),
      deletePreset: vi.fn().mockResolvedValue(presets.slice(0, 2)),
      listProfiles: vi.fn().mockResolvedValue([]),
      saveProfile: vi.fn().mockResolvedValue({
        id: 'desk-profile',
        name: 'Desk Profile',
        state: currentState,
        bindings: [],
        createdAt: 'now',
        updatedAt: 'now',
      }),
      applyProfile: vi.fn().mockResolvedValue(currentState),
      deleteProfile: vi.fn().mockResolvedValue([]),
      bindProfileToOutput: vi.fn().mockResolvedValue({
        key: 'exclusive-null',
        label: 'EXCLUSIVE / Current output',
        profileId: 'desk-profile',
        profileName: 'Desk Profile',
      }),
      getProfileBinding: vi.fn().mockResolvedValue(null),
      getChannelBalanceState: vi.fn().mockResolvedValue(channelBalanceState()),
      setChannelBalanceState: vi.fn().mockImplementation((patch) => Promise.resolve(channelBalanceState(patch))),
      resetChannelBalance: vi.fn().mockResolvedValue(channelBalanceState()),
    },
  } as unknown as Window['echo'];
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('EqPanel', () => {
  it('renders Simple mode with the core EQ workflow first', async () => {
    renderEqPanel();

    await screen.findByRole('img', { name: 'Draggable 10-band EQ frequency response' });
    expect(screen.getByRole('heading', { name: 'EQ' })).toBeTruthy();
    expect(screen.getByText('Sound curve, safe headroom, and advanced tuning')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Simple' }).dataset.active).toBe('true');
    expect(screen.queryByText('Signal Path')).toBeNull();
    expect(screen.queryByText('Selected band console')).toBeNull();
    expect(screen.queryByLabelText('Q')).toBeNull();
    expect(await screen.findByLabelText('Balance')).toBeTruthy();
    expect(screen.getAllByText('Headroom').length).toBeGreaterThan(0);
    expect(screen.getByText('Bit-perfect')).toBeTruthy();
  });

  it('keeps the full professional tools behind Pro mode', async () => {
    renderEqPanel();

    expect(await screen.findByRole('button', { name: 'Pro' })).toBeTruthy();
    expect(screen.queryByLabelText('Unlock frequency')).toBeNull();
    expect(screen.queryByLabelText('Q')).toBeNull();
    expect(screen.queryByLabelText('EQ profile name')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Store A' })).toBeNull();

    await showAdvancedEqTools();

    expect(screen.getByRole('button', { name: 'Pro' }).dataset.active).toBe('true');
    expect(screen.getByText('Signal Path')).toBeTruthy();
    expect(await screen.findByLabelText('Unlock frequency')).toBeTruthy();
    expect(screen.getByLabelText('Q')).toBeTruthy();
    expect(screen.getByLabelText('EQ profile name')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Store A' })).toBeTruthy();
  });

  it('updates PEQ band Q, filter type, and bypass state from the advanced inspector', async () => {
    renderEqPanel();
    await showAdvancedEqTools();

    fireEvent.change(await screen.findByLabelText('Q'), { target: { value: '2.4' } });
    fireEvent.blur(screen.getByLabelText('Q'));
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'lowShelf' } });
    fireEvent.click(screen.getByLabelText('Band enabled'));

    await waitFor(() => expect(window.echo.eq.setBandQ).toHaveBeenCalledWith({ band: 0, q: 2.4 }));
    await waitFor(() => expect(window.echo.eq.setBandFilterType).toHaveBeenCalledWith({ band: 0, filterType: 'lowShelf' }));
    await waitFor(() => expect(window.echo.eq.setBandEnabled).toHaveBeenCalledWith({ band: 0, enabled: false }));
  });

  it('supports full parametric filter types and fixes gain for pass/notch bands', async () => {
    renderEqPanel();
    await showAdvancedEqTools();

    const typeSelect = await screen.findByLabelText('Type');
    expect(typeSelect.textContent).toContain('Low pass');
    expect(typeSelect.textContent).toContain('High pass');
    expect(typeSelect.textContent).toContain('Notch');

    fireEvent.change(typeSelect, { target: { value: 'notch' } });

    await waitFor(() => expect(window.echo.eq.setBandFilterType).toHaveBeenCalledWith({ band: 0, filterType: 'notch' }));
    await waitFor(() => expect(window.echo.eq.setBandGain).toHaveBeenCalledWith({ band: 0, gainDb: 0 }));
    await waitFor(() => expect((screen.getByLabelText('Gain') as HTMLInputElement).disabled).toBe(true));
  });

  it('applies type-aware Q preset buttons from the pro inspector', async () => {
    renderEqPanel();
    await showAdvancedEqTools();

    fireEvent.click(await screen.findByRole('button', { name: 'Narrow' }));
    await waitFor(() => expect(window.echo.eq.setBandQ).toHaveBeenCalledWith({ band: 0, q: 4 }));

    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'notch' } });
    await waitFor(() => expect(window.echo.eq.setBandFilterType).toHaveBeenCalledWith({ band: 0, filterType: 'notch' }));
    fireEvent.click(screen.getByRole('button', { name: 'Normal' }));

    await waitFor(() => expect(window.echo.eq.setBandQ).toHaveBeenCalledWith({ band: 0, q: 6 }));
  });

  it('saves profiles and binds the selected profile only to the current output when requested', async () => {
    renderEqPanel();
    await showAdvancedEqTools();

    fireEvent.change(await screen.findByLabelText('EQ profile name'), { target: { value: 'Desk Profile' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    await waitFor(() => expect(window.echo.eq.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ name: 'Desk Profile' })));
    await waitFor(() => expect(window.echo.eq.listProfiles).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'Bind current output' }));
    await waitFor(() =>
      expect(window.echo.eq.bindProfileToOutput).toHaveBeenCalledWith(expect.objectContaining({
        profileId: 'desk-profile',
        target: expect.objectContaining({ outputMode: 'exclusive' }),
      })),
    );
  });

  it('lets EQ curve nodes update gain and snapped frequency while standard frequency snap is locked', async () => {
    renderEqPanel();

    const curve = await screen.findByRole('img', { name: 'Draggable 10-band EQ frequency response' });
    curve.getBoundingClientRect = vi.fn(() => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 920,
      bottom: 260,
      width: 920,
      height: 260,
      toJSON: () => undefined,
    }));

    const node = await screen.findByTestId('eq-curve-node-2');
    fireEvent.pointerDown(node, { clientX: 410, clientY: 94, pointerId: 1 });
    fireEvent.pointerMove(curve, { clientX: 410, clientY: 94, pointerId: 1 });
    fireEvent.pointerUp(curve, { clientX: 410, clientY: 94, pointerId: 1 });

    await waitFor(() => expect(window.echo.eq.setBandGain).toHaveBeenCalledWith({ band: 2, gainDb: 3.5 }));
    await waitFor(() => expect(window.echo.eq.setBandFrequency).toHaveBeenCalledWith({ band: 2, frequencyHz: 500 }));

    await showAdvancedEqTools();
    fireEvent.click(screen.getByRole('button', { name: 'Reset selected' }));
    await waitFor(() => expect(window.echo.eq.setBandGain).toHaveBeenCalledWith({ band: 2, gainDb: 0 }));
  });

  it('maps EQ drag coordinates through the SVG screen matrix when the chart is letterboxed', async () => {
    renderEqPanel();

    const curve = await screen.findByRole('img', { name: 'Draggable 10-band EQ frequency response' });
    curve.getBoundingClientRect = vi.fn(() => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 1100,
      bottom: 360,
      width: 1100,
      height: 360,
      toJSON: () => undefined,
    }));
    const point = {
      x: 0,
      y: 0,
      matrixTransform: vi.fn(() => ({ x: 410, y: 130 })),
    };
    Object.defineProperty(curve, 'getScreenCTM', {
      value: vi.fn(() => ({ inverse: () => ({}) })),
      configurable: true,
    });
    Object.defineProperty(curve, 'createSVGPoint', {
      value: vi.fn(() => point),
      configurable: true,
    });

    const node = await screen.findByTestId('eq-curve-node-2');
    fireEvent.pointerDown(node, { clientX: 510, clientY: 94, pointerId: 1 });
    fireEvent.pointerUp(curve, { clientX: 510, clientY: 94, pointerId: 1 });

    expect(point.matrixTransform).toHaveBeenCalled();
    await waitFor(() => expect(window.echo.eq.setBandGain).toHaveBeenCalledWith({ band: 2, gainDb: 3.5 }));
    await waitFor(() => expect(window.echo.eq.setBandFrequency).toHaveBeenCalledWith({ band: 2, frequencyHz: 500 }));
  });

  it('only edits band frequency when free-frequency mode is unlocked', async () => {
    renderEqPanel();
    await showAdvancedEqTools();

    const curve = await screen.findByRole('img', { name: 'Draggable 10-band EQ frequency response' });
    curve.getBoundingClientRect = vi.fn(() => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 920,
      bottom: 260,
      width: 920,
      height: 260,
      toJSON: () => undefined,
    }));

    fireEvent.click(await screen.findByLabelText('Unlock frequency'));
    const node = await screen.findByTestId('eq-curve-node-2');
    fireEvent.pointerDown(node, { clientX: 410, clientY: 94, pointerId: 1, shiftKey: true });
    fireEvent.pointerMove(curve, { clientX: 410, clientY: 94, pointerId: 1, shiftKey: true });
    fireEvent.pointerUp(curve, { clientX: 410, clientY: 94, pointerId: 1, shiftKey: true });

    await waitFor(() => expect(window.echo.eq.setBandGain).toHaveBeenCalledWith({ band: 2, gainDb: 3.7 }));
    await waitFor(() => expect(window.echo.eq.setBandFrequency).toHaveBeenCalledWith({ band: 2, frequencyHz: expect.any(Number) }));
  });

  it('keeps pass and notch node drags horizontal by avoiding gain updates', async () => {
    renderEqPanel();
    await showAdvancedEqTools();

    fireEvent.change(await screen.findByLabelText('Type'), { target: { value: 'highPass' } });
    await waitFor(() => expect(window.echo.eq.setBandFilterType).toHaveBeenCalledWith({ band: 0, filterType: 'highPass' }));
    (window.echo.eq.setBandGain as ReturnType<typeof vi.fn>).mockClear();
    (window.echo.eq.setBandFrequency as ReturnType<typeof vi.fn>).mockClear();

    const curve = await screen.findByRole('img', { name: 'Draggable 10-band EQ frequency response' });
    curve.getBoundingClientRect = vi.fn(() => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 920,
      bottom: 260,
      width: 920,
      height: 260,
      toJSON: () => undefined,
    }));

    const node = await screen.findByTestId('eq-curve-node-0');
    fireEvent.pointerDown(node, { clientX: 410, clientY: 40, pointerId: 1 });
    fireEvent.pointerMove(curve, { clientX: 410, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(curve, { clientX: 410, clientY: 40, pointerId: 1 });

    expect(window.echo.eq.setBandGain).not.toHaveBeenCalled();
    await waitFor(() => expect(window.echo.eq.setBandFrequency).toHaveBeenCalledWith({ band: 0, frequencyHz: 500 }));
  });

  it('supports keyboard fine gain adjustment on selected EQ nodes', async () => {
    renderEqPanel();

    const node = await screen.findByTestId('eq-curve-node-2');
    fireEvent.keyDown(node, { key: 'ArrowUp', shiftKey: true });

    await waitFor(() => expect(window.echo.eq.setBandGain).toHaveBeenCalledWith({ band: 2, gainDb: 0.1 }));
  });

  it('apply safe preamp uses the recommended headroom when peak estimate is risky', async () => {
    renderEqPanel();

    fireEvent.click(await screen.findByRole('button', { name: /Apply safe preamp/i }));

    await waitFor(() => expect(window.echo.eq.setPreamp).toHaveBeenCalledWith(-6));
  });

  it('renders realtime input and estimated output meter values safely', async () => {
    renderEqPanel({
      ...audioStatus,
      clippingRisk: true,
      audioLevels: {
        inputPeakDb: -5.2,
        inputRmsDb: -18.4,
        estimatedOutputPeakDb: 0.8,
        estimatedOutputRmsDb: -12.4,
        headroomDb: -0.8,
        clipCount: 3,
        lastClipAt: '2026-05-13T00:00:00.000Z',
        meterSource: 'pre_native_estimated_post_dsp',
      },
    });

    expect(await screen.findByText('Input peak')).toBeTruthy();
    expect(screen.getAllByText('-5.2 dB').length).toBeGreaterThan(0);
    expect(screen.getByText('Est. output peak')).toBeTruthy();
    expect(screen.getAllByText('Headroom').length).toBeGreaterThan(0);
    expect(screen.getByText(/pre-native \+ DSP estimate/)).toBeTruthy();
    expect(screen.getByText(/Clips 3/)).toBeTruthy();
  });

  it('shows Auto Gain in Simple and Pro modes and persists the toggle', async () => {
    renderEqPanel();

    expect(await screen.findByRole('button', { name: 'Auto Gain' })).toBeTruthy();
    expect(screen.getByText('Idle')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Auto Gain' }));

    await waitFor(() => expect(window.localStorage.getItem('echo-next.eq.autoGainEnabled')).toBe('true'));
    await showAdvancedEqTools();
    expect(screen.getByRole('button', { name: 'Auto Gain' })).toBeTruthy();
  });

  it('automatically lowers preamp when Auto Gain sees realtime clipping risk', async () => {
    renderEqPanel({
      ...audioStatus,
      clippingRisk: true,
      audioLevels: {
        inputPeakDb: -4,
        inputRmsDb: -18,
        estimatedOutputPeakDb: 0.8,
        estimatedOutputRmsDb: -12,
        headroomDb: -0.8,
        clipCount: 0,
        lastClipAt: null,
        meterSource: 'pre_native_estimated_post_dsp',
      },
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Auto Gain' }));

    await waitFor(() => expect(window.echo.eq.setPreamp).toHaveBeenCalledWith(expect.any(Number)));
    const autoPreampCall = vi.mocked(window.echo.eq.setPreamp).mock.calls.find(([preampDb]) => preampDb < 0);
    expect(autoPreampCall?.[0]).toBeLessThanOrEqual(-1.8);
    expect(await screen.findByText(/Clipping|Reducing/)).toBeTruthy();
  });

  it('keeps Auto Gain from immediately fighting a manual preamp edit', async () => {
    renderEqPanel({
      ...audioStatus,
      audioLevels: {
        inputPeakDb: -4,
        inputRmsDb: -18,
        estimatedOutputPeakDb: 0.8,
        estimatedOutputRmsDb: -12,
        headroomDb: -0.8,
        clipCount: 0,
        lastClipAt: null,
        meterSource: 'pre_native_estimated_post_dsp',
      },
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Auto Gain' }));
    await waitFor(() => expect(window.echo.eq.setPreamp).toHaveBeenCalled());
    vi.mocked(window.echo.eq.setPreamp).mockClear();

    const preamp = await screen.findByLabelText('EQ preamp');
    fireEvent.change(preamp, { target: { value: '-3' } });

    await waitFor(() => expect(window.echo.eq.setPreamp).toHaveBeenCalledWith(-3));
    expect(screen.getByText('Holding')).toBeTruthy();
    expect(vi.mocked(window.echo.eq.setPreamp).mock.calls.filter(([preampDb]) => preampDb !== -3)).toHaveLength(0);
  });

  it('overlays realtime visual spectrum and hover readout when analyzer is enabled', async () => {
    const { container } = renderEqPanel({
      ...audioStatus,
      audioLevels: {
        inputPeakDb: -5.2,
        inputRmsDb: -18.4,
        estimatedOutputPeakDb: -6,
        estimatedOutputRmsDb: -19,
        visualSpectrum: Array.from({ length: 32 }, (_unused, index) => index / 31),
        visualSpectrumVersion: 2,
        visualEnergy: 0.5,
        visualTransient: 0.2,
        visualTelemetryState: 'pcm',
        headroomDb: 6,
        clipCount: 0,
        lastClipAt: null,
        meterSource: 'pre_native_estimated_post_dsp',
      },
    });
    await showAdvancedEqTools();

    expect(container.querySelector('.eq-spectrum-overlay')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Analyzer' }));
    expect(container.querySelectorAll('.eq-spectrum-bar')).toHaveLength(32);

    const curve = await screen.findByRole('img', { name: 'Draggable 10-band EQ frequency response' });
    curve.getBoundingClientRect = vi.fn(() => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 920,
      bottom: 360,
      width: 920,
      height: 360,
      toJSON: () => undefined,
    }));
    fireEvent.pointerMove(curve, { clientX: 410, clientY: 140, pointerId: 1 });

    expect(container.querySelector('.eq-hover-readout')).toBeTruthy();
  });

  it('shows analyzer status text for live, priming, and no-signal states', async () => {
    const { container, rerender } = render(
      <I18nProvider>
        <EqPanel
          audioStatus={{
            ...audioStatus,
            audioLevels: {
              inputPeakDb: -5.2,
              inputRmsDb: -18.4,
              estimatedOutputPeakDb: -6,
              estimatedOutputRmsDb: -19,
              visualSpectrum: Array.from({ length: 32 }, () => 0.4),
              visualSpectrumVersion: 2,
              visualEnergy: 0.4,
              visualTransient: 0.2,
              visualTelemetryState: 'pcm',
              headroomDb: 6,
              clipCount: 0,
              lastClipAt: null,
              meterSource: 'pre_native_estimated_post_dsp',
            },
          }}
        />
      </I18nProvider>,
    );
    await showAdvancedEqTools();

    expect(container.querySelector('.eq-analyzer-status')?.textContent).toContain('Off');
    fireEvent.click(await screen.findByRole('button', { name: 'Analyzer' }));
    expect(container.querySelector('.eq-analyzer-status')?.textContent).toContain('Live');
    expect(container.querySelector('.eq-analyzer-status')?.getAttribute('data-state')).toBe('live');

    rerender(
      <I18nProvider>
        <EqPanel
          audioStatus={{
            ...audioStatus,
            audioLevels: {
              inputPeakDb: -5.2,
              inputRmsDb: -18.4,
              estimatedOutputPeakDb: -6,
              estimatedOutputRmsDb: -19,
              visualSpectrum: Array.from({ length: 32 }, () => 0),
              visualSpectrumVersion: 2,
              visualEnergy: 0,
              visualTransient: 0,
              visualTelemetryState: 'priming',
              headroomDb: 6,
              clipCount: 0,
              lastClipAt: null,
              meterSource: 'pre_native_estimated_post_dsp',
            },
          }}
        />
      </I18nProvider>,
    );
    expect(container.querySelector('.eq-analyzer-status')?.textContent).toContain('Priming');
    expect(container.querySelector('.eq-analyzer-status')?.getAttribute('data-state')).toBe('priming');

    rerender(
      <I18nProvider>
        <EqPanel
          audioStatus={{
            ...audioStatus,
            audioLevels: {
              inputPeakDb: -90,
              inputRmsDb: -90,
              estimatedOutputPeakDb: -90,
              estimatedOutputRmsDb: -90,
              visualSpectrum: Array.from({ length: 32 }, () => 0),
              visualSpectrumVersion: 2,
              visualEnergy: 0,
              visualTransient: 0,
              visualTelemetryState: 'pcm',
              headroomDb: 90,
              clipCount: 0,
              lastClipAt: null,
              meterSource: 'pre_native_estimated_post_dsp',
            },
          }}
        />
      </I18nProvider>,
    );
    expect(container.querySelector('.eq-analyzer-status')?.textContent).toContain('No signal');
    expect(container.querySelector('.eq-analyzer-status')?.getAttribute('data-state')).toBe('noSignal');
  });

  it('switches the analyzer overlay between input and post-EQ estimate modes', async () => {
    const { container } = renderEqPanel({
      ...audioStatus,
      audioLevels: {
        inputPeakDb: -6,
        inputRmsDb: -18,
        estimatedOutputPeakDb: -5,
        estimatedOutputRmsDb: -17,
        visualSpectrum: Array.from({ length: 32 }, () => 0.35),
        visualSpectrumVersion: 2,
        visualEnergy: 0.35,
        visualTransient: 0.1,
        visualTelemetryState: 'pcm',
        headroomDb: 5,
        clipCount: 0,
        lastClipAt: null,
        meterSource: 'pre_native_estimated_post_dsp',
      },
    });
    await showAdvancedEqTools();

    fireEvent.click(await screen.findByRole('button', { name: 'Analyzer' }));
    expect(container.querySelector('.eq-spectrum-bar')?.getAttribute('data-mode')).toBe('input');

    fireEvent.click(screen.getByRole('button', { name: 'Post EQ' }));
    expect(container.querySelector('.eq-spectrum-bar')?.getAttribute('data-mode')).toBe('postEq');
  });

  it('undoes and redoes EQ curve edits through existing IPC calls', async () => {
    renderEqPanel();
    await showAdvancedEqTools();

    const curve = await screen.findByRole('img', { name: 'Draggable 10-band EQ frequency response' });
    curve.getBoundingClientRect = vi.fn(() => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 920,
      bottom: 260,
      width: 920,
      height: 260,
      toJSON: () => undefined,
    }));

    const node = await screen.findByTestId('eq-curve-node-2');
    fireEvent.pointerDown(node, { clientX: 410, clientY: 94, pointerId: 1 });
    fireEvent.pointerUp(curve, { clientX: 410, clientY: 94, pointerId: 1 });
    await waitFor(() => expect(window.echo.eq.setBandGain).toHaveBeenCalledWith({ band: 2, gainDb: 3.5 }));

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(window.echo.eq.setBandGain).toHaveBeenCalledWith({ band: 2, gainDb: 0 }));

    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    await waitFor(() => expect(window.echo.eq.setBandGain).toHaveBeenCalledWith({ band: 2, gainDb: 3.5 }));
  });

  it('temporarily disables EQ while holding the bypass button', async () => {
    renderEqPanel();
    await showAdvancedEqTools();

    const bypass = await screen.findByRole('button', { name: 'Hold to Bypass EQ' });
    fireEvent.pointerDown(bypass);

    await waitFor(() => expect(window.echo.eq.setEnabled).toHaveBeenCalledWith(false));
  });

  it('captures and restores local A/B EQ slots through existing IPC calls', async () => {
    renderEqPanel();
    await showAdvancedEqTools();

    fireEvent.click(await screen.findByRole('button', { name: 'Store A' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply A' }));

    await waitFor(() => expect(window.echo.eq.setPreamp).toHaveBeenCalledWith(0));
    await waitFor(() => expect(window.echo.eq.setBandGain).toHaveBeenCalledWith({ band: 1, gainDb: 6 }));
  });

  it('applies loudness-matched A/B restore through preamp compensation', async () => {
    renderEqPanel();
    await showAdvancedEqTools();

    fireEvent.click(await screen.findByRole('button', { name: 'Store A' }));
    fireEvent.click(screen.getByRole('button', { name: /Apply safe preamp/i }));
    await waitFor(() => expect(window.echo.eq.setPreamp).toHaveBeenCalledWith(-6));

    fireEvent.click(screen.getByLabelText('Loudness matched'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply A' }));

    await waitFor(() => expect(window.echo.eq.setPreamp).toHaveBeenCalledWith(-12));
  });

  it('selects presets, resets to Flat, and prevents built-in preset deletion', async () => {
    renderEqPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'EQ preset' }));
    fireEvent.click(screen.getByRole('option', { name: 'Rock' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset EQ' }));

    await waitFor(() => expect(window.echo.eq.setPreset).toHaveBeenCalledWith('rock'));
    expect(window.echo.eq.reset).toHaveBeenCalled();
    expect((screen.getByRole('button', { name: /Delete/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Overwrite' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('allows overwriting current user presets without deleting built-ins', async () => {
    renderEqPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'EQ preset' }));
    fireEvent.click(screen.getByRole('option', { name: 'User Bright' }));

    await waitFor(() => expect(window.echo.eq.setPreset).toHaveBeenCalledWith('user-bright'));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Overwrite' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Overwrite' }));

    await waitFor(() => expect(window.echo.eq.savePreset).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-bright', name: 'User Bright' })));
  });

  it('exports the current EQ as a preset file from the Save as action', async () => {
    renderEqPanel();

    fireEvent.change(await screen.findByLabelText('Preset name'), { target: { value: 'Desk Headphones' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save as' }));

    await waitFor(() =>
      expect(window.echo.eq.exportPreset).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Desk Headphones',
        bands: expect.any(Array),
      })),
    );
    expect(window.echo.eq.savePreset).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'Desk Headphones' }));
  });

  it('imports an EQ preset file and applies the imported preset', async () => {
    renderEqPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Import preset' }));

    await waitFor(() => expect(window.echo.eq.importPreset).toHaveBeenCalled());
    await waitFor(() => expect(window.echo.eq.listPresets).toHaveBeenCalled());
    await waitFor(() => expect(window.echo.eq.setPreset).toHaveBeenCalledWith('user-bright'));
  });

  it('filters presets by search and target curve category', async () => {
    renderEqPanel();

    fireEvent.change(await screen.findByLabelText('Search presets'), { target: { value: 'Harman' } });
    fireEvent.click(screen.getByRole('button', { name: 'Target curves' }));
    fireEvent.click(screen.getByRole('button', { name: 'EQ preset' }));

    expect(screen.getByRole('option', { name: 'Harman Target' })).toBeTruthy();
  });

  it('groups correction PEQ presets under utility metadata', async () => {
    renderEqPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Utility' }));
    fireEvent.click(screen.getByRole('button', { name: 'EQ preset' }));

    expect(screen.getByRole('option', { name: 'Subsonic Filter' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Sibilance Tamer' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Bluetooth Speaker Cleanup' })).toBeTruthy();
  });

  it('shows channel balance controls and clamps channel balance patches', async () => {
    renderEqPanel();
    await showAdvancedEqTools();

    fireEvent.change(await screen.findByLabelText('Balance'), { target: { value: '400' } });
    fireEvent.change(screen.getByLabelText('Left Gain'), { target: { value: '-50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sum' }));

    await waitFor(() => expect(window.echo.eq.setChannelBalanceState).toHaveBeenCalledWith({ balance: 1 }));
    await waitFor(() => expect(window.echo.eq.setChannelBalanceState).toHaveBeenCalledWith({ leftGainDb: -12 }));
    await waitFor(() => expect(window.echo.eq.setChannelBalanceState).toHaveBeenCalledWith({ monoMode: 'sum' }));
  });

  it('resets monitor tools without changing balance or gain trim', async () => {
    renderEqPanel();
    await showAdvancedEqTools();

    fireEvent.click(await screen.findByRole('button', { name: 'Reset monitor tools' }));

    await waitFor(() =>
      expect(window.echo.eq.setChannelBalanceState).toHaveBeenCalledWith({
        monoMode: 'off',
        swapLeftRight: false,
        invertLeft: false,
        invertRight: false,
        constantPower: true,
      }),
    );
  });

  it('shows channel calibration effective gain and resets trims separately', async () => {
    renderEqPanel();
    await showAdvancedEqTools();

    fireEvent.click(await screen.findByLabelText('Calibration mode'));
    expect(screen.getByText('Effective L')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reset trims only' }));

    await waitFor(() =>
      expect(window.echo.eq.setChannelBalanceState).toHaveBeenCalledWith({
        balance: 0,
        leftGainDb: 0,
        rightGainDb: 0,
      }),
    );
  });

  it('renders EQ panel keys across supported locales', async () => {
    for (const locale of ['en-US', 'zh-CN', 'zh-TW', 'ja-JP']) {
      cleanup();
      window.localStorage.setItem('echo-next.locale', locale);
      renderEqPanel();
      expect(await screen.findByRole('img')).toBeTruthy();
      expect(screen.queryByText(/settings\.eq\./)).toBeNull();
    }
  });
});
