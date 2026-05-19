import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IpcChannels } from '../../shared/constants/ipcChannels';

const handlers: Record<string, (...args: unknown[]) => unknown> = {};
const handleMock = vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
  handlers[channel] = handler;
});
const showOpenDialogMock = vi.fn();
const showSaveDialogMock = vi.fn();
const openExternalMock = vi.fn();
const setAppSettingsMock = vi.fn((patch: Record<string, unknown>) => ({ coverCacheDir: patch.coverCacheDir ?? null, hideToTrayOnClose: false, ...patch }));
const getAppSettingsMock = vi.fn<() => Record<string, unknown>>(() => ({ coverCacheDir: null, hideToTrayOnClose: false }));
const getLibraryServiceMock = vi.fn();
const ensureCoverCacheDirectoryMock = vi.fn();
const fromWebContentsMock = vi.fn();
const refreshGlobalShortcutRegistrationMock = vi.fn(() => null);
const validateGlobalShortcutMock = vi.fn(() => ({
  accelerator: 'Ctrl+Alt+Space',
  available: true,
  reason: 'available',
  valid: true,
}));
const appPathMock = vi.fn((name: string) =>
  name === 'downloads' ? tmpdir() : join(tmpdir(), 'echo-next-register-ipc-test-userdata'),
);

vi.mock('electron', () => ({
  default: {
    app: {
      getAppPath: () => 'D:\\ECHONext\\ECHO-Next',
      getPath: appPathMock,
      isPackaged: false,
    },
  },
  app: {
    getVersion: () => '0.0.0-test',
    getPath: appPathMock,
  },
  BrowserWindow: {
    fromWebContents: fromWebContentsMock,
  },
  dialog: {
    showOpenDialog: showOpenDialogMock,
    showSaveDialog: showSaveDialogMock,
  },
  ipcMain: {
    handle: handleMock,
  },
  shell: {
    openExternal: openExternalMock,
  },
}));

vi.mock('../app/appSettings', () => ({
  defaultSettings: {
    albumMergeStrategy: 'standard',
    artistWallAlbumArtwork: false,
    coverCacheDir: null,
    hideToTrayOnClose: false,
    appCustomWallpaperPath: null,
    appWallpaperScalePercent: 100,
    appWallpaperBlurPx: 0,
    appWallpaperBrightnessPercent: 100,
    appWallpaperUiOpacityPercent: 100,
    appWallpaperUnifiedOpacityEnabled: false,
    networkMetadataEnabled: false,
    networkMetadataProviders: ['netease-cloud-music', 'qq-music'],
    channelBalance: {
      enabled: false,
      balance: 0,
      leftGainDb: 0,
      rightGainDb: 0,
      swapLeftRight: false,
      monoMode: 'off',
      invertLeft: false,
      invertRight: false,
      constantPower: true,
    },
    playerVolume: 1,
    playbackSpeed: 1,
    playbackSpeedMode: 'nightcore',
    scanPerformanceMode: 'balanced',
    duplicateTracksEnabled: false,
    duplicateTracksMode: 'strict',
    duplicateTracksAutoRebuildAfterScan: false,
    discordRichPresenceEnabled: false,
    lastFmEnabled: false,
    lastFmUsername: null,
    lastFmSessionKey: null,
    lastFmScrobbleEnabled: true,
    lastFmNowPlayingEnabled: true,
    lastFmMinScrobbleSeconds: 30,
    lastFmAuthToken: null,
    smtcEnabled: true,
  },
  getAppSettings: getAppSettingsMock,
  getAppWallpaperDirectory: vi.fn(() => 'D:\\Echo\\app-wallpapers'),
  getLyricsWallpaperDirectory: vi.fn(() => 'D:\\Echo\\lyrics-wallpapers'),
  normalizeSettings: vi.fn((value) => ({ coverCacheDir: null, hideToTrayOnClose: false, ...(value as Record<string, unknown>) })),
  setAppSettings: setAppSettingsMock,
}));

vi.mock('../app/tray', () => ({
  destroyTray: vi.fn(),
  ensureTray: vi.fn(),
}));

vi.mock('../app/autoUpdater', () => ({
  checkForUpdates: vi.fn(),
  getUpdateStatus: vi.fn(() => ({
    state: 'idle',
    currentVersion: 'v0.0.0-test',
    latestVersion: null,
    releaseName: null,
    releaseNotes: null,
    downloadPercent: null,
    transferredBytes: null,
    totalBytes: null,
    bytesPerSecond: null,
    error: null,
    checkedAt: null,
  })),
  setAutoUpdateEnabled: vi.fn(),
}));

vi.mock('../app/backgroundPlaybackShortcuts', () => ({
  refreshBackgroundSpaceRegistration: refreshGlobalShortcutRegistrationMock,
  validateGlobalShortcut: validateGlobalShortcutMock,
}));

vi.mock('../library/CoverCacheManager', () => ({
  ensureCoverCacheDirectory: ensureCoverCacheDirectoryMock,
}));

vi.mock('../library/LibraryService', () => ({
  getLibraryService: getLibraryServiceMock,
}));

vi.mock('./libraryIpc', () => ({
  registerLibraryIpc: vi.fn(),
}));

vi.mock('./lyricsIpc', () => ({
  registerLyricsIpc: vi.fn(),
}));

vi.mock('./mvIpc', () => ({
  registerMvIpc: vi.fn(),
}));

vi.mock('./playbackIpc', () => ({
  registerPlaybackIpc: vi.fn(),
}));

vi.mock('./audioIpc', () => ({
  registerAudioIpc: vi.fn(),
}));

vi.mock('./accountIpc', () => ({
  registerAccountIpc: vi.fn(),
}));

vi.mock('./diagnosticsIpc', () => ({
  registerDiagnosticsIpc: vi.fn(),
}));

vi.mock('./connectIpc', () => ({
  registerConnectIpc: vi.fn(),
}));

vi.mock('./discordPresenceIpc', () => ({
  registerDiscordPresenceIpc: vi.fn(),
}));

vi.mock('./downloadsIpc', () => ({
  registerDownloadsIpc: vi.fn(),
}));

vi.mock('./pluginIpc', () => ({
  registerPluginIpc: vi.fn(),
}));

vi.mock('./lastFmIpc', () => ({
  registerLastFmIpc: vi.fn(),
}));

vi.mock('./remoteSourcesIpc', () => ({
  registerRemoteSourcesIpc: vi.fn(),
}));

vi.mock('./streamingIpc', () => ({
  registerStreamingIpc: vi.fn(),
}));

vi.mock('../integrations/discord/getDiscordPresenceService', () => ({
  setDiscordPresenceEnabled: vi.fn(),
}));

vi.mock('../integrations/lastfm/getLastFmService', () => ({
  getLastFmService: () => ({
    disconnect: vi.fn(),
  }),
}));

const resetHandlers = (): void => {
  for (const key of Object.keys(handlers)) {
    delete handlers[key];
  }
};

describe('app IPC cover cache directory', () => {
  beforeEach(async () => {
    resetHandlers();
    handleMock.mockClear();
    showOpenDialogMock.mockReset();
    showSaveDialogMock.mockReset();
    openExternalMock.mockReset();
    setAppSettingsMock.mockClear();
    getAppSettingsMock.mockClear();
    getLibraryServiceMock.mockReset();
    ensureCoverCacheDirectoryMock.mockReset();
    fromWebContentsMock.mockReset();
    refreshGlobalShortcutRegistrationMock.mockClear();
    validateGlobalShortcutMock.mockClear();
    appPathMock.mockClear();
    const module = await import('./registerIpc');
    module.registerIpc();
  });

  it('rejects changing the cache directory while a scan is running', async () => {
    getLibraryServiceMock.mockReturnValue({
      hasRunningJobs: () => true,
      getDefaultCoverCacheDir: () => 'D:\\Echo\\cover-cache',
    });

    await expect(
      handlers[IpcChannels.AppSetCoverCacheDirectory]!(null, { directory: 'D:\\NewCache', migrate: true }),
    ).rejects.toThrow('Cannot change cover cache directory while a library scan is running.');
    expect(setAppSettingsMock).not.toHaveBeenCalled();
  });

  it('can restore the default cache directory without migration', async () => {
    const service = {
      hasRunningJobs: () => false,
      getDefaultCoverCacheDir: () => 'D:\\Echo\\cover-cache',
      setCoverCacheDir: vi.fn(),
      syncLiveLibraryWatcherFromSettings: vi.fn(),
    };
    getLibraryServiceMock.mockReturnValue(service);

    const result = await handlers[IpcChannels.AppSetCoverCacheDirectory]!(null, { directory: null, migrate: false });

    expect(result).toBeNull();
    expect(ensureCoverCacheDirectoryMock).toHaveBeenCalledWith('D:\\Echo\\cover-cache');
    expect(setAppSettingsMock).toHaveBeenCalledWith({ coverCacheDir: null });
    expect(service.setCoverCacheDir).toHaveBeenCalledWith('D:\\Echo\\cover-cache');
  });

  it('resets app settings and restores the default cover cache directory', async () => {
    const service = {
      hasRunningJobs: () => false,
      getDefaultCoverCacheDir: () => 'D:\\Echo\\cover-cache',
      setCoverCacheDir: vi.fn(),
      syncLiveLibraryWatcherFromSettings: vi.fn(),
    };
    getLibraryServiceMock.mockReturnValue(service);

    const result = (await handlers[IpcChannels.AppResetSettings]!()) as { coverCacheDir: string | null };

    expect(result.coverCacheDir).toBeNull();
    expect(ensureCoverCacheDirectoryMock).toHaveBeenCalledWith('D:\\Echo\\cover-cache');
    expect(setAppSettingsMock).toHaveBeenCalledWith(expect.objectContaining({ coverCacheDir: null, hideToTrayOnClose: false }));
    expect(service.setCoverCacheDir).toHaveBeenCalledWith('D:\\Echo\\cover-cache');
  });

  it('uses an image-only picker for lyrics wallpaper selection', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] });

    const result = await handlers[IpcChannels.AppChooseLyricsWallpaper]!();

    expect(result).toBeNull();
    expect(showOpenDialogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [{ name: 'Image files', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
        properties: ['openFile'],
      }),
    );
  });

  it('uses an image and video picker for app wallpaper selection', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] });

    const result = await handlers[IpcChannels.AppChooseAppWallpaper]!();

    expect(result).toBeNull();
    expect(showOpenDialogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [
          { name: 'Background files', extensions: ['jpg', 'jpeg', 'png', 'webp', 'mp4', 'm4v', 'webm'] },
          { name: 'Image files', extensions: ['jpg', 'jpeg', 'png', 'webp'] },
          { name: 'Video files', extensions: ['mp4', 'm4v', 'webm'] },
        ],
        properties: ['openFile'],
      }),
    );
  });

  it('copies browser-playable video files for app wallpaper selection', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'echo-app-video-wallpaper-'));
    const videoPath = join(tempRoot, 'motion.webm');
    writeFileSync(videoPath, 'video');
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [videoPath] });

    try {
      const result = await handlers[IpcChannels.AppChooseAppWallpaper]!();

      expect(typeof result).toBe('string');
      expect(String(result)).toMatch(/\.webm$/u);
      expect(existsSync(String(result))).toBe(true);
      expect(readFileSync(String(result), 'utf8')).toBe('video');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      if (typeof appPathMock('userData') === 'string') {
        rmSync(appPathMock('userData'), { recursive: true, force: true });
      }
    }
  });

  it('opens external http links through the system browser only', async () => {
    await handlers[IpcChannels.AppOpenExternalUrl]!(null, 'https://discord.gg/g7v4WMRq3K');

    expect(openExternalMock).toHaveBeenCalledWith('https://discord.gg/g7v4WMRq3K');
    await expect(handlers[IpcChannels.AppOpenExternalUrl]!(null, 'file:///C:/Windows/System32/calc.exe')).rejects.toThrow(
      'external URL must use http or https',
    );
  });

  it('exits fullscreen when toggling maximize from F11 fullscreen mode', () => {
    const window = {
      isFullScreen: vi.fn(() => true),
      setFullScreen: vi.fn(),
      isMaximized: vi.fn(() => false),
      maximize: vi.fn(),
      unmaximize: vi.fn(),
    };
    fromWebContentsMock.mockReturnValue(window);

    handlers[IpcChannels.AppWindowToggleMaximize]!({ sender: {} });

    expect(window.setFullScreen).toHaveBeenCalledWith(false);
    expect(window.isMaximized).not.toHaveBeenCalled();
    expect(window.maximize).not.toHaveBeenCalled();
    expect(window.unmaximize).not.toHaveBeenCalled();
  });

  it('exports app settings to a selected JSON backup', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'echo-settings-export-'));
    const exportPath = join(tempRoot, 'settings.json');
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: exportPath });
    getAppSettingsMock.mockReturnValue({ locale: 'ja-JP', coverCacheDir: null, hideToTrayOnClose: false });

    const result = await handlers[IpcChannels.AppExportSettings]!();

    expect(result).toBe(exportPath);
    const payload = JSON.parse(readFileSync(exportPath, 'utf8')) as { format: string; settings: { locale: string } };
    expect(payload.format).toBe('echo-next-settings-backup');
    expect(payload.settings.locale).toBe('ja-JP');
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('backs up current settings before importing a selected JSON backup', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'echo-settings-import-'));
    const importPath = join(tempRoot, 'incoming.json');
    writeFileSync(importPath, JSON.stringify({ format: 'echo-next-settings-backup', version: 1, settings: { locale: 'en-US', coverCacheDir: null } }), 'utf8');
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [importPath] });
    getAppSettingsMock.mockReturnValue({ locale: 'zh-CN', coverCacheDir: null, hideToTrayOnClose: false });
    const service = {
      hasRunningJobs: () => false,
      getDefaultCoverCacheDir: () => 'D:\\Echo\\cover-cache',
      setCoverCacheDir: vi.fn(),
      syncLiveLibraryWatcherFromSettings: vi.fn(),
    };
    getLibraryServiceMock.mockReturnValue(service);
    setAppSettingsMock.mockImplementation((patch) => ({ coverCacheDir: null, hideToTrayOnClose: false, ...(patch as Record<string, unknown>) }));

    const result = (await handlers[IpcChannels.AppImportSettings]!()) as { backupPath: string; settings: { locale: string } };

    expect(result.settings.locale).toBe('en-US');
    expect(existsSync(result.backupPath)).toBe(true);
    expect(setAppSettingsMock).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en-US' }));
    expect(service.setCoverCacheDir).toHaveBeenCalledWith('D:\\Echo\\cover-cache');
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('refreshes global shortcuts when shortcut settings change', async () => {
    const shortcutPatch = {
      globalShortcuts: {
        playPause: { enabled: true, accelerator: 'Ctrl+Alt+Space' },
      },
    };
    setAppSettingsMock.mockReturnValue({ ...shortcutPatch, coverCacheDir: null, hideToTrayOnClose: false });

    await handlers[IpcChannels.AppSetSettings]!(null, shortcutPatch);

    expect(setAppSettingsMock).toHaveBeenCalledWith(shortcutPatch);
    expect(refreshGlobalShortcutRegistrationMock).toHaveBeenCalledTimes(1);
  });

  it('validates global shortcut accelerators through IPC', () => {
    const result = handlers[IpcChannels.AppValidateGlobalShortcut]!(null, 'Ctrl+Alt+Space');

    expect(validateGlobalShortcutMock).toHaveBeenCalledWith('Ctrl+Alt+Space');
    expect(result).toMatchObject({ valid: true, available: true });
  });
});
