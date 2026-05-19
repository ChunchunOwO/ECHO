import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AudioStatus } from '../../shared/types/audio';
import type { PluginManifest } from '../../shared/types/plugins';
import { PluginService } from './PluginService';

const mocks = vi.hoisted(() => {
  const status = {
    host: 'ready',
    state: 'stopped',
    currentTrackId: null,
    currentFilePath: null,
    durationSeconds: 0,
    positionSeconds: 0,
    volume: 1,
  };
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const fakeAudioSession = {
    getStatus: vi.fn(() => status),
    play: vi.fn(async () => ({ ...status, state: 'playing' })),
    pause: vi.fn(async () => ({ ...status, state: 'paused' })),
    stop: vi.fn(() => ({ ...status, state: 'stopped' })),
    seek: vi.fn(async (positionSeconds: number) => ({ ...status, positionSeconds })),
    on: vi.fn((eventName: string, listener: (payload: unknown) => void) => {
      const set = listeners.get(eventName) ?? new Set<(payload: unknown) => void>();
      set.add(listener);
      listeners.set(eventName, set);
      return fakeAudioSession;
    }),
    emit: vi.fn((eventName: string, payload: unknown) => {
      listeners.get(eventName)?.forEach((listener) => listener(payload));
    }),
    removeAllListeners: vi.fn(() => listeners.clear()),
  };
  return {
    fakeAudioSession,
    openPathMock: vi.fn(async () => ''),
    getSummaryMock: vi.fn(() => ({ trackCount: 42, albumCount: 3, artistCount: 2 })),
    getTracksMock: vi.fn(() => [{ id: 'track-1', title: 'Song' }]),
    getAppSettingsMock: vi.fn(() => ({ smtcEnabled: true })),
    setAppSettingsMock: vi.fn((patch: Record<string, unknown>) => ({ smtcEnabled: true, ...patch })),
  };
});

vi.mock('electron', () => ({
  app: {
    getPath: () => join(tmpdir(), 'echo-next-plugin-service-userdata'),
  },
  shell: {
    openPath: mocks.openPathMock,
  },
}));

vi.mock('../audio/AudioSession', () => ({
  getAudioSession: () => mocks.fakeAudioSession,
}));

vi.mock('../library/LibraryService', () => ({
  getLibraryService: () => ({
    getSummary: mocks.getSummaryMock,
    getTracks: mocks.getTracksMock,
  }),
}));

vi.mock('../app/appSettings', () => ({
  getAppSettings: mocks.getAppSettingsMock,
  setAppSettings: mocks.setAppSettingsMock,
}));

const writePlugin = (root: string, manifest: PluginManifest, script: string): void => {
  const directory = join(root, manifest.id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'echo.plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(join(directory, manifest.entry ?? 'plugin.js'), `${script}\n`, 'utf8');
};

describe('PluginService', () => {
  let pluginRoot: string;
  let service: PluginService;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.fakeAudioSession.removeAllListeners();
    mocks.fakeAudioSession.getStatus.mockClear();
    mocks.fakeAudioSession.play.mockClear();
    mocks.fakeAudioSession.pause.mockClear();
    mocks.fakeAudioSession.stop.mockClear();
    mocks.fakeAudioSession.seek.mockClear();
    mocks.getSummaryMock.mockClear();
    mocks.getTracksMock.mockClear();
    mocks.getAppSettingsMock.mockClear();
    mocks.setAppSettingsMock.mockClear();
    mocks.openPathMock.mockClear();
    pluginRoot = mkdtempSync(join(tmpdir(), 'echo-next-plugin-service-'));
    service = new PluginService(pluginRoot);
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(pluginRoot, { recursive: true, force: true });
  });

  it('creates editable example plugins disabled by default', () => {
    const created = service.createExample('playback-panel');
    const result = service.list();

    expect(created.pluginId).toBe('echo.playback-panel');
    expect(existsSync(join(created.directory, 'echo.plugin.json'))).toBe(true);
    expect(existsSync(join(created.directory, 'plugin.js'))).toBe(true);
    expect(result.plugins[0]).toMatchObject({
      id: 'echo.playback-panel',
      enabled: false,
      status: 'disabled',
      permissions: ['playback:read'],
    });
  });

  it('requires explicit permission trust before enabling a plugin', () => {
    service.createExample('playback-panel');

    expect(() => service.enable({ pluginId: 'echo.playback-panel' })).toThrow('plugin_permission_confirmation_required');
    expect(service.list().plugins[0].enabled).toBe(false);
  });

  it('starts trusted plugins and runs registered commands through the sandbox API', async () => {
    service.createExample('playback-panel');
    service.enable({ pluginId: 'echo.playback-panel', trustedPermissions: ['playback:read'] });

    await service.runCommand({ pluginId: 'echo.playback-panel', commandId: 'show-status' });

    expect(mocks.fakeAudioSession.getStatus).toHaveBeenCalled();
    expect(service.getLogs('echo.playback-panel').some((entry) => entry.message.includes('当前播放状态'))).toBe(true);
  });

  it('throttles playback status events and writes only plugin-owned storage', async () => {
    const manifest: PluginManifest = {
      id: 'echo.status-cache',
      name: 'Status Cache',
      version: '0.0.1',
      apiVersion: 1,
      entry: 'plugin.js',
      permissions: ['playback:read'],
    };
    writePlugin(pluginRoot, manifest, [
      "echo.events.on('playback:status', async (status) => {",
      "  await echo.storage.set('lastStatus', { state: status.state, trackId: status.currentTrackId });",
      '});',
    ].join('\n'));

    service.enable({ pluginId: 'echo.status-cache', trustedPermissions: ['playback:read'] });
    mocks.fakeAudioSession.emit('status', { state: 'playing', currentTrackId: 'track-old' });
    mocks.fakeAudioSession.emit('status', { state: 'playing', currentTrackId: 'track-new' });
    await vi.advanceTimersByTimeAsync(499);
    expect(existsSync(join(pluginRoot, 'echo.status-cache', 'plugin-storage.json'))).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const storage = JSON.parse(readFileSync(join(pluginRoot, 'echo.status-cache', 'plugin-storage.json'), 'utf8')) as {
      lastStatus: { state: string; trackId: string };
    };
    expect(storage.lastStatus).toEqual({ state: 'playing', trackId: 'track-new' });
  });
});
