import { app } from 'electron';
import { createMainWindow } from './createMainWindow';
import { requestAppQuit } from './tray';
import { getMainWindow } from './windowManager';
import { getCrashReportService } from '../diagnostics/CrashReportService';
import { registerCoverProtocolHandler } from '../protocol/coverProtocol';
import { registerVideoProtocolHandler } from '../protocol/videoProtocol';
import { disposeSmtcIntegration, initializeSmtcIntegration } from '../integrations/smtc/SmtcStatusSync';
import { disposeDiscordPresenceIntegration, initializeDiscordPresenceIntegration } from '../integrations/discord/DiscordPresenceStatusSync';
import { disposeLastFmIntegration, initializeLastFmIntegration } from '../integrations/lastfm/LastFmStatusSync';
import { savePlaybackMemoryNow } from '../ipc/playbackIpc';
import { dispatchLocalAudioFilesOpened, parseLocalAudioFileArguments } from './localFileOpen';

export const registerAppLifecycle = (): void => {
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

  app.whenReady().then(() => {
    getCrashReportService().initialize();
    registerCoverProtocolHandler();
    registerVideoProtocolHandler();
    void initializeSmtcIntegration();
    void initializeDiscordPresenceIntegration();
    initializeLastFmIntegration();
    createMainWindow();
    dispatchLocalAudioFilesOpened(parseLocalAudioFileArguments(process.argv));

    app.on('activate', () => {
      if (getMainWindow() === null) {
        createMainWindow();
      }
    });
  });

  app.on('before-quit', () => {
    savePlaybackMemoryNow();
    disposeLastFmIntegration();
    disposeDiscordPresenceIntegration();
    disposeSmtcIntegration();
    getCrashReportService().closeSession();
    requestAppQuit();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
};
