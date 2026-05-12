// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AudioStatus } from '../../../shared/types/audio';
import type { EqPreset, EqState } from '../../../shared/types/eq';
import { EqPanel } from './EqPanel';

const bands = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map((frequencyHz) => ({
  frequencyHz,
  gainDb: 0,
  q: 1,
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
];

const audioStatus: AudioStatus = {
  host: 'ready',
  state: 'playing',
  outputDeviceId: null,
  outputDeviceName: null,
  outputDeviceType: null,
  outputBackend: 'wasapi-exclusive',
  outputMode: 'exclusive',
  volume: 1,
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
  dspActive: true,
  preampDb: 0,
  eqPresetName: 'Flat',
  clippingRisk: false,
  bitPerfectDisabledReason: 'eq_enabled',
  warnings: ['eq_enabled_bit_perfect_disabled'],
  error: null,
};

beforeEach(() => {
  const currentState = eqState();
  window.echo = {
    eq: {
      getState: vi.fn().mockResolvedValue(currentState),
      listPresets: vi.fn().mockResolvedValue(presets),
      setEnabled: vi.fn().mockImplementation((enabled: boolean) => Promise.resolve(eqState({ enabled }))),
      setBandGain: vi.fn().mockImplementation(({ band, gainDb }: { band: number; gainDb: number }) =>
        Promise.resolve(eqState({ presetId: 'custom', presetName: 'Custom', bands: bands.map((item, index) => (index === band ? { ...item, gainDb } : item)) })),
      ),
      setPreamp: vi.fn().mockImplementation((preampDb: number) => Promise.resolve(eqState({ preampDb }))),
      setPreset: vi.fn().mockImplementation((presetId: string) => Promise.resolve(eqState({ presetId, presetName: presetId }))),
      reset: vi.fn().mockResolvedValue(currentState),
      savePreset: vi.fn().mockResolvedValue(presets[0]),
      deletePreset: vi.fn().mockResolvedValue(presets),
    },
  } as unknown as Window['echo'];
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('EqPanel', () => {
  it('renders the 10 EQ bands', async () => {
    render(<EqPanel audioStatus={audioStatus} />);

    await screen.findByRole('slider', { name: '31 Hz gain' });
    expect(screen.getAllByLabelText(/Hz gain$/)).toHaveLength(10);
  });

  it('sends band gain changes to the EQ bridge', async () => {
    render(<EqPanel audioStatus={audioStatus} />);

    const slider = await screen.findByRole('slider', { name: '125 Hz gain' });
    fireEvent.change(slider, { target: { value: '3.5' } });
    fireEvent.pointerUp(slider);

    await waitFor(() => expect(window.echo.eq.setBandGain).toHaveBeenCalledWith({ band: 2, gainDb: 3.5 }));
  });

  it('selects presets, resets to Flat, and shows the bit-perfect warning', async () => {
    render(<EqPanel audioStatus={audioStatus} />);

    fireEvent.change(await screen.findByLabelText('EQ preset'), { target: { value: 'rock' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset EQ' }));

    await waitFor(() => expect(window.echo.eq.setPreset).toHaveBeenCalledWith('rock'));
    expect(window.echo.eq.reset).toHaveBeenCalled();
    expect(screen.getByText(/not bit-perfect/i)).toBeTruthy();
  });
});
