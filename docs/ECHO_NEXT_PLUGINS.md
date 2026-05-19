# ECHO Next 插件系统 v1

ECHO Next v1 插件系统面向本地可编辑插件。插件放在用户数据目录的 `plugins/` 下，默认禁用，用户确认权限后才运行。插件能力通过受控 API 进入主程序，不直接接触 Electron、SQLite、主应用 DOM 或音频对象。

## 目录结构

每个插件是一个独立文件夹：

```text
plugins/
  echo.playback-panel/
    echo.plugin.json
    plugin.js
    panel.html
    plugin-storage.json
```

`plugin-storage.json` 由插件 API 写入，用来保存这个插件自己的数据。用户可以直接编辑 `echo.plugin.json`、`plugin.js`、`panel.html`，编辑后在插件页点击“重载”。

## echo.plugin.json

最小 manifest：

```json
{
  "id": "echo.my-plugin",
  "name": "我的插件",
  "version": "0.0.1",
  "apiVersion": 1,
  "entry": "plugin.js",
  "panel": "panel.html",
  "permissions": ["playback:read"],
  "contributes": {
    "commands": [
      { "id": "show-status", "title": "显示播放状态" }
    ],
    "panels": [
      { "id": "main", "title": "插件面板", "path": "panel.html" }
    ]
  }
}
```

字段说明：

- `id`：小写字母、数字、点、短横线或下划线，作为插件唯一标识。
- `name` / `version`：显示名称和版本。
- `apiVersion`：当前为 `1`。
- `entry`：插件脚本文件名，必须是插件目录内的 `.js` 文件。
- `panel`：可选面板文件名，当前作为 sandbox iframe 预览。
- `permissions`：插件请求的权限，启用时由用户确认。
- `contributes.commands`：插件声明或运行时注册的命令。
- `contributes.panels`：插件声明的面板入口。

## 权限

当前权限列表：

- `playback:read`：读取播放状态。
- `playback:control`：控制播放、暂停、停止、跳转。
- `library:read`：读取曲库摘要和曲目列表。
- `library:write`：预留给曲库写入能力，v1 不建议依赖。
- `settings:read`：读取应用设置。
- `settings:write`：写入应用设置。
- `network`：预留给网络访问能力。
- `fs:plugin`：插件自身目录文件能力；默认只应写自己的存储。

插件默认禁用。缺少已信任权限时，API 会拒绝调用。

## 公开 API

`plugin.js` 中可以使用全局 `echo` 对象。API 都是异步或可安全序列化的调用。

```js
echo.events.on('playback:status', async (status) => {
  await echo.storage.set('lastStatus', {
    state: status.state,
    trackId: status.currentTrackId
  });
});

echo.commands.register('show-status', { title: '显示播放状态' }, async () => {
  const status = await echo.playback.getStatus();
  await echo.ui.notify(`当前播放状态：${status.state}`);
});
```

可用分组：

- `echo.events.on(eventName, handler)`：监听宿主事件。当前常用事件是 `playback:status`，播放状态最多 2Hz 合并推送。
- `echo.commands.register(commandId, options, handler)`：注册插件命令。命令超时会被隔离，不阻塞播放队列。
- `echo.playback.getStatus()`：需要 `playback:read`。
- `echo.playback.play()` / `pause()` / `stop()` / `seek(seconds)`：需要 `playback:control`。
- `echo.library.getSummary()` / `getTracks(query)`：需要 `library:read`。
- `echo.settings.get()` / `set(patch)`：分别需要 `settings:read` / `settings:write`。
- `echo.storage.get(key)` / `set(key, value)`：读写插件自己的存储。
- `echo.ui.notify(message)`：写入插件日志。

## 示例模板

插件页可以创建三类示例：

- 播放状态小面板：监听播放状态，并把最近状态写入插件存储。
- 命令工具：注册一个手动执行的命令。
- 曲库批量整理脚本：读取曲库摘要，作为整理脚本起点。

这些模板只使用公开 API。推荐先复制模板，再逐步改 `plugin.js`。

## 启用、重载和日志

1. 打开“插件”页。
2. 新建示例插件，或把插件文件夹放进 `plugins/`。
3. 点击“刷新”扫描 manifest。
4. 点击“启用”，确认权限。
5. 修改 `plugin.js` 或 `panel.html` 后点击“重载”。
6. 出错时查看插件日志；坏插件只会标红或禁用，不应影响主程序启动。

## 面板状态

v1 的 `panel.html` 作为 sandbox iframe 预览运行，不接触主应用 DOM。当前面板不承诺直接调用宿主 API；面板 `postMessage` API 会作为后续阶段单独设计。

## 安全边界

- 插件不进入音频 DSP、解码、输出或 `audioCommandQueue` 热路径。
- 插件不能直接拿 SQLite 连接、Electron 模块、原生 host 或主应用 DOM。
- 播放状态事件会合并推送，避免高频事件拖慢播放。
- 插件命令有超时保护，失败会记录日志。
- 只启用你信任的本地插件；高风险权限应保持最小化。

## 常见错误

- `plugin_permission_confirmation_required`：启用时没有确认全部请求权限。
- `plugin_permission_denied:*`：插件调用了未获信任的能力。
- `plugin_command_not_found`：manifest 或脚本里没有对应命令。
- `plugin_not_enabled`：插件未启用或已被禁用。
- `apiVersion must be between 1 and 1`：插件 API 版本不兼容。
