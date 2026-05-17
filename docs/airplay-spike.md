# AirPlay Spike

## 目标

AirPlay 只作为独立技术验证，不进入正式 Connect 入口。正式入口必须等到下面四项全部通过：

- iPhone / iPad 可以在同网段发现 ECHO Next。
- 可以稳定播放音频到 Windows 桌面端。
- 标题、艺术家、封面可以稳定同步到 ECHO Next。
- 暂停、继续、停止至少可以双向同步到接收状态。

## 边界

- 本次不新增正式运行时依赖。
- 本次不改变 DLNA 接收服务启动、发现、播放路径。
- AirPlay 失败不得影响 DLNA 状态、错误提示或接收能力。
- 不把音频-only 且没有元数据同步的实现暴露给用户。

## 验证清单

1. 发现能力：确认 Windows 防火墙、mDNS/Bonjour、服务广播端口和设备名。
2. 播放能力：验证 RAOP/AirPlay 1 接收是否能在 Windows 稳定输出音频。
3. 元数据能力：验证标题、艺术家、专辑和封面是否能从客户端同步。
4. 控制能力：验证暂停、继续、停止、切歌后的状态推送。
5. 许可证：任何候选库进入依赖前必须确认许可证可用于 ECHO Next 分发。
6. 失败隔离：AirPlay backend 初始化失败时，Connect 页仍只显示实验不可用，不影响 DLNA。

## 候选方向

| 方向 | 关注点 | 发布判断 |
| --- | --- | --- |
| RAOP / AirPlay 1 receiver | Windows 可用性、音频延迟、元数据事件 | 只有元数据完整才可继续 |
| Apple protocol research libs | 许可证、维护状态、封面同步能力 | 先做本地 spike，不进主线 |
| Native helper process | 崩溃隔离、防火墙提示、端口管理 | 若 JS 实现不稳定再考虑 |

## 主线验收

AirPlay spike 可以在独立分支或实验模块里推进。只要发现、播放、元数据、控制任一项不稳定，正式 UI 保持“实验不可用”，DLNA Receiver V1 继续独立发布。
