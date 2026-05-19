import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Cast, Loader2, Pause, Play, Power, RefreshCw, Smartphone, Square, Unplug, Volume2, Wifi } from 'lucide-react';
import type { AppSettings } from '../../shared/types/appSettings';
import type { AirPlayReceiverStatus, ConnectDevice, ConnectReceiverStatus, ConnectSessionStatus } from '../../shared/types/connect';
import { usePlaybackQueue } from '../stores/PlaybackQueueProvider';
import { useSharedPlaybackStatus } from '../stores/playbackStatusStore';

const defaultStatus: ConnectSessionStatus = {
  deviceId: null,
  protocol: null,
  state: 'idle',
  currentTrackId: null,
  metadata: null,
  positionSeconds: 0,
  durationSeconds: 0,
  latencyMs: null,
  error: null,
  updatedAt: new Date(0).toISOString(),
};

const defaultReceiverStatus: ConnectReceiverStatus = {
  enabled: false,
  state: 'disabled',
  advertisedName: 'ECHO Next',
  addresses: [],
  currentClient: null,
  currentUri: null,
  metadata: null,
  positionSeconds: 0,
  durationSeconds: 0,
  volume: 100,
  error: null,
  debugEvents: [],
  updatedAt: new Date(0).toISOString(),
};

const defaultAirPlayReceiverStatus: AirPlayReceiverStatus = {
  enabled: false,
  state: 'disabled',
  advertisedName: 'ECHO Next (AirPlay)',
  nativeAvailable: false,
  currentSourceId: null,
  currentClient: null,
  metadata: null,
  currentLyricLine: null,
  artworkUrl: null,
  positionSeconds: 0,
  durationSeconds: 0,
  volume: 100,
  error: null,
  debugEvents: [],
  updatedAt: new Date(0).toISOString(),
};

const stateLabel: Record<ConnectSessionStatus['state'], string> = {
  idle: '待机',
  discovering: '扫描设备',
  connecting: '连接中',
  ready: '就绪',
  playing: '投送中',
  paused: '已暂停',
  stopped: '已停止',
  error: '错误',
  unsupported: '暂不可用',
};

const deviceStateLabel: Record<ConnectDevice['state'], string> = {
  available: '可用',
  connecting: '连接中',
  connected: '已连接',
  unavailable: '离线',
  unsupported: '实验',
};

const receiverStateLabel: Record<ConnectReceiverStatus['state'], string> = {
  disabled: '未开启',
  idle: '等待手机',
  ready: '已接收媒体',
  loading: '加载中',
  playing: '手机投送中',
  paused: '已暂停',
  stopped: '已停止',
  error: '错误',
};

const airPlayStateLabel: Record<AirPlayReceiverStatus['state'], string> = {
  disabled: '未开启',
  unavailable: '原生后端不可用',
  idle: '等待 iPhone',
  starting: '启动中',
  ready: '已连接',
  playing: 'AirPlay 播放中',
  paused: '已暂停',
  stopped: '已停止',
  error: '错误',
};

const formatTime = (seconds: number): string => {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = String(safe % 60).padStart(2, '0');
  return `${minutes}:${rest}`;
};

const formatProtocol = (device: Pick<ConnectDevice, 'protocol'>): string =>
  device.protocol === 'dlna' ? 'DLNA / UPnP' : 'AirPlay';

const formatReceiverAddress = (value: string): string => {
  try {
    const url = new URL(value);
    return `${url.hostname}:${url.port}`;
  } catch {
    return value;
  }
};

export const ConnectPage = (): JSX.Element => {
  const queue = usePlaybackQueue();
  const playbackStatus = useSharedPlaybackStatus();
  const [devices, setDevices] = useState<ConnectDevice[]>([]);
  const [status, setStatus] = useState<ConnectSessionStatus>(defaultStatus);
  const [receiverStatus, setReceiverStatus] = useState<ConnectReceiverStatus>(defaultReceiverStatus);
  const [airPlayReceiverStatus, setAirPlayReceiverStatus] = useState<AirPlayReceiverStatus>(defaultAirPlayReceiverStatus);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isReceiverBusy, setIsReceiverBusy] = useState(false);
  const [isAirPlayReceiverBusy, setIsAirPlayReceiverBusy] = useState(false);
  const [isAutoStartBusy, setIsAutoStartBusy] = useState(false);
  const [autoStartReceiversEnabled, setAutoStartReceiversEnabled] = useState(false);
  const [busyDeviceId, setBusyDeviceId] = useState<string | null>(null);
  const [isCommandBusy, setIsCommandBusy] = useState(false);
  const [volumePercent, setVolumePercent] = useState(80);

  const activeDevice = useMemo(
    () => devices.find((device) => device.id === status.deviceId) ?? null,
    [devices, status.deviceId],
  );
  const currentTrack = queue.currentTrack ?? queue.lastPlayedTrack ?? null;
  const currentFilePath =
    currentTrack?.path ??
    playbackStatus.audioStatus?.currentFilePath ??
    playbackStatus.playbackStatus?.filePath ??
    null;
  const currentPositionSeconds =
    playbackStatus.audioStatus?.positionSeconds ??
    (playbackStatus.playbackStatus?.positionMs ?? 0) / 1000;
  const previewTitle = status.metadata?.title ?? currentTrack?.title ?? (currentFilePath ? currentFilePath.split(/[\\/]/u).pop() : '没有当前歌曲');
  const previewArtist = status.metadata?.artist ?? currentTrack?.artist ?? currentTrack?.albumArtist ?? 'Unknown Artist';
  const previewAlbum = status.metadata?.album ?? currentTrack?.album ?? null;
  const previewCover = status.metadata?.coverHttpUrl ?? currentTrack?.coverThumb ?? null;
  const progressPercent =
    status.durationSeconds > 0 ? Math.min(100, Math.max(0, (status.positionSeconds / status.durationSeconds) * 100)) : 0;
  const receiverTitle =
    receiverStatus.metadata?.title ??
    (receiverStatus.currentUri ? receiverStatus.currentUri.split(/[?#]/u)[0]?.split(/[\\/]/u).pop() : null) ??
    '等待手机投送';
  const receiverArtist = receiverStatus.metadata?.artist ?? 'Unknown Artist';
  const receiverAlbum = receiverStatus.metadata?.album ?? null;
  const receiverCover = receiverStatus.metadata?.coverHttpUrl || null;
  const receiverProgressPercent =
    receiverStatus.durationSeconds > 0
      ? Math.min(100, Math.max(0, (receiverStatus.positionSeconds / receiverStatus.durationSeconds) * 100))
      : 0;
  const airPlayTitle = airPlayReceiverStatus.metadata?.title ?? '等待 iPhone 投送';
  const airPlayArtist = airPlayReceiverStatus.metadata?.artist ?? 'Unknown Artist';
  const airPlayAlbum = airPlayReceiverStatus.metadata?.album ?? null;
  const airPlayCover = airPlayReceiverStatus.artworkUrl || airPlayReceiverStatus.metadata?.coverHttpUrl || null;
  const airPlayProgressPercent =
    airPlayReceiverStatus.durationSeconds > 0
      ? Math.min(100, Math.max(0, (airPlayReceiverStatus.positionSeconds / airPlayReceiverStatus.durationSeconds) * 100))
      : 0;

  const refreshDevices = useCallback(async (): Promise<void> => {
    const connect = window.echo?.connect;
    if (!connect) {
      setError('Desktop bridge unavailable. 请在 Electron 桌面端使用 Connect。');
      return;
    }

    setIsRefreshing(true);
    setError(null);
    try {
      setDevices(await connect.refresh());
      setStatus(await connect.getStatus());
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const connect = window.echo?.connect;
    if (!connect) {
      return;
    }

    let disposed = false;
    void connect
      .listDevices()
      .then((items) => {
        if (!disposed) {
          setDevices(items);
        }
      })
      .catch(() => undefined);
    void connect
      .getStatus()
      .then((nextStatus) => {
        if (!disposed) {
          setStatus(nextStatus);
        }
      })
      .catch(() => undefined);
    if (connect.getReceiverStatus) {
      void connect.getReceiverStatus().then((nextStatus) => {
        if (!disposed) {
          setReceiverStatus(nextStatus);
        }
      }).catch(() => undefined);
    }
    if (connect.getAirPlayReceiverStatus) {
      void connect.getAirPlayReceiverStatus().then((nextStatus) => {
        if (!disposed) {
          setAirPlayReceiverStatus(nextStatus);
        }
      }).catch(() => undefined);
    }
    void window.echo?.app?.getSettings?.().then((settings: AppSettings) => {
      if (!disposed) {
        setAutoStartReceiversEnabled(settings.connectAutoStartReceiversEnabled === true);
      }
    }).catch(() => undefined);
    void refreshDevices();
    const unsubscribe = connect.onStatus((nextStatus) => {
      setStatus(nextStatus);
      if (nextStatus.error) {
        setError(nextStatus.error);
      }
    });
    const unsubscribeReceiver = connect.onReceiverStatus?.((nextStatus) => {
      setReceiverStatus(nextStatus);
      if (nextStatus.error) {
        setError(nextStatus.error);
      }
    }) ?? (() => undefined);
    const unsubscribeAirPlayReceiver = connect.onAirPlayReceiverStatus?.((nextStatus) => {
      setAirPlayReceiverStatus(nextStatus);
      if (nextStatus.error) {
        setError(nextStatus.error);
      }
    }) ?? (() => undefined);

    return () => {
      disposed = true;
      unsubscribe();
      unsubscribeReceiver();
      unsubscribeAirPlayReceiver();
    };
  }, [refreshDevices]);

  const toggleAutoStartReceivers = useCallback(async (): Promise<void> => {
    const app = window.echo?.app;
    if (!app?.setSettings) {
      setError('Desktop bridge unavailable. 请在 Electron 桌面端保存 Connect 设置。');
      return;
    }

    const connectAutoStartReceiversEnabled = !autoStartReceiversEnabled;
    setIsAutoStartBusy(true);
    setError(null);
    try {
      const settings = await app.setSettings({ connectAutoStartReceiversEnabled });
      setAutoStartReceiversEnabled(settings.connectAutoStartReceiversEnabled === true);
      window.dispatchEvent(new CustomEvent('settings:changed', { detail: { connectAutoStartReceiversEnabled } }));
    } catch (settingsError) {
      setError(settingsError instanceof Error ? settingsError.message : String(settingsError));
    } finally {
      setIsAutoStartBusy(false);
    }
  }, [autoStartReceiversEnabled]);

  const toggleReceiver = useCallback(async (): Promise<void> => {
    const connect = window.echo?.connect;
    if (!connect?.setReceiverEnabled) {
      setError('Desktop bridge unavailable. 请在 Electron 桌面端使用 Connect。');
      return;
    }

    setIsReceiverBusy(true);
    setError(null);
    try {
      setReceiverStatus(await connect.setReceiverEnabled(!receiverStatus.enabled));
    } catch (receiverError) {
      setError(receiverError instanceof Error ? receiverError.message : String(receiverError));
    } finally {
      setIsReceiverBusy(false);
    }
  }, [receiverStatus.enabled]);

  const stopReceiverPlayback = useCallback(async (): Promise<void> => {
    const connect = window.echo?.connect;
    setIsReceiverBusy(true);
    setError(null);
    try {
      if (connect?.stopReceiverPlayback) {
        setReceiverStatus(await connect.stopReceiverPlayback());
      } else {
        await window.echo?.playback.stop();
        if (connect?.getReceiverStatus) {
          setReceiverStatus(await connect.getReceiverStatus());
        }
      }
    } catch (receiverError) {
      setError(receiverError instanceof Error ? receiverError.message : String(receiverError));
    } finally {
      setIsReceiverBusy(false);
    }
  }, []);

  const toggleAirPlayReceiver = useCallback(async (): Promise<void> => {
    const connect = window.echo?.connect;
    if (!connect?.setAirPlayReceiverEnabled) {
      setError('AirPlay receiver bridge unavailable.');
      return;
    }

    setIsAirPlayReceiverBusy(true);
    setError(null);
    try {
      setAirPlayReceiverStatus(await connect.setAirPlayReceiverEnabled(!airPlayReceiverStatus.enabled));
    } catch (receiverError) {
      setError(receiverError instanceof Error ? receiverError.message : String(receiverError));
    } finally {
      setIsAirPlayReceiverBusy(false);
    }
  }, [airPlayReceiverStatus.enabled]);

  const stopAirPlayReceiverPlayback = useCallback(async (): Promise<void> => {
    const connect = window.echo?.connect;
    if (!connect?.stopAirPlayReceiverPlayback) {
      setError('AirPlay receiver bridge unavailable.');
      return;
    }

    setIsAirPlayReceiverBusy(true);
    setError(null);
    try {
      setAirPlayReceiverStatus(await connect.stopAirPlayReceiverPlayback());
    } catch (receiverError) {
      setError(receiverError instanceof Error ? receiverError.message : String(receiverError));
    } finally {
      setIsAirPlayReceiverBusy(false);
    }
  }, []);

  const connectDevice = useCallback(
    async (device: ConnectDevice): Promise<void> => {
      const connect = window.echo?.connect;
      if (!connect) {
        setError('Desktop bridge unavailable. 请在 Electron 桌面端使用 Connect。');
        return;
      }

      if (!currentTrack && !currentFilePath) {
        setError('请先播放或选中一首歌，Connect 不允许空元数据投送。');
        return;
      }

      setBusyDeviceId(device.id);
      setError(null);
      try {
        const nextStatus = await connect.connect({
          deviceId: device.id,
          track: currentTrack,
          filePath: currentFilePath,
          positionSeconds: currentPositionSeconds,
        });
        setStatus(nextStatus);
      } catch (connectError) {
        setError(connectError instanceof Error ? connectError.message : String(connectError));
      } finally {
        setBusyDeviceId(null);
      }
    },
    [currentFilePath, currentPositionSeconds, currentTrack],
  );

  const runCommand = useCallback(async (command: 'play' | 'pause' | 'stop' | 'disconnect'): Promise<void> => {
    const connect = window.echo?.connect;
    if (!connect) {
      setError('Desktop bridge unavailable. 请在 Electron 桌面端使用 Connect。');
      return;
    }

    setIsCommandBusy(true);
    setError(null);
    try {
      const nextStatus = await connect[command]();
      setStatus(nextStatus);
    } catch (commandError) {
      setError(commandError instanceof Error ? commandError.message : String(commandError));
    } finally {
      setIsCommandBusy(false);
    }
  }, []);

  const commitVolume = useCallback(async (nextVolume: number): Promise<void> => {
    const connect = window.echo?.connect;
    if (!connect) {
      return;
    }

    setVolumePercent(nextVolume);
    try {
      setStatus(await connect.setVolume(nextVolume));
    } catch (volumeError) {
      setError(volumeError instanceof Error ? volumeError.message : String(volumeError));
    }
  }, []);

  return (
    <div className="connect-page">
      <header className="connect-header">
        <div>
          <p className="section-kicker">Wireless Playback</p>
          <h1>Connect</h1>
          <p>DLNA 稳定投送优先；AirPlay 在元数据验收通过前保持实验不可用。</p>
        </div>
        <div className="connect-header-actions">
          <div className="settings-inline-toggle connect-autostart-toggle">
            <span>启动时自动开启 AirPlay / DLNA</span>
            <button
              aria-label="启动时自动开启 AirPlay / DLNA"
              aria-pressed={autoStartReceiversEnabled}
              className={`toggle-btn ${autoStartReceiversEnabled ? 'active' : ''}`}
              disabled={isAutoStartBusy}
              type="button"
              onClick={() => void toggleAutoStartReceivers()}
            >
              <span />
            </button>
          </div>
          <button className="settings-action-button" type="button" onClick={() => void refreshDevices()} disabled={isRefreshing}>
            {isRefreshing ? <Loader2 className="spinning-icon" size={16} /> : <RefreshCw size={16} />}
            刷新设备
          </button>
        </div>
      </header>

      {error ? (
        <div className="connect-alert" role="alert">
          <AlertTriangle size={17} />
          <span>{error}</span>
        </div>
      ) : null}

      <section className="connect-receiver-panel" aria-label="接收来自手机">
        <div className="connect-section-title">
          <div>
            <span>Receiver</span>
            <h2>接收来自手机</h2>
          </div>
          <button className="settings-action-button" type="button" onClick={() => void toggleReceiver()} disabled={isReceiverBusy}>
            {isReceiverBusy ? <Loader2 className="spinning-icon" size={16} /> : <Power size={16} />}
            {receiverStatus.enabled ? '关闭接收' : '开启接收'}
          </button>
        </div>
        <div className="connect-receiver-body">
          <div className="connect-artwork" data-empty={!receiverCover}>
            {receiverCover ? <img alt="" src={receiverCover} /> : <Smartphone size={42} />}
          </div>
          <div className="connect-now-copy">
            <span>{receiverStateLabel[receiverStatus.state]}</span>
            <h2>{receiverTitle}</h2>
            <p>{receiverArtist}{receiverAlbum ? ` · ${receiverAlbum}` : ''}</p>
            <div className="connect-progress" aria-label="接收播放进度">
              <span style={{ width: `${receiverProgressPercent}%` }} />
            </div>
            <small>
              {formatTime(receiverStatus.positionSeconds)} / {formatTime(receiverStatus.durationSeconds)}
            </small>
          </div>
          <div className="connect-receiver-meta">
            <span>{receiverStatus.advertisedName}</span>
            <small>{receiverStatus.currentClient ? `来自 ${receiverStatus.currentClient.address}` : '未连接手机'}</small>
            <small>
              {receiverStatus.addresses.length > 0
                ? receiverStatus.addresses.map(formatReceiverAddress).join(' / ')
                : receiverStatus.enabled
                  ? '正在准备局域网地址'
                  : '开启后手机可发现'}
            </small>
          </div>
          <button
            className="settings-action-button"
            type="button"
            onClick={() => void stopReceiverPlayback()}
            disabled={isReceiverBusy || !receiverStatus.currentUri}
          >
            <Square size={15} />
            停止接收播放
          </button>
        </div>
        <details className="connect-receiver-debug" aria-label="DLNA request log">
          <summary>
            <span>DLNA Debug</span>
            <small>{receiverStatus.debugEvents.length > 0 ? `${receiverStatus.debugEvents.length} recent` : 'No requests'}</small>
          </summary>
          <div className="connect-receiver-debug__items">
            {receiverStatus.debugEvents.length > 0 ? (
              receiverStatus.debugEvents.slice(0, 6).map((event) => (
                <code key={event.id}>
                  {new Date(event.at).toLocaleTimeString()} {event.remoteAddress ?? '-'} {event.method} {event.path}
                  {event.action ? ` #${event.action}` : ''} {event.statusCode ?? '-'}
                  {event.message ? ` ${event.message}` : ''}
                </code>
              ))
            ) : (
              <small>No DLNA requests yet</small>
            )}
          </div>
        </details>
      </section>

      <section className="connect-receiver-panel" aria-label="AirPlay 实验接收">
        <div className="connect-section-title">
          <div>
            <span>AirPlay Spike</span>
            <h2>接收来自 iPhone</h2>
          </div>
          <button className="settings-action-button" type="button" onClick={() => void toggleAirPlayReceiver()} disabled={isAirPlayReceiverBusy}>
            {isAirPlayReceiverBusy ? <Loader2 className="spinning-icon" size={16} /> : <Power size={16} />}
            {airPlayReceiverStatus.enabled ? '关闭 AirPlay' : '开启 AirPlay'}
          </button>
        </div>
        <div className="connect-receiver-body">
          <div className="connect-artwork" data-empty={!airPlayCover}>
            {airPlayCover ? <img alt="" src={airPlayCover} /> : <Cast size={42} />}
          </div>
          <div className="connect-now-copy">
            <span>{airPlayStateLabel[airPlayReceiverStatus.state]}</span>
            <h2>{airPlayTitle}</h2>
            <p>{airPlayArtist}{airPlayAlbum ? ` 路 ${airPlayAlbum}` : ''}</p>
            <div className="connect-progress" aria-label="AirPlay 播放进度">
              <span style={{ width: `${airPlayProgressPercent}%` }} />
            </div>
            <small>
              {formatTime(airPlayReceiverStatus.positionSeconds)} / {formatTime(airPlayReceiverStatus.durationSeconds)}
            </small>
          </div>
          <div className="connect-receiver-meta">
            <span>{airPlayReceiverStatus.advertisedName}</span>
            <small>{airPlayReceiverStatus.currentClient ? `来自 ${airPlayReceiverStatus.currentClient.address}` : '等待 iPhone / iPad'}</small>
            <small>
              {airPlayReceiverStatus.nativeAvailable
                ? 'RAOP 后端已加载'
                : airPlayReceiverStatus.error ?? '需要可用的 AirPlay 原生后端'}
            </small>
            <small>使用 AirPlay 后进度条将被锁定</small>
          </div>
          <button
            className="settings-action-button"
            type="button"
            onClick={() => void stopAirPlayReceiverPlayback()}
            disabled={isAirPlayReceiverBusy || !airPlayReceiverStatus.currentSourceId}
          >
            <Square size={15} />
            停止 AirPlay
          </button>
        </div>
        <details className="connect-receiver-debug" aria-label="AirPlay receiver log">
          <summary>
            <span>AirPlay Debug</span>
            <small>{airPlayReceiverStatus.debugEvents.length > 0 ? `${airPlayReceiverStatus.debugEvents.length} recent` : 'No requests'}</small>
          </summary>
          <div className="connect-receiver-debug__items">
            {airPlayReceiverStatus.debugEvents.length > 0 ? (
              airPlayReceiverStatus.debugEvents.slice(0, 6).map((event) => (
                <code key={event.id}>
                  {new Date(event.at).toLocaleTimeString()} {event.method} {event.action ?? '-'}
                  {event.message ? ` ${event.message}` : ''}
                </code>
              ))
            ) : (
              <small>No AirPlay events yet</small>
            )}
          </div>
        </details>
      </section>

      <section className="connect-now" aria-label="当前投送">
        <div className="connect-artwork" data-empty={!previewCover}>
          {previewCover ? <img alt="" src={previewCover} /> : <Cast size={42} />}
        </div>
        <div className="connect-now-copy">
          <span>{stateLabel[status.state]}</span>
          <h2>{previewTitle}</h2>
          <p>{previewArtist}{previewAlbum ? ` · ${previewAlbum}` : ''}</p>
          <div className="connect-progress" aria-label="投送进度">
            <span style={{ width: `${progressPercent}%` }} />
          </div>
          <small>{formatTime(status.positionSeconds)} / {formatTime(status.durationSeconds || currentTrack?.duration || 0)}</small>
        </div>
        <div className="connect-controls" aria-label="Connect 控制">
          <button className="icon-button" type="button" aria-label="播放" title="播放" onClick={() => void runCommand('play')} disabled={isCommandBusy || !status.deviceId}>
            <Play size={17} />
          </button>
          <button className="icon-button" type="button" aria-label="暂停" title="暂停" onClick={() => void runCommand('pause')} disabled={isCommandBusy || !status.deviceId}>
            <Pause size={17} />
          </button>
          <button className="icon-button" type="button" aria-label="停止" title="停止" onClick={() => void runCommand('stop')} disabled={isCommandBusy || !status.deviceId}>
            <Square size={16} />
          </button>
          <button className="icon-button" type="button" aria-label="断开" title="断开" onClick={() => void runCommand('disconnect')} disabled={isCommandBusy || !status.deviceId}>
            <Unplug size={17} />
          </button>
          <label className="connect-volume">
            <Volume2 size={16} />
            <input
              type="range"
              min={0}
              max={100}
              value={volumePercent}
              onChange={(event) => setVolumePercent(Number(event.currentTarget.value))}
              onMouseUp={() => void commitVolume(volumePercent)}
              onKeyUp={(event) => {
                if (event.key === 'Enter') {
                  void commitVolume(volumePercent);
                }
              }}
              disabled={!activeDevice?.capabilities.canSetVolume}
              aria-label="投送音量"
            />
          </label>
        </div>
      </section>

      <section className="connect-device-section" aria-label="设备列表">
        <div className="connect-section-title">
          <div>
            <span>Devices</span>
            <h2>可连接设备</h2>
          </div>
          <small>{devices.length} 个入口</small>
        </div>
        <div className="connect-device-list">
          {devices.map((device) => {
            const isActive = device.id === status.deviceId;
            const isBusy = busyDeviceId === device.id;
            const disabled = device.state === 'unsupported' || isBusy || (!currentTrack && !currentFilePath);
            return (
              <article className="connect-device-row" data-active={isActive ? 'true' : undefined} key={device.id}>
                <div className="connect-device-icon" data-protocol={device.protocol}>
                  {device.protocol === 'dlna' ? <Wifi size={20} /> : <Cast size={20} />}
                </div>
                <div className="connect-device-copy">
                  <strong>{device.name}</strong>
                  <span>{formatProtocol(device)} · {device.model ?? device.manufacturer ?? 'Unknown device'}</span>
                  {device.unsupportedReason ? <small>{device.unsupportedReason}</small> : null}
                </div>
                <div className="connect-device-meta">
                  <span data-state={device.state}>{isActive ? stateLabel[status.state] : deviceStateLabel[device.state]}</span>
                  <small>{device.capabilities.supportsMetadata ? 'Metadata OK' : 'No metadata'}</small>
                </div>
                <button
                  className="settings-action-button"
                  type="button"
                  disabled={disabled}
                  onClick={() => void connectDevice(device)}
                >
                  {isBusy ? <Loader2 className="spinning-icon" size={15} /> : <Cast size={15} />}
                  {isActive ? '重新投送' : '连接'}
                </button>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
};
