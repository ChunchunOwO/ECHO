import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { app } from 'electron';
import type { AppSettings } from '../../shared/types/appSettings';

export const defaultSettings: AppSettings = {
  coverCacheDir: null,
  hideToTrayOnClose: false,
  networkMetadataEnabled: false,
  networkMetadataProviders: ['netease-cloud-music', 'qq-music'],
  playerVolume: 1,
  playbackSpeed: 1,
  playbackSpeedMode: 'nightcore',
};

let cachedSettings: AppSettings | null = null;

const getSettingsPath = (): string => join(app.getPath('userData'), 'echo-settings.json');

const normalizeCoverCacheDir = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? resolve(trimmed) : null;
};

export const normalizeSettings = (value: unknown): AppSettings => {
  if (!value || typeof value !== 'object') {
    return { ...defaultSettings };
  }

  const settings = value as Partial<AppSettings>;
  const playerVolume = Number(settings.playerVolume);
  const playbackSpeed = Number(settings.playbackSpeed);
  const playbackSpeedMode =
    settings.playbackSpeedMode === 'daycore' || settings.playbackSpeedMode === 'speed'
      ? settings.playbackSpeedMode
      : defaultSettings.playbackSpeedMode;
  const providers = Array.isArray(settings.networkMetadataProviders)
    ? settings.networkMetadataProviders.filter(
        (provider): provider is AppSettings['networkMetadataProviders'][number] =>
          provider === 'mock' ||
          provider === 'musicbrainz' ||
          provider === 'cover-art-archive' ||
          provider === 'netease-cloud-music' ||
          provider === 'qq-music',
      )
    : defaultSettings.networkMetadataProviders;

  return {
    coverCacheDir: normalizeCoverCacheDir(settings.coverCacheDir),
    hideToTrayOnClose: settings.hideToTrayOnClose === true,
    networkMetadataEnabled: settings.networkMetadataEnabled === true,
    networkMetadataProviders: providers.length ? providers : defaultSettings.networkMetadataProviders,
    playerVolume: Number.isFinite(playerVolume) ? Math.max(0, Math.min(1, playerVolume)) : defaultSettings.playerVolume,
    playbackSpeed: Number.isFinite(playbackSpeed)
      ? Math.max(0.5, Math.min(2, playbackSpeed))
      : defaultSettings.playbackSpeed,
    playbackSpeedMode,
  };
};

export const getAppSettings = (): AppSettings => {
  if (cachedSettings) {
    return cachedSettings;
  }

  const settingsPath = getSettingsPath();

  if (!existsSync(settingsPath)) {
    cachedSettings = { ...defaultSettings };
    return cachedSettings;
  }

  try {
    cachedSettings = normalizeSettings(JSON.parse(readFileSync(settingsPath, 'utf8')));
  } catch {
    cachedSettings = { ...defaultSettings };
  }

  return cachedSettings;
};

export const setAppSettings = (patch: Partial<AppSettings>): AppSettings => {
  const nextSettings = normalizeSettings({ ...getAppSettings(), ...patch });
  const settingsPath = getSettingsPath();

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`, 'utf8');
  cachedSettings = nextSettings;

  return nextSettings;
};
