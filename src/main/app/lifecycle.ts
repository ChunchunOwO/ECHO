import { app, BrowserWindow, dialog } from 'electron';
import { createMainWindow } from './createMainWindow';
import { requestAppQuit } from './tray';
import { getMainWindow } from './windowManager';
import { getCrashReportService } from '../diagnostics/CrashReportService';
import { registerAudioProtocolHandler } from '../protocol/audioProtocol';
import { registerCoverProtocolHandler } from '../protocol/coverProtocol';
import { registerVideoProtocolHandler } from '../protocol/videoProtocol';
import { disposeSmtcIntegration, initializeSmtcIntegration } from '../integrations/smtc/SmtcStatusSync';
import { disposeDiscordPresenceIntegration, initializeDiscordPresenceIntegration } from '../integrations/discord/DiscordPresenceStatusSync';
import { disposeLastFmIntegration, initializeLastFmIntegration } from '../integrations/lastfm/LastFmStatusSync';
import { savePlaybackMemoryNow } from '../ipc/playbackIpc';
import { dispatchLocalAudioFilesOpened, parseLocalAudioFileArguments } from './localFileOpen';
import { initializeAutoUpdater } from './autoUpdater';
import { getAppSettings } from './appSettings';
import { ensureDataProtection } from './dataProtection';
import { disposeBackgroundPlaybackShortcuts, initializeBackgroundPlaybackShortcuts } from './backgroundPlaybackShortcuts';
import { getAccountService } from '../accounts/AccountService';
import { disposeAirPlayReceiverSpikeService } from '../connect/AirPlayReceiverSpikeService';
import { disposeConnectReceiverService } from '../connect/ConnectReceiverService';
import { disposeConnectService } from '../connect/ConnectService';
import { IpcChannels } from '../../shared/constants/ipcChannels';
import type { AccountStatus } from '../../shared/types/accounts';
import { closeDefaultLibraryService } from '../library/LibraryService';
import { closeDefaultRemoteSourceService } from '../library/remote/RemoteSourceService';
import { closeDefaultLyricsService } from '../lyrics/LyricsService';
import { closeDefaultMvService } from '../mv/MvService';
import { closeDefaultStreamingService } from '../streaming/StreamingService';
import { disposeDefaultAudioSessionGracefully } from '../audio/AudioSession';
import { closeDefaultLibraryDatabaseManager, getLibraryDatabaseManager } from '../database/LibraryDatabaseManager';

const sendAccountStatusesChanged = (statuses: AccountStatus[]): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    const send = (): void => {
      if (!window.isDestroyed()) {
        window.webContents.send(IpcChannels.AccountStatusesChanged, statuses);
      }
    };

    if (window.webContents.isLoading()) {
      window.webContents.once('did-finish-load', send);
    } else {
      send();
    }
  }
};

const refreshPreviouslyLoggedInAccountsOnStartup = async (): Promise<void> => {
  const statuses = await getAccountService().checkPreviouslyLoggedInAccounts();
  const disconnectedStatuses = statuses.filter((status) => !status.connected && Boolean(status.error));

  if (disconnectedStatuses.length > 0) {
    sendAccountStatusesChanged(disconnectedStatuses);
  }
};

const notifyLibraryDatabaseProtected = (): void => {
  void dialog.showMessageBox({
    type: 'warning',
    title: '曲库数据库进入保护模式',
    message: 'ECHO Next 检测到音乐库数据库未通过健康检查，已先归档副本并停止继续写入。',
    detail: '你的音乐文件不会被删除。请打开设置里的数据库恢复工具，选择恢复健康快照或归档后重建曲库索引。',
    buttons: ['知道了'],
    defaultId: 0,
    noLink: true,
  });
};

export const registerAppLifecycle = (): void => {
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  if (process.platform === 'win32') {
    app.setAppUserModelId('app.echo.next');
  }

  const hasSingleInstanceLock = app.requestSingleInstanceLock();
  if (!hasSingleInstanceLock) {
    app.quit();
    return;
  }

  app.on('second-instance', (_event, argv) => {
    let window = getMainWindow();
    if (window === null) {
      window = createMainWindow();
    }

    if (window.isMinimized()) {
      window.restore();
    }

    window.show();
    window.focus();
    dispatchLocalAudioFilesOpened(parseLocalAudioFileArguments(argv));
  });

  app.whenReady().then(async () => {
    getCrashReportService().initialize();
    const dataProtection = await ensureDataProtection('startup');
    registerAudioProtocolHandler();
    registerCoverProtocolHandler();
    registerVideoProtocolHandler();
    if (dataProtection.libraryHealth.status === 'ok') {
      void initializeSmtcIntegration();
      initializeLastFmIntegration();
      void initializeDiscordPresenceIntegration();
    } else {
      getCrashReportService().getLogger()?.warn('main', '[Lifecycle] library database is unhealthy; starting without library-backed integrations', {
        status: dataProtection.libraryHealth.status,
        error: dataProtection.libraryHealth.message,
      });
    }
    createMainWindow();
    if (dataProtection.recovery.action === 'protected' || dataProtection.recovery.action === 'archivedOnly') {
      notifyLibraryDatabaseProtected();
    }
    initializeBackgroundPlaybackShortcuts();
    const appSettings = getAppSettings();
    if (appSettings.autoAccountCheckOnStartup !== false) {
      void refreshPreviouslyLoggedInAccountsOnStartup().catch(() => undefined);
    }
    initializeAutoUpdater(appSettings.autoUpdateEnabled !== false);
    dispatchLocalAudioFilesOpened(parseLocalAudioFileArguments(process.argv));

    app.on('activate', () => {
      if (getMainWindow() === null) {
        createMainWindow();
      }
    });
  }).catch((error) => {
    getCrashReportService().getLogger()?.warn('main', '[Lifecycle] startup failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    createMainWindow();
  });

  let gracefulQuitInProgress = false;
  let gracefulQuitCompleted = false;

  const cleanupBeforeQuit = async (): Promise<void> => {
    savePlaybackMemoryNow();
    disposeLastFmIntegration();
    disposeDiscordPresenceIntegration();
    await disposeAirPlayReceiverSpikeService();
    await disposeConnectReceiverService();
    await disposeConnectService();
    await disposeSmtcIntegration();
    await disposeDefaultAudioSessionGracefully('app-quit');
    disposeBackgroundPlaybackShortcuts();
    closeDefaultLyricsService();
    closeDefaultMvService();
    closeDefaultStreamingService();
    closeDefaultRemoteSourceService();
    closeDefaultLibraryService();
    const manager = getLibraryDatabaseManager();
    manager.closeAllUsers('app-quit');
    const checkpoint = manager.checkpoint('app-quit');
    if (checkpoint.status !== 'ok') {
      getCrashReportService().getLogger()?.warn('main', '[Lifecycle] library WAL checkpoint failed during shutdown', {
        status: checkpoint.status,
        error: checkpoint.message,
      });
    }
    closeDefaultLibraryDatabaseManager();
    getCrashReportService().closeSession();
    requestAppQuit();
  };

  const cleanupBeforeQuitWithTimeout = async (): Promise<void> => {
    let timeout: NodeJS.Timeout | null = null;
    let timedOut = false;
    try {
      await Promise.race([
        cleanupBeforeQuit(),
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            timedOut = true;
            resolve();
          }, 2000);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (timedOut) {
        getCrashReportService().getLogger()?.warn('main', '[Lifecycle] graceful shutdown cleanup timed out');
      }
    }
  };

  app.on('before-quit', (event) => {
    if (gracefulQuitCompleted) {
      return;
    }

    event.preventDefault();
    if (gracefulQuitInProgress) {
      return;
    }

    gracefulQuitInProgress = true;
    void cleanupBeforeQuitWithTimeout()
      .catch((error) => {
        getCrashReportService().getLogger()?.warn('main', '[Lifecycle] graceful shutdown cleanup failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        gracefulQuitCompleted = true;
        app.quit();
      });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
};
