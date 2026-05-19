import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcChannels } from '../../shared/constants/ipcChannels';

const handlers: Record<string, (...args: unknown[]) => unknown> = {};
const handleMock = vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
  handlers[channel] = handler;
});
const serviceMock = {
  scheduleAutoStart: vi.fn(),
  list: vi.fn(() => ({ directory: 'D:\\Echo\\plugins', plugins: [] })),
  createExample: vi.fn((kind: string) => ({ pluginId: `echo.${kind}`, directory: 'D:\\Echo\\plugins\\example' })),
  enable: vi.fn((request) => ({ id: request.pluginId, enabled: true })),
  disable: vi.fn((pluginId: string) => ({ id: pluginId, enabled: false })),
  reload: vi.fn(async (pluginId: string) => ({ id: pluginId, status: 'running' })),
  openDirectory: vi.fn(async () => undefined),
  runCommand: vi.fn(async () => ({ ok: true })),
  getLogs: vi.fn(() => []),
};

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock,
  },
}));

vi.mock('../plugins/PluginService', () => ({
  getPluginService: () => serviceMock,
}));

const resetHandlers = (): void => {
  for (const key of Object.keys(handlers)) {
    delete handlers[key];
  }
};

describe('plugin IPC', () => {
  beforeEach(async () => {
    resetHandlers();
    handleMock.mockClear();
    Object.values(serviceMock).forEach((mock) => mock.mockClear());
    vi.resetModules();
    const module = await import('./pluginIpc');
    module.registerPluginIpc();
  });

  it('registers plugin handlers and schedules idle startup', () => {
    expect(serviceMock.scheduleAutoStart).toHaveBeenCalledTimes(1);
    expect(handleMock).toHaveBeenCalledWith(IpcChannels.PluginsList, expect.any(Function));
    expect(handleMock).toHaveBeenCalledWith(IpcChannels.PluginsRunCommand, expect.any(Function));
  });

  it('routes valid plugin IPC requests to the service', async () => {
    expect(handlers[IpcChannels.PluginsList]!(null)).toEqual({ directory: 'D:\\Echo\\plugins', plugins: [] });
    expect(handlers[IpcChannels.PluginsCreateExample]!(null, 'playback-panel')).toMatchObject({ pluginId: 'echo.playback-panel' });
    expect(handlers[IpcChannels.PluginsEnable]!(null, { pluginId: 'echo.playback-panel' })).toMatchObject({ enabled: true });
    expect(handlers[IpcChannels.PluginsDisable]!(null, 'echo.playback-panel')).toMatchObject({ enabled: false });
    await expect(handlers[IpcChannels.PluginsReload]!(null, 'echo.playback-panel')).resolves.toMatchObject({ status: 'running' });
    await expect(handlers[IpcChannels.PluginsRunCommand]!(null, { pluginId: 'echo.playback-panel', commandId: 'show-status' })).resolves.toEqual({ ok: true });
    expect(handlers[IpcChannels.PluginsGetLogs]!(null, 'echo.playback-panel')).toEqual([]);

    expect(serviceMock.createExample).toHaveBeenCalledWith('playback-panel');
    expect(serviceMock.enable).toHaveBeenCalledWith({ pluginId: 'echo.playback-panel' });
    expect(serviceMock.runCommand).toHaveBeenCalledWith({ pluginId: 'echo.playback-panel', commandId: 'show-status' });
  });

  it('rejects malformed plugin IPC payloads before reaching the service', () => {
    expect(() => handlers[IpcChannels.PluginsCreateExample]!(null, 'remote-market')).toThrow('unknown_plugin_example_kind');
    expect(() => handlers[IpcChannels.PluginsEnable]!(null, null)).toThrow('plugin enable request must be an object');
    expect(() => handlers[IpcChannels.PluginsDisable]!(null, '')).toThrow('pluginId must be a non-empty string');
    expect(() => handlers[IpcChannels.PluginsRunCommand]!(null, null)).toThrow('plugin command request must be an object');
  });
});
