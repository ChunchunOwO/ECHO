import { BrowserWindow, ipcMain } from 'electron';
import { IpcChannels } from '../../shared/constants/ipcChannels';
import type { AirPlayReceiverStatus, ConnectDevice, ConnectReceiverStatus, ConnectSessionStatus } from '../../shared/types/connect';
import { getAppSettings } from '../app/appSettings';
import { getAirPlayReceiverSpikeService } from '../connect/AirPlayReceiverSpikeService';
import { getConnectReceiverService } from '../connect/ConnectReceiverService';
import { getConnectService, normalizeConnectStartRequest } from '../connect/ConnectService';
import { getEchoLinkService } from '../connect/EchoLinkService';
import type { EchoLinkServerStatus } from '../../shared/types/echoLink';
import { getConnectDonatorUnlockService } from '../plugins/ConnectDonatorUnlockService';

const sendConnectStatus = (status: ConnectSessionStatus): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IpcChannels.ConnectStatus, status);
    }
  }
};

const sendConnectReceiverStatus = (status: ConnectReceiverStatus): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IpcChannels.ConnectReceiverStatus, status);
    }
  }
};

const sendAirPlayReceiverStatus = (status: AirPlayReceiverStatus): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IpcChannels.ConnectAirPlayReceiverStatus, status);
    }
  }
};

const normalizeSeconds = (value: unknown): number => {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? next : 0;
};

const normalizeVolume = (value: unknown): number => {
  const next = Number(value);
  return Number.isFinite(next) ? Math.max(0, Math.min(100, next)) : 100;
};

const startConfiguredReceivers = (
  receiverService: ReturnType<typeof getConnectReceiverService>,
  airPlayReceiverService: ReturnType<typeof getAirPlayReceiverSpikeService>,
): void => {
  if (getAppSettings().connectAutoStartReceiversEnabled !== true) {
    return;
  }
  try {
    getConnectDonatorUnlockService().assertUnlocked();
  } catch {
    return;
  }

  void receiverService.setEnabled(true).catch(() => undefined);
  void airPlayReceiverService.setEnabled(true).catch(() => undefined);
};

export const registerConnectIpc = (): void => {
  const service = getConnectService();
  const receiverService = getConnectReceiverService();
  const airPlayReceiverService = getAirPlayReceiverSpikeService();
  const echoLinkService = getEchoLinkService();
  service.on('status', sendConnectStatus);
  receiverService.on('status', sendConnectReceiverStatus);
  airPlayReceiverService.on('status', sendAirPlayReceiverStatus);

  const requireConnectDonatorUnlock = (): void => {
    getConnectDonatorUnlockService().assertUnlocked();
  };

  ipcMain.handle(IpcChannels.ConnectGetDonatorUnlockStatus, () => getConnectDonatorUnlockService().getStatus());
  ipcMain.handle(IpcChannels.ConnectListDevices, (): ConnectDevice[] => {
    requireConnectDonatorUnlock();
    return service.listDevices();
  });
  ipcMain.handle(IpcChannels.ConnectRefresh, (): Promise<ConnectDevice[]> => {
    requireConnectDonatorUnlock();
    return service.refreshDevices();
  });
  ipcMain.handle(IpcChannels.ConnectGetStatus, (): ConnectSessionStatus => {
    requireConnectDonatorUnlock();
    return service.getStatus();
  });
  ipcMain.handle(IpcChannels.ConnectConnect, (_event, request: unknown): Promise<ConnectSessionStatus> =>
    {
      requireConnectDonatorUnlock();
      return service.connect(normalizeConnectStartRequest(request));
    },
  );
  ipcMain.handle(IpcChannels.ConnectDisconnect, (): Promise<ConnectSessionStatus> => {
    requireConnectDonatorUnlock();
    return service.disconnect();
  });
  ipcMain.handle(IpcChannels.ConnectPlay, (): Promise<ConnectSessionStatus> => {
    requireConnectDonatorUnlock();
    return service.play();
  });
  ipcMain.handle(IpcChannels.ConnectPause, (): Promise<ConnectSessionStatus> => {
    requireConnectDonatorUnlock();
    return service.pause();
  });
  ipcMain.handle(IpcChannels.ConnectStop, (): Promise<ConnectSessionStatus> => {
    requireConnectDonatorUnlock();
    return service.stop();
  });
  ipcMain.handle(IpcChannels.ConnectSeek, (_event, positionSeconds: unknown): Promise<ConnectSessionStatus> => {
    requireConnectDonatorUnlock();
    return service.seek(normalizeSeconds(positionSeconds));
  });
  ipcMain.handle(IpcChannels.ConnectSetVolume, (_event, volumePercent: unknown): Promise<ConnectSessionStatus> => {
    requireConnectDonatorUnlock();
    return service.setVolume(normalizeVolume(volumePercent));
  });
  ipcMain.handle(IpcChannels.EchoLinkGetStatus, (): EchoLinkServerStatus => {
    requireConnectDonatorUnlock();
    return echoLinkService.getServerStatus();
  });
  ipcMain.handle(IpcChannels.EchoLinkSetEnabled, (_event, enabled: unknown): Promise<EchoLinkServerStatus> => {
    requireConnectDonatorUnlock();
    return echoLinkService.setEnabled(enabled === true);
  });
  ipcMain.handle(IpcChannels.EchoLinkRotateToken, (): EchoLinkServerStatus => {
    requireConnectDonatorUnlock();
    return echoLinkService.rotateToken();
  });
  ipcMain.handle(IpcChannels.ConnectReceiverGetStatus, (): ConnectReceiverStatus => {
    requireConnectDonatorUnlock();
    return receiverService.getStatus();
  });
  ipcMain.handle(IpcChannels.ConnectReceiverSetEnabled, (_event, enabled: unknown): Promise<ConnectReceiverStatus> => {
    requireConnectDonatorUnlock();
    return receiverService.setEnabled(enabled === true);
  });
  ipcMain.handle(IpcChannels.ConnectReceiverStopPlayback, (): ConnectReceiverStatus => {
    requireConnectDonatorUnlock();
    return receiverService.stopPlayback();
  });
  ipcMain.handle(IpcChannels.ConnectAirPlayReceiverGetStatus, (): AirPlayReceiverStatus => {
    requireConnectDonatorUnlock();
    return airPlayReceiverService.getStatus();
  });
  ipcMain.handle(IpcChannels.ConnectAirPlayReceiverSetEnabled, (_event, enabled: unknown): Promise<AirPlayReceiverStatus> => {
    requireConnectDonatorUnlock();
    return airPlayReceiverService.setEnabled(enabled === true);
  });
  ipcMain.handle(IpcChannels.ConnectAirPlayReceiverStopPlayback, (): Promise<AirPlayReceiverStatus> => {
    requireConnectDonatorUnlock();
    return airPlayReceiverService.stopPlayback();
  });
  startConfiguredReceivers(receiverService, airPlayReceiverService);
};
