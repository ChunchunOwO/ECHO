import { app } from 'electron';
import { createMainWindow } from './createMainWindow';
import { requestAppQuit } from './tray';
import { getMainWindow } from './windowManager';
import { getCrashReportService } from '../diagnostics/CrashReportService';
import { registerCoverProtocolHandler } from '../protocol/coverProtocol';
import { disposeSmtcIntegration, initializeSmtcIntegration } from '../integrations/smtc/SmtcStatusSync';
import { disposeDiscordPresenceIntegration, initializeDiscordPresenceIntegration } from '../integrations/discord/DiscordPresenceStatusSync';
import { disposeLastFmIntegration, initializeLastFmIntegration } from '../integrations/lastfm/LastFmStatusSync';

export const registerAppLifecycle = (): void => {
  app.whenReady().then(() => {
    getCrashReportService().initialize();
    registerCoverProtocolHandler();
    void initializeSmtcIntegration();
    void initializeDiscordPresenceIntegration();
    initializeLastFmIntegration();
    createMainWindow();

    app.on('activate', () => {
      if (getMainWindow() === null) {
        createMainWindow();
      }
    });
  });

  app.on('before-quit', () => {
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
