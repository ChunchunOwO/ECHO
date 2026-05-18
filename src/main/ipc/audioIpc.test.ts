import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const AUDIO_COMMAND_TIMEOUT_MS = 15_000;

describe('audio IPC command timeout fallback', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns the current audio status instead of surfacing a timed-out command error', async () => {
    vi.useFakeTimers();

    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const reportAudioError = vi.fn();
    const status = {
      host: 'ready',
      state: 'playing',
      outputDeviceId: 'device-1',
      outputDeviceName: 'Speakers',
      outputDeviceType: 'wasapi',
      outputBackend: 'wasapi-shared',
      activeOutputBackendImpl: 'wasapi-shared',
      outputMode: 'shared',
      sharedBackend: 'windows',
      useJuceOutputRequested: false,
      useJuceDecodeRequested: false,
      activeDecodeBackendImpl: 'juce',
      volume: 1,
      playbackRate: 1,
      playbackSpeedMode: 'speed',
      currentFilePath: 'D:\\Music\\stable.flac',
      currentTrackId: 'track-1',
      durationSeconds: 180,
      positionSeconds: 42,
      channels: 2,
      codec: 'flac',
      bitDepth: 16,
      bitrate: 900000,
      fileSampleRate: 44100,
      decoderOutputSampleRate: 44100,
      requestedOutputSampleRate: null,
      actualDeviceSampleRate: 44100,
      sharedDeviceSampleRate: 44100,
      resampling: false,
      bitPerfectCandidate: true,
      sampleRateMismatch: false,
      eqEnabled: false,
      channelBalanceEnabled: false,
      dspActive: false,
      preampDb: 0,
      eqPresetName: null,
      clippingRisk: false,
      bitPerfectDisabledReason: null,
      warnings: [],
      error: null,
    };
    const setOutput = vi.fn(() => new Promise(() => undefined));
    const audioSession = {
      getStatus: () => status,
      getDiagnostics: vi.fn(),
      listDevicesAsync: vi.fn(),
      on: vi.fn(),
      setOutput,
      forceRestart: vi.fn(),
      openAsioControlPanel: vi.fn(),
      stopForWindowsAudioServiceRestart: vi.fn(),
    };

    vi.doMock('electron', () => ({
      BrowserWindow: { getAllWindows: vi.fn(() => []) },
      dialog: { showSaveDialog: vi.fn() },
      ipcMain: {
        handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
          handlers.set(channel, handler);
        }),
      },
    }));
    vi.doMock('../audio/AudioSession', () => ({
      getAudioSession: () => audioSession,
    }));
    vi.doMock('../audio/EqBridge', () => ({
      getEqBridge: () => ({
        getState: vi.fn(),
        setEnabled: vi.fn(),
        setBandGain: vi.fn(),
        setBandFrequency: vi.fn(),
        setPreamp: vi.fn(),
        setPreset: vi.fn(),
        reset: vi.fn(),
        savePreset: vi.fn(),
        exportPreset: vi.fn(),
        deletePreset: vi.fn(),
      }),
    }));
    vi.doMock('../audio/WindowsAudioServiceManager', () => ({
      restartWindowsAudioService: vi.fn(),
    }));
    vi.doMock('../diagnostics/CrashReportService', () => ({
      getCrashReportService: () => ({ reportAudioError }),
    }));

    const { IpcChannels } = await import('../../shared/constants/ipcChannels');
    const { registerAudioIpc } = await import('./audioIpc');
    registerAudioIpc();

    const result = handlers.get(IpcChannels.AudioSetOutput)?.({}, { outputMode: 'shared' }) as Promise<unknown>;
    await vi.advanceTimersByTimeAsync(AUDIO_COMMAND_TIMEOUT_MS + 100);

    await expect(result).resolves.toBe(status);
    expect(setOutput).toHaveBeenCalledWith(expect.objectContaining({ outputMode: 'shared' }));
    expect(reportAudioError).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('[audioIpc] audio command timed out; returning current status');
  });
});
