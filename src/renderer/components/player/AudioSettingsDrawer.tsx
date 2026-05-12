import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Gauge, Headphones, Lock, Radio, RefreshCw, SlidersHorizontal, Waves, X, Zap } from 'lucide-react';
import type { AudioDeviceInfo, AudioOutputMode, AudioOutputSettings, AudioStatus } from '../../../shared/types/audio';
import { createOutputSettings, readRememberedAudioOutput, writeRememberedAudioOutput } from './audioOutputMemory';

type AudioSettingsDrawerProps = {
  isOpen: boolean;
  status: AudioStatus | null;
  onClose: () => void;
  onStatusChange: (status: AudioStatus) => void;
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

const deviceMatchesStatus = (device: AudioDeviceInfo, status: AudioStatus | null, mode: AudioOutputMode): boolean => {
  if (!status || status.outputMode !== mode) {
    return false;
  }

  return status.outputDeviceId === device.id || status.outputDeviceName === device.name;
};

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

  const sharedDevices = useMemo(() => devices.filter((device) => device.outputMode === 'shared'), [devices]);
  const asioDevices = useMemo(() => devices.filter((device) => device.outputMode === 'asio'), [devices]);
  const wasapiExclusive = outputMode === 'exclusive';

  const engineBadges = useMemo(() => {
    const badges: string[] = [];
    const bitrate = formatBitrate(status?.bitrate);
    const hasEq = status?.dspActive || status?.eqEnabled || status?.warnings.some((warning) => /eq|equalizer/i.test(warning));

    if (bitrate) {
      badges.push(bitrate);
    }

    if (hasEq) {
      badges.push('EQ');
    }

    if (status?.resampling || status?.sampleRateMismatch) {
      badges.push('重采样');
    }

    return badges;
  }, [status?.bitrate, status?.dspActive, status?.eqEnabled, status?.resampling, status?.sampleRateMismatch, status?.warnings]);

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

    const timer = window.setTimeout(() => setShouldRender(false), 180);
    return () => window.clearTimeout(timer);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setRememberOutput(readRememberedAudioOutput().enabled);
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
    const currentDevice = sharedDevices.find((device) => deviceMatchesStatus(device, status, outputMode)) ?? null;
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

  if (!shouldRender) {
    return null;
  }

  return (
    <div className="audio-drawer-root no-drag" role="presentation" data-open={isOpen}>
      <button className="audio-drawer-scrim" type="button" aria-label="Close audio settings" onClick={onClose} />
      <aside className="audio-drawer" aria-label="音频设置">
        <header className="audio-drawer-header">
          <div>
            <SlidersHorizontal size={18} />
            <h2>音频设置</h2>
          </div>
          <button className="audio-drawer-close" type="button" aria-label="Close audio settings" title="Close" onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        <button className="audio-engine-strip" type="button" onClick={() => void refresh()} disabled={isBusy}>
          <Zap size={16} />
          <span>HiFi Engine</span>
          <strong>
            {engineBadges.map((badge) => (
              <em key={badge}>{badge}</em>
            ))}
          </strong>
          <RefreshCw size={14} />
        </button>

        <section className="audio-drawer-section">
          <div className="audio-drawer-section-title">
            <Headphones size={17} />
            <h3>输出设备</h3>
          </div>
          <button
            className={`audio-device-pill ${!status?.outputDeviceName && outputMode !== 'asio' ? 'active' : ''}`}
            type="button"
            disabled={isBusy}
            onClick={() => applyDevice(wasapiExclusive ? 'exclusive' : 'shared', null)}
          >
            <Waves size={15} />
            <span>系统默认</span>
            <em>{wasapiExclusive ? 'WASAPI' : 'Shared'}</em>
            {outputMode !== 'asio' && !status?.outputDeviceName ? <Check size={15} /> : null}
          </button>
          {sharedDevices.map((device) => {
            const isActive = deviceMatchesStatus(device, status, outputMode);

            return (
              <button
                className={`audio-device-pill ${isActive ? 'active' : ''}`}
                key={device.id}
                type="button"
                disabled={isBusy}
                onClick={() => applyDevice(wasapiExclusive ? 'exclusive' : 'shared', device)}
              >
                <Radio size={15} />
                <span>{device.name}</span>
                <em>{formatRate(device.sharedDeviceSampleRate ?? device.sampleRate)}</em>
                {isActive ? <Check size={15} /> : null}
              </button>
            );
          })}
        </section>

        <section className="audio-drawer-section audio-drawer-options">
          <label className="audio-toggle-row">
            <span>
              <Lock size={17} />
              <strong>WASAPI 独占模式</strong>
            </span>
            <input
              type="checkbox"
              checked={wasapiExclusive}
              onChange={(event) => toggleExclusive(event.currentTarget.checked)}
            />
          </label>
          <p>关闭时使用 Windows Shared 混音；开启后用同一设备请求独占输出。</p>

          <label className="audio-toggle-row">
            <span>
              <RefreshCw size={17} />
              <strong>记住输出设备</strong>
            </span>
            <input
              type="checkbox"
              checked={rememberOutput}
              onChange={(event) => toggleRememberOutput(event.currentTarget.checked)}
            />
          </label>
          <p>开启后，下次启动会恢复本次选择的设备与输出模式。</p>

          <div className="audio-buffer-options">
            <div className="audio-drawer-section-title">
              <Gauge size={17} />
              <h3>缓冲区配置</h3>
            </div>
            <button type="button">低延迟<span>256 frames</span></button>
            <button type="button" className="active">平衡<span>512 frames</span></button>
            <button type="button">稳定<span>1024 frames</span></button>
          </div>
        </section>

        <section className="audio-drawer-section">
          <div className="audio-drawer-section-title">
            <Zap size={17} />
            <h3>ASIO 输出设备</h3>
          </div>
          {asioDevices.length === 0 ? <p className="audio-drawer-empty">暂无 ASIO 设备</p> : null}
          {asioDevices.map((device) => {
            const isActive = deviceMatchesStatus(device, status, 'asio');

            return (
              <button
                className={`audio-device-pill ${isActive ? 'active' : ''}`}
                key={device.id}
                type="button"
                disabled={isBusy}
                onClick={() => applyDevice('asio', device)}
              >
                <Radio size={15} />
                <span>{device.name}</span>
                <em>ASIO</em>
                {isActive ? <Check size={15} /> : null}
              </button>
            );
          })}
        </section>

        {error ? <p className="audio-drawer-error">{error}</p> : null}
      </aside>
    </div>
  );
};
