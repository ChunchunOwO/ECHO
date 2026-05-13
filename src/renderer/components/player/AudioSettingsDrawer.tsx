import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MouseEvent } from 'react';
import {
  AudioLines,
  Check,
  EyeOff,
  Gauge,
  Headphones,
  Layers,
  Lock,
  Monitor,
  Music2,
  RefreshCw,
  Route,
  SlidersHorizontal,
  Usb,
  Volume2,
  Waves,
  X,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AudioDeviceInfo, AudioOutputMode, AudioOutputSettings, AudioStatus } from '../../../shared/types/audio';
import { createOutputSettings, readRememberedAudioOutput, writeRememberedAudioOutput } from './audioOutputMemory';

type AudioSettingsDrawerProps = {
  isOpen: boolean;
  status: AudioStatus | null;
  onClose: () => void;
  onStatusChange: (status: AudioStatus) => void;
};

type HiddenDeviceMenu = {
  device: AudioDeviceInfo;
  x: number;
  y: number;
} | null;

const hiddenDeviceStorageKey = 'echo-next.hidden-audio-devices';

const getDeviceStorageKey = (device: AudioDeviceInfo): string => `${device.outputMode}:${device.id || device.index}:${device.name}`;

const readHiddenDeviceKeys = (): string[] => {
  try {
    const raw = window.localStorage.getItem(hiddenDeviceStorageKey);
    const parsed = raw ? JSON.parse(raw) : [];

    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
};

const writeHiddenDeviceKeys = (keys: string[]): void => {
  try {
    window.localStorage.setItem(hiddenDeviceStorageKey, JSON.stringify(Array.from(new Set(keys))));
  } catch {
    // UI preference only; failure should never block audio settings.
  }
};

const formatRate = (value: number | null | undefined): string => {
  if (!value) {
    return '';
  }

  return value >= 1000 ? `${Math.round(value / 1000)} kHz` : `${value} Hz`;
};

const formatBitrate = (value: number | null | undefined): string | null => {
  if (!value) {
    return null;
  }

  return `${Math.round(value / 1000)} kbps`;
};

const formatMode = (mode: AudioOutputMode | null | undefined): string => {
  if (mode === 'asio') {
    return 'ASIO';
  }

  if (mode === 'exclusive') {
    return 'Exclusive';
  }

  return 'Shared';
};

const formatCodecLine = (status: AudioStatus | null): string => {
  const bitrate = formatBitrate(status?.bitrate);
  const codec = status?.codec?.toUpperCase() ?? 'No track';

  return [codec, bitrate].filter(Boolean).join(' / ');
};

const isHiResAudio = (status: AudioStatus | null): boolean =>
  status?.outputMode !== 'shared' && Boolean((status?.bitDepth && status.bitDepth >= 24) || (status?.fileSampleRate && status.fileSampleRate >= 88200));

const isLosslessCodec = (status: AudioStatus | null): boolean => {
  const codec = status?.codec?.toLocaleLowerCase();

  return Boolean(codec && ['flac', 'wav', 'wave', 'alac', 'aiff', 'ape'].some((losslessCodec) => codec.includes(losslessCodec)));
};

const formatSourceQuality = (status: AudioStatus | null): string => {
  const parts = [
    status?.codec?.toUpperCase() ?? null,
    status?.bitDepth ? `${status.bitDepth} bit` : null,
    formatRate(status?.fileSampleRate) || null,
  ].filter(Boolean);

  return parts.length ? parts.join(' / ') : 'No active source';
};

const getOutputSampleRate = (status: AudioStatus | null, deviceSampleRate?: number | null): number | null => {
  if (status?.outputMode === 'shared') {
    return deviceSampleRate ?? status.sharedDeviceSampleRate ?? status.actualDeviceSampleRate ?? status.requestedOutputSampleRate ?? null;
  }

  return status?.actualDeviceSampleRate ?? status?.requestedOutputSampleRate ?? status?.sharedDeviceSampleRate ?? null;
};

const hasInferredRateMismatch = (status: AudioStatus | null, deviceSampleRate?: number | null): boolean => {
  const fileSampleRate = status?.fileSampleRate ?? null;
  const outputSampleRate = getOutputSampleRate(status, deviceSampleRate);

  return Boolean(fileSampleRate && outputSampleRate && fileSampleRate !== outputSampleRate);
};

const formatRatePath = (status: AudioStatus | null, deviceSampleRate?: number | null): string => {
  const sourceRate = formatRate(status?.fileSampleRate);
  const outputRate = formatRate(getOutputSampleRate(status, deviceSampleRate));

  if (sourceRate && outputRate && sourceRate !== outputRate) {
    return `${sourceRate} -> ${outputRate}`;
  }

  return outputRate || sourceRate || 'Rate pending';
};

const getEqSignalText = (status: AudioStatus | null): string => {
  if (status?.eqEnabled) {
    return status.eqPresetName ? `EQ On / ${status.eqPresetName}` : 'EQ On';
  }

  if (status?.channelBalanceEnabled) {
    return 'Balance DSP';
  }

  if (status?.dspActive) {
    return 'DSP On';
  }

  return 'EQ Off';
};

const getResampleSignalText = (status: AudioStatus | null, deviceSampleRate?: number | null): string => {
  if (status?.resampling || status?.sampleRateMismatch || hasInferredRateMismatch(status, deviceSampleRate)) {
    return formatRatePath(status, deviceSampleRate);
  }

  if (status?.outputMode === 'shared') {
    return 'Shared Mixer';
  }

  return 'Native Rate';
};

const getDirectSignalText = (status: AudioStatus | null, deviceSampleRate?: number | null): string => {
  if (status?.outputMode === 'shared') {
    return 'Shared Mixer';
  }

  if (status?.bitPerfectCandidate) {
    return 'Bit-perfect';
  }

  if (status?.bitPerfectDisabledReason) {
    return status.bitPerfectDisabledReason.replaceAll('_', ' ');
  }

  if (
    status?.resampling ||
    status?.sampleRateMismatch ||
    hasInferredRateMismatch(status, deviceSampleRate) ||
    status?.dspActive ||
    status?.eqEnabled ||
    status?.channelBalanceEnabled
  ) {
    return 'Processed';
  }

  return 'Pending';
};

const deviceMatchesStatus = (device: AudioDeviceInfo, status: AudioStatus | null, mode: AudioOutputMode): boolean => {
  if (!status || status.outputMode !== mode) {
    return false;
  }

  return status.outputDeviceId === device.id || status.outputDeviceName === device.name;
};

const getDeviceIcon = (deviceName: string, outputMode: AudioOutputMode | AudioDeviceInfo['outputMode']): LucideIcon => {
  const name = deviceName.toLocaleLowerCase();

  if (outputMode === 'asio' || name.includes('asio')) {
    return Zap;
  }

  if (name.includes('default') || name.includes('system')) {
    return Waves;
  }

  if (name.includes('hdmi') || name.includes('monitor') || name.includes('display')) {
    return Monitor;
  }

  if (name.includes('headphone') || name.includes('headset') || name.includes('earphone') || name.includes('earbud')) {
    return Headphones;
  }

  if (name.includes('speaker') || name.includes('realtek')) {
    return Volume2;
  }

  if (
    name.includes('usb') ||
    name.includes('dac') ||
    name.includes('digital') ||
    name.includes('teac') ||
    name.includes('topping') ||
    name.includes('fiio')
  ) {
    return name.includes('usb') ? Usb : AudioLines;
  }

  if (name.includes('virtual') || name.includes('voicemeeter') || name.includes('motiv mix')) {
    return name.includes('virtual') ? Route : Layers;
  }

  return Music2;
};

const getCurrentOutputName = (status: AudioStatus | null): string => status?.outputDeviceName || 'System default output';

const getCurrentBackend = (status: AudioStatus | null): string => status?.outputBackend || status?.outputDeviceType || 'System audio';

export const AudioSettingsDrawer = ({
  isOpen,
  status,
  onClose,
  onStatusChange,
}: AudioSettingsDrawerProps): JSX.Element | null => {
  const [devices, setDevices] = useState<AudioDeviceInfo[]>([]);
  const [outputMode, setOutputMode] = useState<AudioOutputMode>(status?.outputMode ?? 'shared');
  const [rememberOutput, setRememberOutput] = useState(() => readRememberedAudioOutput().enabled);
  const [shouldRender, setShouldRender] = useState(isOpen);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [hiddenDeviceKeys, setHiddenDeviceKeys] = useState<string[]>(() => readHiddenDeviceKeys());
  const [hiddenDeviceMenu, setHiddenDeviceMenu] = useState<HiddenDeviceMenu>(null);

  const hiddenDeviceKeySet = useMemo(() => new Set(hiddenDeviceKeys), [hiddenDeviceKeys]);
  const visibleDevices = useMemo(
    () => devices.filter((device) => !hiddenDeviceKeySet.has(getDeviceStorageKey(device))),
    [devices, hiddenDeviceKeySet],
  );
  const hiddenDevices = useMemo(
    () => devices.filter((device) => hiddenDeviceKeySet.has(getDeviceStorageKey(device))),
    [devices, hiddenDeviceKeySet],
  );
  const allSharedDevices = useMemo(() => devices.filter((device) => device.outputMode === 'shared'), [devices]);
  const sharedDevices = useMemo(() => visibleDevices.filter((device) => device.outputMode === 'shared'), [visibleDevices]);
  const asioDevices = useMemo(() => visibleDevices.filter((device) => device.outputMode === 'asio'), [visibleDevices]);
  const wasapiExclusive = outputMode === 'exclusive';
  const statusDevice = useMemo(() => {
    if (!status) {
      return null;
    }

    return devices.find((device) => {
      const modeMatches = status.outputMode === 'asio' ? device.outputMode === 'asio' : device.outputMode === 'shared';
      return modeMatches && (status.outputDeviceId === device.id || status.outputDeviceName === device.name);
    }) ?? null;
  }, [devices, status]);
  const effectiveSharedSampleRate = status?.outputMode === 'shared' ? statusDevice?.sharedDeviceSampleRate ?? statusDevice?.sampleRate ?? null : null;

  const engineBadges = useMemo(() => {
    const badges: Array<{ label: string; tone: 'ready' | 'warning' | 'neutral' | 'gold' }> = [];
    const hasEq = status?.dspActive || status?.eqEnabled || status?.warnings.some((warning) => /eq|equalizer/i.test(warning));

    if (hasEq) {
      badges.push({ label: 'DSP active', tone: 'neutral' });
    }

    if (isHiResAudio(status)) {
      badges.push({ label: 'Hi-Res', tone: 'gold' });
    } else if (isLosslessCodec(status)) {
      badges.push({ label: 'Lossless', tone: 'gold' });
    }

    if (status?.bitPerfectCandidate) {
      badges.push({ label: 'Bit-perfect ready', tone: 'ready' });
    }

    if (status?.resampling || status?.sampleRateMismatch) {
      badges.push({ label: 'Resampling', tone: 'warning' });
    }

    if (hasInferredRateMismatch(status, effectiveSharedSampleRate) && !badges.some((badge) => badge.label === 'Resampling')) {
      badges.push({ label: 'Resampling', tone: 'warning' });
    }

    return badges;
  }, [effectiveSharedSampleRate, status]);

  const engineSignalDetails = useMemo(
    () => [
      { label: 'Source', value: formatSourceQuality(status) },
      { label: 'EQ', value: getEqSignalText(status) },
      { label: 'Resample', value: getResampleSignalText(status, effectiveSharedSampleRate) },
      { label: 'Direct', value: getDirectSignalText(status, effectiveSharedSampleRate) },
    ],
    [effectiveSharedSampleRate, status],
  );
  const engineRatePath = useMemo(() => formatRatePath(status, effectiveSharedSampleRate), [effectiveSharedSampleRate, status]);

  const currentOutput = useMemo(() => {
    const currentMode = status?.outputMode ?? outputMode;
    const name = getCurrentOutputName(status);

    return {
      name,
      mode: currentMode,
      backend: getCurrentBackend(status),
      sampleRate: formatRate(getOutputSampleRate(status, effectiveSharedSampleRate)),
      bitPerfect: status?.bitPerfectCandidate ? 'Bit-perfect ready' : status?.bitPerfectDisabledReason ?? 'Standard path',
      Icon: getDeviceIcon(name, currentMode),
    };
  }, [effectiveSharedSampleRate, outputMode, status]);

  const refresh = useCallback(async (): Promise<void> => {
    const audio = window.echo?.audio;

    if (!audio) {
      setError('Desktop bridge unavailable');
      setDevices([]);
      return;
    }

    try {
      const [nextDevices, nextStatus] = await Promise.all([audio.listDevices(), audio.getStatus()]);
      setDevices(nextDevices);
      setOutputMode(nextStatus.outputMode);
      onStatusChange(nextStatus);
      setError(null);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    }
  }, [onStatusChange]);

  useEffect(() => {
    if (isOpen) {
      setShouldRender(true);
      return undefined;
    }

    const timer = window.setTimeout(() => setShouldRender(false), 320);
    return () => window.clearTimeout(timer);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setRememberOutput(readRememberedAudioOutput().enabled);
    setHiddenDeviceKeys(readHiddenDeviceKeys());
    void refresh();
  }, [isOpen, refresh]);

  useEffect(() => {
    if (status?.outputMode) {
      setOutputMode(status.outputMode);
    }
  }, [status?.outputMode]);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen || !hiddenDeviceMenu) {
      return undefined;
    }

    const closeMenu = (): void => setHiddenDeviceMenu(null);

    window.addEventListener('click', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
    return () => {
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
    };
  }, [hiddenDeviceMenu, isOpen]);

  const persistOutput = useCallback(
    (settings: AudioOutputSettings, enabled = rememberOutput): void => {
      writeRememberedAudioOutput({
        enabled,
        outputMode: settings.outputMode ?? 'shared',
        deviceIndex: settings.deviceIndex,
        deviceName: settings.deviceName,
      });
    },
    [rememberOutput],
  );

  const applyOutput = useCallback(
    async (settings: AudioOutputSettings): Promise<void> => {
      const audio = window.echo?.audio;

      if (!audio) {
        setError('Desktop bridge unavailable');
        return;
      }

      setIsBusy(true);
      setError(null);
      try {
        if (rememberOutput) {
          persistOutput(settings);
        }
        const nextStatus = await audio.setOutput(settings);
        setOutputMode(nextStatus.outputMode);
        onStatusChange(nextStatus);
      } catch (applyError) {
        setError(applyError instanceof Error ? applyError.message : String(applyError));
      } finally {
        setIsBusy(false);
      }
    },
    [onStatusChange, persistOutput, rememberOutput],
  );

  const applyDevice = (mode: AudioOutputMode, device: AudioDeviceInfo | null): void => {
    const settings = createOutputSettings(mode, device);
    setOutputMode(mode);
    void applyOutput(settings);
  };

  const toggleExclusive = (enabled: boolean): void => {
    const nextMode: AudioOutputMode = enabled ? 'exclusive' : 'shared';
    const currentDevice = allSharedDevices.find((device) => deviceMatchesStatus(device, status, outputMode)) ?? null;
    applyDevice(nextMode, currentDevice);
  };

  const toggleRememberOutput = (enabled: boolean): void => {
    setRememberOutput(enabled);
    writeRememberedAudioOutput({
      enabled,
      outputMode: status?.outputMode ?? outputMode,
      deviceName: status?.outputDeviceName ?? undefined,
    });
  };

  const hideDevice = (device: AudioDeviceInfo): void => {
    setHiddenDeviceKeys((currentKeys) => {
      const nextKeys = Array.from(new Set([...currentKeys, getDeviceStorageKey(device)]));
      writeHiddenDeviceKeys(nextKeys);
      return nextKeys;
    });
    setHiddenDeviceMenu(null);
  };

  const restoreDevice = (device: AudioDeviceInfo): void => {
    setHiddenDeviceKeys((currentKeys) => {
      const nextKeys = currentKeys.filter((key) => key !== getDeviceStorageKey(device));
      writeHiddenDeviceKeys(nextKeys);
      return nextKeys;
    });
  };

  const openDeviceMenu = (event: MouseEvent<HTMLButtonElement>, device: AudioDeviceInfo): void => {
    event.preventDefault();
    event.stopPropagation();
    setHiddenDeviceMenu({
      device,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 190)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 72)),
    });
  };

  const suppressNativeDeviceMenu = (event: MouseEvent<HTMLButtonElement>): void => {
    if (event.button !== 2) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  };

  if (!shouldRender) {
    return null;
  }

  return (
    <div className="audio-drawer-root no-drag" role="presentation" data-open={isOpen}>
      <button className="audio-drawer-scrim" type="button" aria-label="Close audio settings" onClick={onClose} />
      <aside className="audio-drawer" aria-label="Audio settings">
        <header className="audio-drawer-header">
          <div>
            <SlidersHorizontal size={18} />
            <h2>Audio Settings</h2>
          </div>
          <button className="audio-drawer-close" type="button" aria-label="Close audio settings" title="Close" onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        <button className="audio-engine-meter" type="button" onClick={() => void refresh()} disabled={isBusy}>
          <div className="audio-engine-meter__top">
            <span className="audio-engine-meter__icon">
              <Zap size={17} />
            </span>
            <div>
              <span>HiFi Engine</span>
              <strong>{formatCodecLine(status)}</strong>
            </div>
            <RefreshCw size={15} />
          </div>
          <div className="audio-engine-meter__grid">
            <span>
              <em>Output</em>
              <strong title={getCurrentOutputName(status)}>{getCurrentOutputName(status)}</strong>
            </span>
            <span>
              <em>Mode</em>
              <strong>{formatMode(status?.outputMode ?? outputMode)}</strong>
            </span>
            <span>
              <em>Rate</em>
              <strong>{engineRatePath}</strong>
            </span>
          </div>
          <div className="audio-engine-meter__details">
            {engineSignalDetails.map((detail) => (
              <span key={detail.label}>
                <em>{detail.label}</em>
                <strong title={detail.value}>{detail.value}</strong>
              </span>
            ))}
          </div>
          {engineBadges.length ? (
            <div className="audio-engine-meter__badges">
              {engineBadges.map((badge) => (
                <em data-tone={badge.tone} key={badge.label}>
                  {badge.label}
                </em>
              ))}
            </div>
          ) : null}
        </button>

        <section className="audio-drawer-section audio-current-output-section">
          <div className="audio-drawer-section-title">
            <Headphones size={17} />
            <h3>Current Output</h3>
          </div>
          <div className="audio-current-output-card">
            <span className="audio-current-output-card__icon">
              <currentOutput.Icon size={22} />
            </span>
            <div className="audio-current-output-card__body">
              <strong title={currentOutput.name}>{currentOutput.name}</strong>
              <span>
                {formatMode(currentOutput.mode)} / {currentOutput.sampleRate || 'Rate pending'}
              </span>
              <span>
                {currentOutput.backend} / {currentOutput.bitPerfect}
              </span>
            </div>
            <em>Selected</em>
          </div>
        </section>

        <section className="audio-drawer-section">
          <div className="audio-drawer-section-title">
            <Waves size={17} />
            <h3>System Output Devices</h3>
          </div>
          <button
            className={`audio-device-pill ${!status?.outputDeviceName && outputMode !== 'asio' ? 'active' : ''}`}
            type="button"
            title="System default output"
            disabled={isBusy}
            onClick={() => applyDevice(wasapiExclusive ? 'exclusive' : 'shared', null)}
          >
            <Waves size={15} />
            <span>
              <strong>System default</strong>
              <small>{wasapiExclusive ? 'Exclusive candidate' : 'Shared'} / System selected route</small>
            </span>
            <em>{wasapiExclusive ? 'Exclusive' : 'Shared'}</em>
            {outputMode !== 'asio' && !status?.outputDeviceName ? <Check size={15} /> : null}
          </button>
          {sharedDevices.length === 0 ? <p className="audio-drawer-empty">No system output devices found.</p> : null}
          {sharedDevices.map((device) => {
            const isActive = deviceMatchesStatus(device, status, outputMode);
            const DeviceIcon = getDeviceIcon(device.name, wasapiExclusive ? 'exclusive' : 'shared');
            const sampleRate = formatRate(device.sharedDeviceSampleRate ?? device.sampleRate);

            return (
              <button
                className={`audio-device-pill ${isActive ? 'active' : ''}`}
                key={device.id}
                type="button"
                title={device.name}
                disabled={isBusy}
                onMouseDown={suppressNativeDeviceMenu}
                onContextMenu={(event) => openDeviceMenu(event, device)}
                onClick={() => applyDevice(wasapiExclusive ? 'exclusive' : 'shared', device)}
              >
                <DeviceIcon size={15} />
                <span>
                  <strong>{device.name}</strong>
                  <small>{wasapiExclusive ? 'Exclusive candidate' : 'Shared'} / {sampleRate || 'Sample rate pending'}</small>
                </span>
                <em>{sampleRate || (wasapiExclusive ? 'Exclusive' : 'Shared')}</em>
                {isActive ? <Check size={15} /> : null}
              </button>
            );
          })}
        </section>

        <section className="audio-drawer-section">
          <div className="audio-drawer-section-title">
            <Zap size={17} />
            <h3>ASIO Output Devices</h3>
          </div>
          <p className="audio-section-note">低延迟专业音频接口，需要驱动支持。</p>
          {asioDevices.length === 0 ? <p className="audio-drawer-empty">No ASIO output devices found.</p> : null}
          {asioDevices.map((device) => {
            const isActive = deviceMatchesStatus(device, status, 'asio');
            const DeviceIcon = getDeviceIcon(device.name, 'asio');

            return (
              <button
                className={`audio-device-pill audio-device-pill--asio ${isActive ? 'active' : ''}`}
                key={device.id}
                type="button"
                title={device.name}
                disabled={isBusy}
                onMouseDown={suppressNativeDeviceMenu}
                onContextMenu={(event) => openDeviceMenu(event, device)}
                onClick={() => applyDevice('asio', device)}
              >
                <DeviceIcon size={15} />
                <span>
                  <strong>{device.name}</strong>
                  <small>ASIO driver / Low latency</small>
                </span>
                <em>ASIO</em>
                {isActive ? <Check size={15} /> : null}
              </button>
            );
          })}
        </section>

        <section className="audio-drawer-section audio-drawer-options audio-drawer-options--open">
          <div className="audio-drawer-section-title">
            <Gauge size={17} />
            <h3>Advanced Output</h3>
          </div>

          <label className="audio-toggle-row">
            <span>
              <Lock size={17} />
              <strong>WASAPI Exclusive Mode</strong>
            </span>
            <input
              type="checkbox"
              checked={wasapiExclusive}
              onChange={(event) => toggleExclusive(event.currentTarget.checked)}
            />
          </label>
          <p>Shared is the everyday Windows path. Exclusive requests the same device without the shared mixer.</p>

          <label className="audio-toggle-row">
            <span>
              <RefreshCw size={17} />
              <strong>Remember Output Device</strong>
            </span>
            <input
              type="checkbox"
              checked={rememberOutput}
              onChange={(event) => toggleRememberOutput(event.currentTarget.checked)}
            />
          </label>
          <p>Restores the selected output device and mode on the next launch.</p>

          <div className="audio-advanced-todo">
            <strong>Target sample rate and buffer controls</strong>
            <span>TODO: wire to real audio settings when DeviceService exposes safe controls.</span>
          </div>
        </section>

        {error ? <p className="audio-drawer-error">{error}</p> : null}

        <details className="audio-drawer-section audio-hidden-devices">
          <summary>
            <EyeOff size={17} />
            <span>Hidden Devices</span>
            <em>{hiddenDevices.length}</em>
          </summary>
          {hiddenDevices.length === 0 ? <p className="audio-drawer-empty">No hidden devices.</p> : null}
          {hiddenDevices.map((device) => {
            const DeviceIcon = getDeviceIcon(device.name, device.outputMode);
            const sampleRate = formatRate(device.sharedDeviceSampleRate ?? device.sampleRate);

            return (
              <div className={`audio-hidden-device ${device.outputMode === 'asio' ? 'audio-hidden-device--asio' : ''}`} key={getDeviceStorageKey(device)}>
                <DeviceIcon size={15} />
                <span>
                  <strong title={device.name}>{device.name}</strong>
                  <small>{device.outputMode === 'asio' ? 'ASIO driver' : 'System output'} / {sampleRate || 'Sample rate pending'}</small>
                </span>
                <button type="button" onClick={() => restoreDevice(device)}>
                  Restore
                </button>
              </div>
            );
          })}
        </details>

      </aside>
      {hiddenDeviceMenu ? (
        <div
          className="audio-device-context-menu"
          role="menu"
          style={{ left: hiddenDeviceMenu.x, top: hiddenDeviceMenu.y }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button type="button" role="menuitem" onClick={() => hideDevice(hiddenDeviceMenu.device)}>
            <EyeOff size={14} />
            <span>Hide device</span>
          </button>
        </div>
      ) : null}
    </div>
  );
};
