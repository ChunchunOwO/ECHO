# ECHO Next 音频稳定性审计 — 2026-05-18

> 范围:`native/audio-host`、`native/audio-engine`、`src/main/audio`、`src/main/ipc`
> 方法:静态代码审计 + 与项目自有 `AUDIO_STABILITY_REVIEW_2026-05.md` / `audio-stability-overhaul.md` 交叉比对
> 重点维度:① 断音/爆音/咔哒 ② 延迟与抖动 ③ 电平/失真 ④ 内存与线程安全

---

## 总评分

| 维度 | 得分 | 等级 | 一句话总结 |
|---|---|---|---|
| 断音 / 爆音 / 咔哒 (declick) | **55 / 100** | C | 缺少 PCM 层级的淡入淡出,转场只在 AutoMix 路径用 FFmpeg 处理 |
| 延迟与抖动 (latency / jitter) | **68 / 100** | B− | 有 MMCSS 与事件驱动,但软件层命令队列、IPC、协议无 QoS |
| 电平 / 失真 (clipping / SNR) | **60 / 100** | C+ | 浮点→整数无 dither,EQ +18dB headroom 仅"标记"不"实施"限幅 |
| 内存 / 线程安全 | **62 / 100** | C+ | 异常路径与超时路径有资源未释放;ASIO 回调完全无异常防护 |
| **加权综合** | **61 / 100** | **C+** | 工程化框架已经成熟,DSP/异常细节仍欠打磨 |

**加权方式**:断音 30% + 延迟 25% + 电平 20% + 内存线程 25%。

定性结论:项目自带的 13 项 Stability Overhaul 已经把"会让用户感知到的崩溃 / 卡死类故障"砍掉大半(初始化超时、设备失效、独占被抢、Watchdog 误判等都有 fix),目前剩下的问题集中在**单次操作产生的可听 artefact**(切换/Seek/参数变更)与**长时间运行的资源累积**。换言之:不会再随便卡死,但仍能"听出来不专业"。

---

## High 风险问题清单(按优先级)

### H-1 ASIO bufferSwitch 回调完全无异常防护
**文件**:`native/audio-host/src/asio_host.cpp:1132-1143`
```cpp
void asio_buffer_switch(long index, ASIOBool processNow) {
    (void)processNow;
    render_asio_output(index);          // 未 try-catch
}
ASIOTime* asio_buffer_switch_time_info(ASIOTime* params, long index, ASIOBool processNow) {
    (void)processNow;
    render_asio_output(index);          // 同上
    return params;
}
```
**风险**:`render_asio_output` 内部会做格式转换、混音、量化、DSD 重打包,任一处抛出 C++ 异常会**直接穿透到 ASIO 驱动**,通常表现为 host 进程崩溃 + Windows 错误音 + 用户必须手动重启播放。WASAPI 渲染线程已经做了完整 try/catch(`wasapi_exclusive.cpp:1110-1145`),但 ASIO 没做。
**建议**:把两个回调改为 `try { render_asio_output(index); } catch (...) { /* 静音填充 driver buffer + InterlockedExchange(&renderFailed,1) */ }`,与 WASAPI 路径对齐。

---

### H-2 设备切换 / Seek 时 PCM 层无 declick ramp
**文件**:`src/main/audio/NativeOutputBridge.ts:804-858`、`src/main/audio/AudioSession.ts:2129-2147`、全仓 `grep -n "ramp\|fade\|declick"` 仅命中 FFmpeg `acrossfade` 转场
```ts
stop(): void {
  // 直接 destroy stdin、SIGKILL,无 fade 帧
  this.proc.kill('SIGKILL');
}
```
**风险**:仓库内**没有任何 PCM 层的淡入淡出代码**,所有"软停止"实际是从产生数据侧停止 + 子进程吃完 FIFO 残留。当用户:
- 切换输出设备
- 暂停时 seek
- 触发降级 fallback(Exclusive → Shared)
- 解码错误中断

…都会让最后一个 buffer 以非零电平硬截断,DAC 会有明显的 **pop / click**。AutoMix 转场是另一回事,走 FFmpeg `acrossfade`,这条路径没事。
**建议**:在 `audio-host` 端实现 5~10ms 的硬件层 ramp-to-silence(在 FIFO 上抹尾巴),或在 `DecoderPipeline` 出口处加一个简短淡出 Transform。任何 `bridge.stop()` 路径前先写一帧静音过渡。

---

### H-3 EQ +18dB 总增益仅"标记风险"未"限幅"
**文件**:`native/audio-engine/EqProcessor.cpp:116-117`、EqBand 增益上下文
```cpp
if (std::abs(samples[sample]) > 0.98f)
    risk = true;                        // 只设标志,没拦截
```
**计算**:EQ 单频段最高 +12dB(4×),preamp 最高 +6dB(2×),叠加 **8 倍**幅度增益。任何峰值 > 0.125 的素材在 boost 后就会 clip。而代码只在 `risk` 标志位记录,**不衰减、不软限幅、无 lookahead limiter**。下游 `clamp_sample()`(`asio_host.cpp:293-295`)是硬截断,直接产生方波谐波。
**建议**:
1. 在 EQ 后接一个 ~6dB headroom 的软限幅(`tanh` 或简单 brickwall 都行)。
2. 或在前端做 auto makeup gain(随 preamp 反相位下调)。
3. UI 上把"风险"信号显示出来(很多 DAW 这么做)。

---

### H-4 WASAPI Exclusive 异常 / 超时路径资源不释放
**文件**:`native/audio-host/src/wasapi_exclusive.cpp:1110-1145`、`:1425-1435`
```cpp
} catch (...) {
    runtime->renderClient->ReleaseBuffer(framesAvailable, AUDCLNT_BUFFERFLAGS_SILENT);
    InterlockedExchange(&runtime->renderFailed, 1);
    break;                              // scratch / dopScratch / COM 对象都没释放
}
…
if (waitResult != WAIT_OBJECT_0) {     // 线程 5s 没退
    CloseHandle(runtime->thread);
    return;                             // IAudioClient / IRenderClient 全留给 OS
}
```
**风险**:在长时间运行(>24h)+ 频繁设备切换 / 异常路径触发的场景下,**进程内 COM 对象、scratch 内存、event handle 会累积**。配合 audio-host 子进程隔离,影响有限,但仍会拖慢响应。
**建议**:用 RAII 包(`std::unique_ptr` + 自定义 deleter)替代手工 release,或在 `return` 前统一调度一个 cleanup 任务。

---

### H-5 audioCommandQueue 统一 15s 超时 + 无背压
**文件**:`src/main/ipc/audioCommandQueue.ts:1-51`
```ts
const AUDIO_COMMAND_TIMEOUT_MS = 15_000;
```
**风险**:`seek`、`pause`、`setVolume`、`changeDevice` 都共享同一个 Promise 链。任意一条慢命令(尤其切换独占设备时 Initialize 可能要数秒)会**让其他命令排队**。15s 超时太长 — UI 上会出现"按了没反应、然后突然连续生效"的体感。
**建议**:
- 按命令类型分桶(`seek` 队列、`device` 队列、`mixer` 队列各自独立)。
- 超时分级(volume 200ms,seek 2s,device 15s)。
- 加 in-flight depth metric,UI 拿来做 spinner。

---

## Medium 风险问题清单

### M-1 Biquad 状态在系数切换时不清零
**文件**:`native/audio-engine/EqProcessor.cpp:95-100`、`EqBand.h:35-50`
EqProcessor 已经做了**逐样本系数平滑**(`smoothedPreampDb`、`smoothedBandGains`),但 `BiquadState.x1/x2/y1/y2` 在用户改频率 / Q 时不会 reset(只在 `EqProcessor::reset()` 和 `resetFlat()` 时 reset)。从 +12dB 峰滤一秒内切到 -12dB 陷波,旧的反馈项会贡献 1~2 个样本的尖峰。
**严重度**:Medium(因为平滑过渡覆盖了大部分场景)。
**建议**:大幅参数跳变(`|Δf|/f > 0.2` 或 `|ΔgainDb| > 6`)时显式调 `filters[band].reset()`。

### M-2 浮点→整数量化无 dither
**文件**:`native/audio-host/src/asio_host.cpp:267-290`、`wasapi_shared.cpp:1074-1080`
```cpp
return static_cast<int32_t>(clamped * peak);   // truncation, no TPDF dither
```
**风险**:16/24 bit 输出时,低电平信号会产生量化失真(可听阈值 < -60dBFS)。Hi-Fi 播放器自我定位下,**这点会被发烧友挑出来**。
**建议**:24bit 加 TPDF dither(0.5LSB),16bit 加 noise-shaped dither。

### M-3 EQ 协议无 throttle,UI 拖滑块产生消息洪水
**文件**:`src/main/audio/EqBridge.ts`(`socket.write` 直发)
快速拖 slider 可能 100Hz 发 JSON 命令,TCP 缓冲区堆积 + EqProcessor 每个块都 `updateTargetSnapshot`,会放大 jitter 与系数离散更新。
**建议**:`EqBridge` 端做 8ms / 16ms 节流;`EqMessageProtocol` 端拿到 burst 后取最后一条。

### M-4 PlaybackClock 是纯逻辑时钟,无设备时钟反馈
**文件**:`src/main/audio/PlaybackClock.ts:24-35`
位置基于本地帧计数线性外推,最多容许 250ms 漂移。长曲(>10 分钟)+ 设备时钟偏 50ppm 时,UI 进度会与实际偏离 30ms+。看不出来但 lyrics 同步会被发现。
**建议**:周期拉 `audio-host` 实测的 `GetPosition` 做 PLL 闭环修正。

### M-5 Bridge 事件监听器堆积
**文件**:`src/main/audio/AudioSession.ts:4102-4169`
`detachBridgeEvents` 通过 `bridge.off ?? bridge.removeListener`,若 mock / 子类不实现就**直接跳过**,长会话内监听器会增长。
**建议**:detach 失败时记日志 + 失败强制 `removeAllListeners`。

### M-6 子进程崩溃只抛 error,无自动重启
**文件**:`src/main/audio/NativeOutputBridge.ts:601-637`
非 0 退出码只 `emit('error', ...)`,AudioSession 收到就停。volume / position 已经在主进程内存里(没问题),但用户需要手点继续。
**建议**:对 `device_initialize_timeout` / `exclusive_denied` 之外的崩溃,做 1 次自动重启(指数退避 250ms→1s→4s)。

### M-7 DSD/DoP 启动参数路径有交叉风险
**文件**:`src/main/audio/NativeOutputBridge.ts:988-993`
`dop24le` 触发 `-dop-output`;`dsd-native-raw` **同时**触发 `-dop-output` + `-asio-native-dsd-output`。后者依赖 native 端正确解释组合标志。需要 host 端做明确互斥校验,否则把 DOP 帧当作 raw DSD 推 DAC 会非常难听(超声噪声)。
**建议**:`asio_host.cpp` 启动时把矛盾标志组合直接 fail-fast。

### M-8 `CoTaskMemFree` 在分支路径上潜在重复释放
**文件**:`native/audio-host/src/main.cpp:694, 699, 736, 743`
某些错误分支释放 `rawId`,落到统一释放点又释放一次。当前 Windows 实现对 NULL 安全,但若中间路径把指针重赋,二次释放会撞堆。
**建议**:释放后立即 `rawId = nullptr`。

---

## Low 风险问题清单

| 编号 | 位置 | 简述 |
|---|---|---|
| L-1 | `wasapi_shared.cpp:1228` | `padding >= bufferFrameCount` 时 continue **是正确的**(不是 underrun,是反压等事件) — 这里没问题,记录是为了澄清 |
| L-2 | `wasapi_shared.cpp:1252` | `ReleaseBuffer(..., SILENT)` 当 scratch 不够时已写静音 — 也没问题,澄清 |
| L-3 | `asio_host.cpp:1055` | DSD scratch 用 `0x69` 填充 — 这是 ASIO 圈惯例(对应 DSD 静音),非 bug,但应加注释 |
| L-4 | `ChannelBalanceProcessor.cpp:307-322` | const-power pan 每样本算 `cos/sin/sqrt`,48kHz × 20ms = 960 次。CPU 影响低,可用查表优化 |
| L-5 | `AudioSession.ts:4189-4190` | `PcmLevelMeterTransform` 回调同步运行;实际只做 max 累计,但建议改 `setImmediate` 解耦 UI 路径 |
| L-6 | `main.cpp` 原子计数 `memory_order_relaxed` | 仅用于诊断遥测,不影响正确性,但读取时报的数字可能短暂不一致 |

---

## 与项目自有审计的对照

`docs/AUDIO_STABILITY_REVIEW_2026-05.md` + `audio-stability-overhaul.md` 已记录的 13 项 Fix 主要解决:
- 启动卡死 / 初始化超时
- 设备被抢 / 拔出感知
- 独占模式失效自动重建
- Watchdog 误判
- SMTC 优雅退出
- 软 / 硬重启兜底

本报告列出的问题与之**互补**,主要不在"会不会崩"层面,而在"听感细节、长跑健康度、参数交互流畅度"。已记录但仍 Open 的项目自评条目(HLS 解码、reconnect 退避、共享模式失败 backend 切换、预拉取)本审计未重复列出。

---

## 优先修复建议(按 ROI 排序)

1. **H-1 ASIO 回调 try/catch** — 一行代码量,杜绝最坏崩溃。
2. **H-2 PCM declick ramp** — 工程量中等,但用户体感巨大,任何 hi-fi 软件该有。
3. **H-3 EQ 软限幅** — DSP 一段 tanh / lookahead,避免发烧用户加 boost 后失真。
4. **H-5 命令队列分桶** — 改善切歌 / 切设备时的 UI 卡顿。
5. **H-4 资源 RAII** — 长跑稳定性 + 内存可观测。
6. **M-2 dither** — 与 Hi-Fi 定位强相关,工程量小。
7. **M-3 EQ throttle** — 提升参数交互手感。

---

*审计完成日期*:2026-05-18
*审计方法*:静态代码 grep + 关键路径精读(`asio_host.cpp` `wasapi_exclusive.cpp` `wasapi_shared.cpp` `EqProcessor.cpp` `EqBand.h` `ChannelBalanceProcessor.cpp` `AudioSession.ts` `NativeOutputBridge.ts` `audioCommandQueue.ts` 等约 2 万行)
*未验证*:实际运行时 jitter 频次、CPU profiling、长跑内存曲线。这些建议用 PerfView / Spectrum / RTL Audio Tester 实测一轮再加补充。
