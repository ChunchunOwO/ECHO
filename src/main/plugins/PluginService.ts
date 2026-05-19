import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import vm from 'node:vm';
import { app, shell } from 'electron';
import type { AudioStatus } from '../../shared/types/audio';
import type {
  PluginCommand,
  PluginCreateExampleKind,
  PluginCreateExampleResult,
  PluginEnableRequest,
  PluginListResult,
  PluginLogEntry,
  PluginManifest,
  PluginManifestContributes,
  PluginPermission,
  PluginRunCommandRequest,
  PluginSummary,
} from '../../shared/types/plugins';
import { getAppSettings, setAppSettings } from '../app/appSettings';
import { getAudioSession } from '../audio/AudioSession';
import { getLibraryService } from '../library/LibraryService';
import { normalizePluginManifest } from './PluginManifest';

type PluginState = {
  enabled?: boolean;
  trustedPermissions?: PluginPermission[];
};

type PluginStateFile = {
  plugins?: Record<string, PluginState>;
};

type RuntimeCommand = {
  id: string;
  title: string;
  description?: string;
  handler: (...args: unknown[]) => unknown;
};

type RuntimeRecord = {
  manifest: PluginManifest;
  directory: string;
  commands: Map<string, RuntimeCommand>;
  eventHandlers: Map<string, Set<(payload: unknown) => unknown>>;
  statusTimer: ReturnType<typeof setTimeout> | null;
  pendingStatus: AudioStatus | null;
};

type PluginRecord = {
  manifest: PluginManifest | null;
  directory: string;
  enabled: boolean;
  trustedPermissions: PluginPermission[];
  status: PluginSummary['status'];
  error: string | null;
};

const manifestFileName = 'echo.plugin.json';
const stateFileName = 'plugin-state.json';
const storageFileName = 'plugin-storage.json';
const commandTimeoutMs = 2_000;
const maxLogEntries = 160;
const maxEventHandlersPerPlugin = 24;
const playbackStatusThrottleMs = 500;

const exampleTemplates: Record<PluginCreateExampleKind, { id: string; name: string; manifest: PluginManifest; script: string; panel?: string }> = {
  'playback-panel': {
    id: 'echo.playback-panel',
    name: '播放状态面板',
    manifest: {
      id: 'echo.playback-panel',
      name: '播放状态面板',
      version: '0.0.1',
      apiVersion: 1,
      entry: 'plugin.js',
      panel: 'panel.html',
      permissions: ['playback:read'],
      contributes: {
        commands: [{ id: 'show-status', title: '显示当前播放状态' }],
        panels: [{ id: 'main', title: '播放状态', path: 'panel.html' }],
      },
    },
    script: [
      "echo.events.on('playback:status', async (status) => {",
      "  await echo.storage.set('lastStatus', {",
      "    state: status.state,",
      "    trackId: status.currentTrackId,",
      "    positionSeconds: Math.round(status.positionSeconds || 0)",
      "  });",
      '});',
      '',
      "echo.commands.register('show-status', { title: '显示当前播放状态' }, async () => {",
      '  const status = await echo.playback.getStatus();',
      "  await echo.ui.notify(`当前播放状态：${status.state}`);",
      '});',
    ].join('\n'),
    panel: [
      '<!doctype html>',
      '<meta charset="utf-8">',
      '<style>body{font:14px system-ui;margin:16px;color:#1f2937}code{display:block;margin-top:8px;white-space:pre-wrap}</style>',
      '<h1>播放状态面板</h1>',
      '<p>这个面板是静态沙箱页面。插件脚本会把最近播放状态写入自己的 storage。</p>',
      '<code>编辑 panel.html / plugin.js 后，在 ECHO Next 插件页点“重载”。</code>',
    ].join('\n'),
  },
  'command-tool': {
    id: 'echo.command-tool',
    name: '命令工具示例',
    manifest: {
      id: 'echo.command-tool',
      name: '命令工具示例',
      version: '0.0.1',
      apiVersion: 1,
      entry: 'plugin.js',
      permissions: ['playback:read'],
      contributes: {
        commands: [{ id: 'copy-now-playing', title: '记录当前播放' }],
      },
    },
    script: [
      "echo.commands.register('copy-now-playing', { title: '记录当前播放' }, async () => {",
      '  const status = await echo.playback.getStatus();',
      "  await echo.storage.set('lastCommandResult', status.currentTrackId || status.state);",
      "  await echo.ui.notify('已记录当前播放状态到插件存储。');",
      '});',
    ].join('\n'),
  },
  'library-script': {
    id: 'echo.library-script',
    name: '曲库脚本示例',
    manifest: {
      id: 'echo.library-script',
      name: '曲库脚本示例',
      version: '0.0.1',
      apiVersion: 1,
      entry: 'plugin.js',
      permissions: ['library:read'],
      contributes: {
        commands: [{ id: 'count-library', title: '统计曲库数量' }],
      },
    },
    script: [
      "echo.commands.register('count-library', { title: '统计曲库数量' }, async () => {",
      '  const summary = await echo.library.getSummary();',
      "  await echo.ui.notify(`当前曲库约 ${summary.trackCount || 0} 首。`);",
      '});',
    ].join('\n'),
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const jsonClone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)) as T);

const timeout = <T>(promise: Promise<T>, timeoutMs: number): Promise<T> =>
  new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('plugin_command_timeout')), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

export class PluginService {
  private records = new Map<string, PluginRecord>();
  private runtimes = new Map<string, RuntimeRecord>();
  private logs: PluginLogEntry[] = [];
  private state: Required<PluginStateFile> = { plugins: {} };
  private autoStartScheduled = false;
  private audioStatusSubscribed = false;

  constructor(private readonly pluginDirectory = join(app.getPath('userData'), 'plugins')) {}

  list(): PluginListResult {
    this.scan();
    return {
      directory: this.pluginDirectory,
      plugins: [...this.records.values()].map((record) => this.toSummary(record)),
    };
  }

  scheduleAutoStart(): void {
    if (this.autoStartScheduled) {
      return;
    }

    this.autoStartScheduled = true;
    setTimeout(() => {
      try {
        this.scan();
        for (const record of this.records.values()) {
          if (record.enabled) {
            void this.startPlugin(record.manifest?.id ?? basename(record.directory)).catch((error) => {
              this.markError(record, error);
            });
          }
        }
      } catch (error) {
        this.log('host', 'error', `插件启动失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }, 1_200);
  }

  enable(request: PluginEnableRequest): PluginSummary {
    this.scan();
    const record = this.requireRecord(request.pluginId);
    if (!record.manifest) {
      throw new Error(record.error ?? 'plugin_manifest_invalid');
    }

    const requestedPermissions = record.manifest.permissions ?? [];
    const trustedPermissions = this.normalizeTrustedPermissions(request.trustedPermissions ?? [], requestedPermissions);
    if (requestedPermissions.some((permission) => !trustedPermissions.includes(permission))) {
      throw new Error('plugin_permission_confirmation_required');
    }

    this.state.plugins[record.manifest.id] = {
      enabled: true,
      trustedPermissions,
    };
    this.writeState();
    record.enabled = true;
    record.trustedPermissions = trustedPermissions;
    void this.startPlugin(record.manifest.id).catch((error) => this.markError(record, error));
    return this.toSummary(record);
  }

  disable(pluginId: string): PluginSummary {
    this.scan();
    const record = this.requireRecord(pluginId);
    const id = record.manifest?.id ?? pluginId;
    this.stopPlugin(id);
    this.state.plugins[id] = {
      ...this.state.plugins[id],
      enabled: false,
    };
    this.writeState();
    record.enabled = false;
    record.status = 'disabled';
    return this.toSummary(record);
  }

  async reload(pluginId: string): Promise<PluginSummary> {
    this.scan();
    const record = this.requireRecord(pluginId);
    const id = record.manifest?.id ?? pluginId;
    this.stopPlugin(id);
    this.records.delete(id);
    this.scan();
    const refreshed = this.requireRecord(id);
    if (refreshed.enabled && refreshed.manifest) {
      await this.startPlugin(refreshed.manifest.id);
    }
    return this.toSummary(refreshed);
  }

  async openDirectory(pluginId?: string): Promise<void> {
    this.scan();
    const target = pluginId ? this.requireRecord(pluginId).directory : this.pluginDirectory;
    mkdirSync(target, { recursive: true });
    await shell.openPath(target);
  }

  createExample(kind: PluginCreateExampleKind): PluginCreateExampleResult {
    const template = exampleTemplates[kind];
    if (!template) {
      throw new Error('unknown_plugin_example_kind');
    }

    const directory = join(this.pluginDirectory, template.id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, manifestFileName), `${JSON.stringify(template.manifest, null, 2)}\n`, 'utf8');
    writeFileSync(join(directory, template.manifest.entry ?? 'plugin.js'), `${template.script}\n`, 'utf8');
    if (template.panel && template.manifest.panel) {
      writeFileSync(join(directory, template.manifest.panel), `${template.panel}\n`, 'utf8');
    }
    this.log(template.id, 'info', `已创建示例插件：${template.name}`);
    this.scan();
    return { pluginId: template.id, directory };
  }

  async runCommand(request: PluginRunCommandRequest): Promise<unknown> {
    this.scan();
    const record = this.requireRecord(request.pluginId);
    if (!record.enabled || !record.manifest) {
      throw new Error('plugin_not_enabled');
    }

    const runtime = await this.ensureRuntime(record.manifest.id);
    const command = runtime.commands.get(request.commandId);
    if (!command) {
      throw new Error('plugin_command_not_found');
    }

    this.log(record.manifest.id, 'info', `运行命令：${command.title}`);
    try {
      return await timeout(Promise.resolve(command.handler(...(Array.isArray(request.args) ? request.args : []))).then(jsonClone), commandTimeoutMs);
    } catch (error) {
      this.log(record.manifest.id, 'error', `命令失败：${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  getLogs(pluginId?: string): PluginLogEntry[] {
    return this.logs.filter((entry) => !pluginId || entry.pluginId === pluginId);
  }

  emitLibraryChanged(payload: unknown): void {
    this.dispatchEvent('library:changed', payload);
  }

  private scan(): void {
    mkdirSync(this.pluginDirectory, { recursive: true });
    this.state = this.readState();
    const seen = new Set<string>();

    for (const item of readdirSync(this.pluginDirectory, { withFileTypes: true })) {
      if (!item.isDirectory()) {
        continue;
      }

      const directory = join(this.pluginDirectory, item.name);
      const manifestPath = join(directory, manifestFileName);
      let manifest: PluginManifest | null = null;
      let error: string | null = null;
      try {
        if (!existsSync(manifestPath)) {
          throw new Error(`missing ${manifestFileName}`);
        }
        manifest = normalizePluginManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), item.name);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }

      const id = manifest?.id ?? item.name;
      seen.add(id);
      const persisted = this.state.plugins[id] ?? {};
      const current = this.records.get(id);
      this.records.set(id, {
        manifest,
        directory,
        enabled: persisted.enabled === true,
        trustedPermissions: this.normalizeTrustedPermissions(persisted.trustedPermissions ?? [], manifest?.permissions ?? []),
        status: persisted.enabled === true ? current?.status ?? 'enabled' : 'disabled',
        error: error ?? current?.error ?? null,
      });
    }

    for (const id of [...this.records.keys()]) {
      if (!seen.has(id)) {
        this.stopPlugin(id);
        this.records.delete(id);
      }
    }
  }

  private async ensureRuntime(pluginId: string): Promise<RuntimeRecord> {
    const existing = this.runtimes.get(pluginId);
    if (existing) {
      return existing;
    }
    const record = this.requireRecord(pluginId);
    await this.startPlugin(pluginId);
    return this.runtimes.get(pluginId) ?? this.createEmptyRuntime(record);
  }

  private async startPlugin(pluginId: string): Promise<void> {
    this.scan();
    const record = this.requireRecord(pluginId);
    if (!record.manifest) {
      throw new Error(record.error ?? 'plugin_manifest_invalid');
    }
    if (!record.enabled) {
      return;
    }

    this.stopPlugin(record.manifest.id);
    const runtime = this.createEmptyRuntime(record);
    this.runtimes.set(record.manifest.id, runtime);
    this.subscribeAudioStatus();

    const entry = record.manifest.entry ? join(record.directory, record.manifest.entry) : null;
    if (entry && existsSync(entry)) {
      const script = readFileSync(entry, 'utf8');
      const context = vm.createContext({
        console: {
          log: (...args: unknown[]) => this.log(record.manifest!.id, 'info', args.map(String).join(' ')),
          warn: (...args: unknown[]) => this.log(record.manifest!.id, 'warn', args.map(String).join(' ')),
          error: (...args: unknown[]) => this.log(record.manifest!.id, 'error', args.map(String).join(' ')),
        },
        echo: this.createSandboxApi(record, runtime),
        setTimeout,
        clearTimeout,
      });
      vm.runInContext(script, context, { timeout: 1_000, filename: entry });
    }

    record.status = 'running';
    record.error = null;
    this.log(record.manifest.id, 'info', '插件已启动。');
  }

  private stopPlugin(pluginId: string): void {
    const runtime = this.runtimes.get(pluginId);
    if (!runtime) {
      return;
    }

    if (runtime.statusTimer) {
      clearTimeout(runtime.statusTimer);
    }
    this.runtimes.delete(pluginId);
  }

  private createEmptyRuntime(record: PluginRecord): RuntimeRecord {
    if (!record.manifest) {
      throw new Error('plugin_manifest_invalid');
    }
    return {
      manifest: record.manifest,
      directory: record.directory,
      commands: new Map(),
      eventHandlers: new Map(),
      statusTimer: null,
      pendingStatus: null,
    };
  }

  private createSandboxApi(record: PluginRecord, runtime: RuntimeRecord): unknown {
    const requirePermission = (permission: PluginPermission): void => {
      if (!record.trustedPermissions.includes(permission)) {
        throw new Error(`plugin_permission_denied:${permission}`);
      }
    };

    return Object.freeze({
      events: Object.freeze({
        on: (eventName: string, handler: unknown): (() => void) => {
          if (typeof eventName !== 'string' || typeof handler !== 'function') {
            throw new Error('plugin_event_handler_invalid');
          }
          const handlers = runtime.eventHandlers.get(eventName) ?? new Set<(payload: unknown) => unknown>();
          if (handlers.size >= maxEventHandlersPerPlugin) {
            throw new Error('plugin_event_handler_limit');
          }
          handlers.add(handler as (payload: unknown) => unknown);
          runtime.eventHandlers.set(eventName, handlers);
          return () => handlers.delete(handler as (payload: unknown) => unknown);
        },
      }),
      commands: Object.freeze({
        register: (commandId: string, options: { title?: unknown; description?: unknown } | ((...args: unknown[]) => unknown), handler?: (...args: unknown[]) => unknown): void => {
          const actualHandler = typeof options === 'function' ? options : handler;
          if (typeof commandId !== 'string' || !commandId.trim() || typeof actualHandler !== 'function') {
            throw new Error('plugin_command_invalid');
          }
          runtime.commands.set(commandId.trim(), {
            id: commandId.trim(),
            title: isRecord(options) && typeof options.title === 'string' && options.title.trim() ? options.title.trim() : commandId.trim(),
            description: isRecord(options) && typeof options.description === 'string' && options.description.trim() ? options.description.trim() : undefined,
            handler: actualHandler,
          });
        },
      }),
      playback: Object.freeze({
        getStatus: async () => {
          requirePermission('playback:read');
          return jsonClone(getAudioSession().getStatus());
        },
        play: async () => {
          requirePermission('playback:control');
          return jsonClone(await getAudioSession().play());
        },
        pause: async () => {
          requirePermission('playback:control');
          return jsonClone(await getAudioSession().pause());
        },
        stop: async () => {
          requirePermission('playback:control');
          return jsonClone(getAudioSession().stop());
        },
        seek: async (positionSeconds: unknown) => {
          requirePermission('playback:control');
          const safePosition = typeof positionSeconds === 'number' && Number.isFinite(positionSeconds) ? Math.max(0, positionSeconds) : 0;
          return jsonClone(await getAudioSession().seek(safePosition));
        },
      }),
      library: Object.freeze({
        getSummary: async () => {
          requirePermission('library:read');
          return jsonClone(getLibraryService().getSummary());
        },
        getTracks: async (query: unknown) => {
          requirePermission('library:read');
          return jsonClone(getLibraryService().getTracks(isRecord(query) ? query : undefined));
        },
      }),
      settings: Object.freeze({
        get: async () => {
          requirePermission('settings:read');
          return jsonClone(getAppSettings());
        },
        set: async (patch: unknown) => {
          requirePermission('settings:write');
          return jsonClone(setAppSettings(isRecord(patch) ? patch : {}));
        },
      }),
      storage: Object.freeze({
        get: async (key: unknown) => this.readPluginStorageValue(record, String(key ?? '')),
        set: async (key: unknown, value: unknown) => this.writePluginStorageValue(record, String(key ?? ''), value),
      }),
      ui: Object.freeze({
        notify: async (message: unknown) => {
          this.log(record.manifest?.id ?? 'unknown', 'info', String(message ?? ''));
        },
      }),
    });
  }

  private readPluginStorageValue(record: PluginRecord, key: string): unknown {
    const storage = this.readPluginStorage(record.directory);
    return jsonClone(storage[key]);
  }

  private writePluginStorageValue(record: PluginRecord, key: string, value: unknown): void {
    const safeKey = key.trim().slice(0, 96);
    if (!safeKey) {
      throw new Error('plugin_storage_key_invalid');
    }
    const storage = this.readPluginStorage(record.directory);
    storage[safeKey] = jsonClone(value);
    writeFileSync(join(record.directory, storageFileName), `${JSON.stringify(storage, null, 2)}\n`, 'utf8');
  }

  private readPluginStorage(directory: string): Record<string, unknown> {
    const path = join(directory, storageFileName);
    if (!existsSync(path)) {
      return {};
    }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  private subscribeAudioStatus(): void {
    if (this.audioStatusSubscribed) {
      return;
    }
    this.audioStatusSubscribed = true;
    getAudioSession().on('status', (status: AudioStatus) => {
      for (const runtime of this.runtimes.values()) {
        if (!runtime.eventHandlers.has('playback:status')) {
          continue;
        }
        runtime.pendingStatus = status;
        if (runtime.statusTimer) {
          continue;
        }
        runtime.statusTimer = setTimeout(() => {
          runtime.statusTimer = null;
          const pending = runtime.pendingStatus;
          runtime.pendingStatus = null;
          if (pending) {
            this.dispatchEventToRuntime(runtime, 'playback:status', pending);
          }
        }, playbackStatusThrottleMs);
      }
    });
  }

  private dispatchEvent(eventName: string, payload: unknown): void {
    for (const runtime of this.runtimes.values()) {
      this.dispatchEventToRuntime(runtime, eventName, payload);
    }
  }

  private dispatchEventToRuntime(runtime: RuntimeRecord, eventName: string, payload: unknown): void {
    const handlers = runtime.eventHandlers.get(eventName);
    if (!handlers || handlers.size === 0) {
      return;
    }

    for (const handler of handlers) {
      try {
        void Promise.resolve(handler(jsonClone(payload))).catch((error) => {
          this.log(runtime.manifest.id, 'error', `事件处理失败：${error instanceof Error ? error.message : String(error)}`);
        });
      } catch (error) {
        this.log(runtime.manifest.id, 'error', `事件处理失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private toSummary(record: PluginRecord): PluginSummary {
    const manifest = record.manifest;
    const runtime = manifest ? this.runtimes.get(manifest.id) : null;
    const contributes: PluginManifestContributes = manifest?.contributes ?? {};
    const commands: PluginCommand[] = [
      ...(contributes.commands ?? []).map((command) => ({ ...command, pluginId: manifest?.id ?? basename(record.directory) })),
      ...(runtime ? [...runtime.commands.values()].map((command) => ({
        id: command.id,
        title: command.title,
        description: command.description,
        pluginId: manifest?.id ?? basename(record.directory),
      })) : []),
    ];

    return {
      id: manifest?.id ?? basename(record.directory),
      name: manifest?.name ?? basename(record.directory),
      version: manifest?.version ?? '0.0.0',
      apiVersion: manifest?.apiVersion ?? 0,
      directory: record.directory,
      entry: manifest?.entry ?? null,
      panel: manifest?.panel ? resolve(record.directory, manifest.panel) : null,
      permissions: manifest?.permissions ?? [],
      trustedPermissions: record.trustedPermissions,
      enabled: record.enabled,
      status: record.error ? 'error' : record.enabled ? record.status : 'disabled',
      error: record.error,
      contributes,
      commands: commands.filter((command, index, list) => list.findIndex((item) => item.id === command.id) === index),
    };
  }

  private requireRecord(pluginId: string): PluginRecord {
    const record = this.records.get(pluginId);
    if (!record) {
      throw new Error('plugin_not_found');
    }
    return record;
  }

  private normalizeTrustedPermissions(value: unknown, requested: PluginPermission[]): PluginPermission[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return requested.filter((permission) => value.includes(permission));
  }

  private readState(): Required<PluginStateFile> {
    const path = join(this.pluginDirectory, stateFileName);
    if (!existsSync(path)) {
      return { plugins: {} };
    }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as PluginStateFile;
      return { plugins: isRecord(parsed.plugins) ? parsed.plugins as Record<string, PluginState> : {} };
    } catch {
      return { plugins: {} };
    }
  }

  private writeState(): void {
    mkdirSync(this.pluginDirectory, { recursive: true });
    writeFileSync(join(this.pluginDirectory, stateFileName), `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
  }

  private markError(record: PluginRecord, error: unknown): void {
    record.status = 'error';
    record.error = error instanceof Error ? error.message : String(error);
    this.log(record.manifest?.id ?? basename(record.directory), 'error', record.error);
  }

  private log(pluginId: string, level: PluginLogEntry['level'], message: string): void {
    this.logs.push({
      id: randomUUID(),
      pluginId,
      level,
      message,
      createdAt: new Date().toISOString(),
    });
    if (this.logs.length > maxLogEntries) {
      this.logs.splice(0, this.logs.length - maxLogEntries);
    }
  }
}

let pluginService: PluginService | null = null;

export const getPluginService = (): PluginService => {
  pluginService ??= new PluginService();
  return pluginService;
};
