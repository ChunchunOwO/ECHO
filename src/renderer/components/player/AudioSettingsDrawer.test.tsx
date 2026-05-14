// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AudioSettingsDrawer } from './AudioSettingsDrawer';
import type { AudioDeviceInfo, AudioStatus } from '../../../shared/types/audio';

vi.mock('../../i18n/I18nProvider', () => ({
  useI18n: () => ({
    t: (key: string) => key.split('.').at(-1) ?? key,
  }),
}));

const baseStatus: AudioStatus = {
  host: 'ready',
  state: 'playing',
  outputDeviceId: null,
  outputDeviceName: null,
  outputDeviceType: null,
  outputBackend: null,
  outputMode: 'shared',
  volume: 1,
  playbackRate: 1,
  playbackSpeedMode: 'nightcore',
  currentFilePath: null,
  currentTrackId: null,
  durationSeconds: 0,
  positionSeconds: 0,
  channels: 2,
  codec: 'flac',
  bitDepth: 16,
  bitrate: 900000,
  fileSampleRate: 48000,
  decoderOutputSampleRate: 48000,
  requestedOutputSampleRate: 48000,
  actualDeviceSampleRate: 48000,
  sharedDeviceSampleRate: null,
  resampling: false,
  bitPerfectCandidate: false,
  sampleRateMismatch: false,
  latencyProfile: 'lowLatency',
  eqEnabled: false,
  channelBalanceEnabled: false,
  dspActive: false,
  preampDb: 0,
  eqPresetName: 'Flat',
  clippingRisk: false,
  bitPerfectDisabledReason: null,
  nativeRequestedBufferFrames: null,
  nativeActualBufferFrames: null,
  nativeOutputLatencyMs: null,
  warnings: [],
  error: null,
};

const asioDevice: AudioDeviceInfo = {
  id: 'asio:0',
  index: 0,
  name: 'TEAC ASIO',
  outputMode: 'asio',
  sampleRate: null,
  sharedDeviceSampleRate: 48000,
  isDefault: true,
};

const renderDrawer = (status: AudioStatus, setOutput = vi.fn().mockResolvedValue(status)): void => {
  window.echo = {
    app: {
      getSettings: vi.fn().mockResolvedValue({ rememberedAudioOutput: { enabled: false } }),
      setSettings: vi.fn().mockResolvedValue({}),
    },
    audio: {
      listDevices: vi.fn().mockResolvedValue([asioDevice]),
      getStatus: vi.fn().mockResolvedValue(status),
      getDiagnostics: vi.fn().mockResolvedValue(status),
      setOutput,
    },
  } as unknown as Window['echo'];

  render(
    <AudioSettingsDrawer
      isOpen
      status={status}
      onClose={vi.fn()}
      onStatusChange={vi.fn()}
    />,
  );
};

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0),
  });
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    value: (id: number) => window.clearTimeout(id),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as Partial<Window>).echo;
});

describe('AudioSettingsDrawer ASIO buffer controls', () => {
  it('shows ASIO buffer controls only in ASIO mode', () => {
    renderDrawer({
      ...baseStatus,
      outputMode: 'asio',
      outputBackend: 'asio',
      outputDeviceName: 'TEAC ASIO',
      nativeRequestedBufferFrames: 128,
      nativeActualBufferFrames: 256,
      nativeOutputLatencyMs: 5,
    });

    expect(screen.getByRole('heading', { name: 'ASIO buffer' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /128/ }).length).toBeGreaterThan(0);

    cleanup();
    renderDrawer(baseStatus);

    expect(screen.queryByRole('heading', { name: 'ASIO buffer' })).toBeNull();
  });

  it('applies an explicit ASIO buffer size', async () => {
    const status = {
      ...baseStatus,
      outputMode: 'asio' as const,
      outputBackend: 'asio',
      nativeRequestedBufferFrames: null,
    };
    const setOutput = vi.fn().mockResolvedValue({ ...status, nativeRequestedBufferFrames: 128 });
    renderDrawer(status, setOutput);

    fireEvent.click(screen.getByRole('button', { name: /128/ }));

    await waitFor(() => expect(setOutput).toHaveBeenCalledWith({ bufferSizeFrames: 128 }));
  });

  it('clears explicit ASIO buffer size when Auto is selected', async () => {
    const status = {
      ...baseStatus,
      outputMode: 'asio' as const,
      outputBackend: 'asio',
      nativeRequestedBufferFrames: 128,
      nativeActualBufferFrames: 256,
    };
    const setOutput = vi.fn().mockResolvedValue({ ...status, nativeRequestedBufferFrames: null });
    renderDrawer(status, setOutput);

    fireEvent.click(screen.getByRole('button', { name: /Auto/ }));

    await waitFor(() => expect(setOutput).toHaveBeenCalledWith({ bufferSizeFrames: null }));
  });
});
