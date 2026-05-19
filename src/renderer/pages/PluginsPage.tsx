import { useCallback, useEffect, useMemo, useState } from 'react';
import { Code2, FolderOpen, PackagePlus, Play, Power, RefreshCw, ScrollText, TerminalSquare } from 'lucide-react';
import type { PluginCreateExampleKind, PluginLogEntry, PluginPermission, PluginSummary } from '../../shared/types/plugins';
import { EmptyState } from '../components/ui/EmptyState';
import { getPluginsBridge } from '../utils/echoBridge';

const permissionLabels: Record<PluginPermission, string> = {
  'playback:read': '读取播放状态',
  'playback:control': '控制播放',
  'library:read': '读取曲库',
  'library:write': '修改曲库',
  'settings:read': '读取设置',
  'settings:write': '修改设置',
  network: '访问网络',
  'fs:plugin': '插件目录文件',
};

const exampleLabels: Array<{ kind: PluginCreateExampleKind; label: string; description: string }> = [
  { kind: 'playback-panel', label: '播放状态面板', description: '监听播放状态，带一个可编辑面板。' },
  { kind: 'command-tool', label: '命令工具', description: '注册一个手动执行的工具命令。' },
  { kind: 'library-script', label: '曲库脚本', description: '读取曲库摘要，适合整理类脚本起步。' },
];

const formatError = (error: unknown): string => (error instanceof Error ? error.message : String(error || '插件操作失败'));

const fileUrlFromPath = (path: string): string => `file:///${path.replace(/\\/gu, '/')}`;

const StatusPill = ({ plugin }: { plugin: PluginSummary }): JSX.Element => {
  const label = plugin.error ? '异常' : plugin.status === 'running' ? '运行中' : plugin.enabled ? '已启用' : '未启用';
  return <span className="plugin-status-pill" data-status={plugin.error ? 'error' : plugin.status}>{label}</span>;
};

const PermissionList = ({ permissions }: { permissions: PluginPermission[] }): JSX.Element => (
  <div className="plugin-permissions">
    {permissions.length === 0 ? <span>无额外权限</span> : permissions.map((permission) => <span key={permission}>{permissionLabels[permission]}</span>)}
  </div>
);

export const PluginsPage = (): JSX.Element => {
  const pluginsApi = getPluginsBridge();
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  const [pluginDirectory, setPluginDirectory] = useState('');
  const [logs, setLogs] = useState<PluginLogEntry[]>([]);
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const selectedPlugin = useMemo(
    () => plugins.find((plugin) => plugin.id === selectedPluginId) ?? plugins[0] ?? null,
    [plugins, selectedPluginId],
  );

  const refresh = useCallback(async (): Promise<void> => {
    if (!pluginsApi) {
      return;
    }
    const result = await pluginsApi.list();
    setPlugins(result.plugins);
    setPluginDirectory(result.directory);
    setSelectedPluginId((current) => current ?? result.plugins[0]?.id ?? null);
  }, [pluginsApi]);

  const refreshLogs = useCallback(async (pluginId?: string | null): Promise<void> => {
    if (!pluginsApi) {
      return;
    }
    setLogs(await pluginsApi.getLogs(pluginId ?? undefined));
  }, [pluginsApi]);

  useEffect(() => {
    void refresh().catch((error) => setMessage(formatError(error)));
  }, [refresh]);

  useEffect(() => {
    void refreshLogs(selectedPlugin?.id).catch(() => undefined);
  }, [refreshLogs, selectedPlugin?.id]);

  const runAction = useCallback(
    async (key: string, action: () => Promise<unknown>, success: string): Promise<void> => {
      try {
        setBusyAction(key);
        setMessage(null);
        await action();
        setMessage(success);
        await refresh();
        await refreshLogs(selectedPlugin?.id);
      } catch (error) {
        setMessage(formatError(error));
      } finally {
        setBusyAction(null);
      }
    },
    [refresh, refreshLogs, selectedPlugin?.id],
  );

  const handleEnable = (plugin: PluginSummary): void => {
    if (!pluginsApi) {
      return;
    }
    const permissionText = plugin.permissions.length
      ? plugin.permissions.map((permission) => `- ${permissionLabels[permission]}`).join('\n')
      : '无额外权限';
    const confirmed = window.confirm(`启用插件「${plugin.name}」？\n\n请求权限：\n${permissionText}\n\n坏插件会被隔离并记录日志，但仍建议只启用你信任的本地插件。`);
    if (!confirmed) {
      return;
    }
    void runAction(
      `enable:${plugin.id}`,
      () => pluginsApi.enable({ pluginId: plugin.id, trustedPermissions: plugin.permissions }),
      `已启用 ${plugin.name}`,
    );
  };

  const handleCreateExample = (kind: PluginCreateExampleKind): void => {
    if (!pluginsApi) {
      return;
    }
    void runAction(`example:${kind}`, () => pluginsApi.createExample(kind), '已创建示例插件，可打开目录编辑。');
  };

  const handleRunCommand = (plugin: PluginSummary, commandId: string): void => {
    if (!pluginsApi) {
      return;
    }
    void runAction(
      `command:${plugin.id}:${commandId}`,
      () => pluginsApi.runCommand({ pluginId: plugin.id, commandId }),
      '命令已执行，详情可查看日志。',
    );
  };

  if (!pluginsApi) {
    return (
      <div className="page-stack plugins-page">
        <EmptyState icon={Code2} title="插件系统不可用" description="请在 ECHO Next 桌面端打开插件管理。" />
      </div>
    );
  }

  return (
    <div className="page-stack plugins-page">
      <header className="plain-page-header plugins-header">
        <div>
          <span className="section-kicker">本地插件</span>
          <h1>插件</h1>
          <p>插件默认关闭。启用后只通过受控 API 读取播放、曲库和设置，不会进入音频热路径。</p>
          {pluginDirectory ? <small title={pluginDirectory}>{pluginDirectory}</small> : null}
        </div>
        <div className="plugins-header-actions">
          <button className="settings-action-button" type="button" onClick={() => void pluginsApi.openDirectory()}>
            <FolderOpen size={16} />
            打开插件目录
          </button>
          <button className="settings-action-button" type="button" disabled={busyAction === 'refresh'} onClick={() => void runAction('refresh', refresh, '插件列表已刷新。')}>
            <RefreshCw size={16} />
            刷新
          </button>
        </div>
      </header>

      <section className="plugin-example-grid" aria-label="示例插件">
        {exampleLabels.map((example) => (
          <article className="plugin-example-card" key={example.kind}>
            <PackagePlus size={18} />
            <div>
              <strong>{example.label}</strong>
              <span>{example.description}</span>
            </div>
            <button className="settings-action-button" type="button" disabled={busyAction === `example:${example.kind}`} onClick={() => handleCreateExample(example.kind)}>
              新建
            </button>
          </article>
        ))}
      </section>

      {message ? <p className="plugins-message">{message}</p> : null}

      <main className="plugins-layout">
        <section className="plugins-list" aria-label="插件列表">
          {plugins.length === 0 ? (
            <EmptyState icon={Code2} title="还没有插件" description="新建一个示例插件，或把插件文件夹放进插件目录。" />
          ) : (
            plugins.map((plugin) => (
              <button
                className="plugin-list-item"
                type="button"
                key={plugin.id}
                data-active={selectedPlugin?.id === plugin.id}
                onClick={() => setSelectedPluginId(plugin.id)}
              >
                <span>
                  <strong>{plugin.name}</strong>
                  <em>{plugin.id}</em>
                </span>
                <StatusPill plugin={plugin} />
              </button>
            ))
          )}
        </section>

        <section className="plugin-detail" aria-label="插件详情">
          {selectedPlugin ? (
            <>
              <div className="plugin-detail-head">
                <div>
                  <h2>{selectedPlugin.name}</h2>
                  <p>{selectedPlugin.id} · v{selectedPlugin.version}</p>
                </div>
                <StatusPill plugin={selectedPlugin} />
              </div>

              {selectedPlugin.error ? <p className="plugins-message plugins-message--error">{selectedPlugin.error}</p> : null}

              <PermissionList permissions={selectedPlugin.permissions} />

              <div className="plugin-actions">
                {selectedPlugin.enabled ? (
                  <button className="settings-action-button" type="button" disabled={busyAction === `disable:${selectedPlugin.id}`} onClick={() => void runAction(`disable:${selectedPlugin.id}`, () => pluginsApi.disable(selectedPlugin.id), `已停用 ${selectedPlugin.name}`)}>
                    <Power size={16} />
                    停用
                  </button>
                ) : (
                  <button className="settings-action-button" type="button" disabled={Boolean(selectedPlugin.error) || busyAction === `enable:${selectedPlugin.id}`} onClick={() => handleEnable(selectedPlugin)}>
                    <Power size={16} />
                    启用
                  </button>
                )}
                <button className="settings-action-button" type="button" disabled={busyAction === `reload:${selectedPlugin.id}`} onClick={() => void runAction(`reload:${selectedPlugin.id}`, () => pluginsApi.reload(selectedPlugin.id), `已重载 ${selectedPlugin.name}`)}>
                  <RefreshCw size={16} />
                  重载
                </button>
                <button className="settings-action-button" type="button" onClick={() => void pluginsApi.openDirectory(selectedPlugin.id)}>
                  <FolderOpen size={16} />
                  打开目录
                </button>
              </div>

              <div className="plugin-command-list">
                <header>
                  <TerminalSquare size={17} />
                  <strong>命令</strong>
                </header>
                {selectedPlugin.commands.length === 0 ? (
                  <span>这个插件还没有注册命令。</span>
                ) : (
                  selectedPlugin.commands.map((command) => (
                    <button
                      className="plugin-command-row"
                      type="button"
                      key={`${command.pluginId}:${command.id}`}
                      disabled={!selectedPlugin.enabled || busyAction === `command:${selectedPlugin.id}:${command.id}`}
                      onClick={() => handleRunCommand(selectedPlugin, command.id)}
                    >
                      <Play size={15} />
                      <span>
                        <strong>{command.title}</strong>
                        <em>{command.description ?? command.id}</em>
                      </span>
                    </button>
                  ))
                )}
              </div>

              {selectedPlugin.panel ? (
                <div className="plugin-panel-preview">
                  <header>
                    <Code2 size={17} />
                    <strong>面板预览</strong>
                  </header>
                  <iframe title={`${selectedPlugin.name} panel`} sandbox="allow-scripts" src={fileUrlFromPath(selectedPlugin.panel)} />
                </div>
              ) : null}

              <div className="plugin-log-list">
                <header>
                  <ScrollText size={17} />
                  <strong>日志</strong>
                  <button className="settings-action-button" type="button" onClick={() => void refreshLogs(selectedPlugin.id)}>
                    刷新日志
                  </button>
                </header>
                {logs.length === 0 ? (
                  <span>暂无日志。</span>
                ) : (
                  logs.map((log) => (
                    <p key={log.id} data-level={log.level}>
                      <time>{new Date(log.createdAt).toLocaleTimeString()}</time>
                      <strong>{log.level}</strong>
                      <span>{log.message}</span>
                    </p>
                  ))
                )}
              </div>
            </>
          ) : (
            <EmptyState icon={Code2} title="选择插件" description="选择左侧插件查看权限、命令、日志和面板。" />
          )}
        </section>
      </main>
    </div>
  );
};
