// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PluginsPage } from './PluginsPage';
import type { PluginSummary } from '../../shared/types/plugins';

const plugins: PluginSummary[] = [
  {
    id: 'echo.playback-panel',
    name: '播放状态面板',
    version: '0.0.1',
    apiVersion: 1,
    directory: 'D:\\Echo\\plugins\\echo.playback-panel',
    entry: 'plugin.js',
    panel: 'D:\\Echo\\plugins\\echo.playback-panel\\panel.html',
    permissions: ['playback:read'],
    trustedPermissions: [],
    enabled: false,
    status: 'disabled',
    error: null,
    contributes: {
      commands: [{ id: 'show-status', title: '显示状态' }],
    },
    commands: [{ id: 'show-status', title: '显示状态', pluginId: 'echo.playback-panel' }],
  },
];

const pluginsBridge = {
  list: vi.fn(async () => ({ directory: 'D:\\Echo\\plugins', plugins })),
  createExample: vi.fn(async () => ({ pluginId: 'echo.playback-panel', directory: 'D:\\Echo\\plugins\\echo.playback-panel' })),
  enable: vi.fn(async () => ({ ...plugins[0], enabled: true, status: 'running', trustedPermissions: ['playback:read'] })),
  disable: vi.fn(async () => ({ ...plugins[0], enabled: false, status: 'disabled' })),
  reload: vi.fn(async () => plugins[0]),
  openDirectory: vi.fn(async () => undefined),
  runCommand: vi.fn(async () => undefined),
  getLogs: vi.fn(async () => [{ id: 'log-1', pluginId: 'echo.playback-panel', level: 'info' as const, message: '已启动', createdAt: '2026-05-19T00:00:00.000Z' }]),
};

vi.mock('../utils/echoBridge', () => ({
  getPluginsBridge: () => pluginsBridge,
}));

vi.mock('../components/ui/EmptyState', () => ({
  EmptyState: ({ title, description }: { title: string; description?: string }) => (
    <div>
      <strong>{title}</strong>
      {description ? <span>{description}</span> : null}
    </div>
  ),
}));

describe('PluginsPage', () => {
  beforeEach(() => {
    Object.values(pluginsBridge).forEach((mock) => mock.mockClear());
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('renders local plugin management and loads logs for the selected plugin', async () => {
    render(<PluginsPage />);

    expect(await screen.findByRole('heading', { name: '插件' })).toBeTruthy();
    expect((await screen.findAllByText('播放状态面板')).length).toBeGreaterThan(0);
    expect(screen.getByText('读取播放状态')).toBeTruthy();
    expect(await screen.findByText('已启动')).toBeTruthy();
    expect(pluginsBridge.list).toHaveBeenCalledTimes(1);
    expect(pluginsBridge.getLogs).toHaveBeenCalledWith('echo.playback-panel');
  });

  it('confirms requested permissions before enabling a plugin', async () => {
    render(<PluginsPage />);

    const enableButtons = await screen.findAllByRole('button', { name: /启用/u });
    fireEvent.click(enableButtons.find((button) => button.className.includes('settings-action-button'))!);

    await waitFor(() => expect(pluginsBridge.enable).toHaveBeenCalledWith({
      pluginId: 'echo.playback-panel',
      trustedPermissions: ['playback:read'],
    }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('读取播放状态'));
  });

  it('creates example plugins from the management page', async () => {
    render(<PluginsPage />);

    const createButtons = await screen.findAllByRole('button', { name: '新建' });
    fireEvent.click(createButtons[0]);

    await waitFor(() => expect(pluginsBridge.createExample).toHaveBeenCalledWith('playback-panel'));
  });
});
