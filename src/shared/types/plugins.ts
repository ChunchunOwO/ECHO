export const pluginApiVersion = 1;

export const pluginPermissions = [
  'playback:read',
  'playback:control',
  'library:read',
  'library:write',
  'settings:read',
  'settings:write',
  'network',
  'fs:plugin',
] as const;

export type PluginPermission = (typeof pluginPermissions)[number];

export type PluginPanelContribution = {
  id: string;
  title: string;
  path: string;
};

export type PluginCommandContribution = {
  id: string;
  title: string;
  description?: string;
};

export type PluginManifestContributes = {
  commands?: PluginCommandContribution[];
  panels?: PluginPanelContribution[];
  settings?: Array<{
    id: string;
    title: string;
    description?: string;
  }>;
};

export type PluginManifest = {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  entry?: string;
  panel?: string;
  permissions?: PluginPermission[];
  contributes?: PluginManifestContributes;
};

export type PluginRuntimeStatus = 'disabled' | 'enabled' | 'running' | 'error';

export type PluginLogLevel = 'info' | 'warn' | 'error';

export type PluginLogEntry = {
  id: string;
  pluginId: string;
  level: PluginLogLevel;
  message: string;
  createdAt: string;
};

export type PluginCommand = PluginCommandContribution & {
  pluginId: string;
};

export type PluginSummary = {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  directory: string;
  entry: string | null;
  panel: string | null;
  permissions: PluginPermission[];
  trustedPermissions: PluginPermission[];
  enabled: boolean;
  status: PluginRuntimeStatus;
  error: string | null;
  contributes: PluginManifestContributes;
  commands: PluginCommand[];
};

export type PluginListResult = {
  plugins: PluginSummary[];
  directory: string;
};

export type PluginEnableRequest = {
  pluginId: string;
  trustedPermissions?: PluginPermission[];
};

export type PluginRunCommandRequest = {
  pluginId: string;
  commandId: string;
  args?: unknown[];
};

export type PluginCreateExampleKind = 'playback-panel' | 'command-tool' | 'library-script';

export type PluginCreateExampleResult = {
  pluginId: string;
  directory: string;
};
