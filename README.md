<p align="center">
  <img src="./logo.png" alt="ECHO NEXT" width="520" />
</p>

<h1 align="center">ECHO NEXT</h1>

<p align="center">
  <strong>Open-Source Hybrid Music Player</strong>
</p>

<p align="center">
  面向本地音乐库、HiFi 输出和长期可维护架构的跨平台桌面播放器。
</p>

<p align="center">
  <a href="https://github.com/moekotori/echo/releases/latest">Latest Release</a>
  <span>&nbsp;|&nbsp;</span>
  <a href="#快速上手指南">快速上手</a>
  <span>&nbsp;|&nbsp;</span>
  <a href="#hifi-音频能力">HiFi</a>
  <span>&nbsp;|&nbsp;</span>
  <a href="#qa">Q/A</a>
  <span>&nbsp;|&nbsp;</span>
  <a href="#linux-用户构建">Linux 构建</a>
  <span>&nbsp;|&nbsp;</span>
  <a href="#架构概览">架构概览</a>
  <span>&nbsp;|&nbsp;</span>
  <a href="#english-readme">English README</a>
  <span>&nbsp;|&nbsp;</span>
  <a href="./docs/ECHO_NEXT_ROADMAP.md">Roadmap</a>
</p>

<p align="center">
  <img src="https://img.shields.io/github/package-json/v/moekotori/echo?style=flat-square" alt="Version" />
  <img src="https://img.shields.io/badge/Electron-37.x-47848f?style=flat-square" alt="Electron 37" />
  <img src="https://img.shields.io/badge/React-18.2-61dafb?style=flat-square" alt="React 18.2" />
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178c6?style=flat-square" alt="TypeScript 5" />
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20Linux-lightgrey?style=flat-square" alt="Platform" />
</p>

<p align="center">
  <img src="./docs/img.png" alt="ECHO NEXT Open-Source Hybrid Music Player" width="100%" />
</p>

---

> [!IMPORTANT]
> 请只提交可复现、具体、对项目有实际帮助的问题。请带上截图,一些奇怪问题将会被完全无视.明显不合理的问题、情绪化挑刺、无依据的泛泛否定、要求项目无条件迎合个人偏好的 issue，一定会被直接忽略，且不会被接受为有效反馈。另外,要求BYPASS会员的所有要求将完全不被接受 本项目尊重DMCA(Digital Millennium Copyright Act，*DMCA*),此外 本项目和foobar2000毫无关联 请不要提"能不能复现foobar2000"的xxx 作者没用过 也不会去用 为什么我放着正版ROON不用 去用古董老玩意呢? 所以请不要刁难我
>
> Ep.2:本软件中心点仍为"本地"播放器,网络方向例如"是否能接入xx"平台将不会被考虑,网络延迟(小于5s内) 将不被考虑
>
> 此外,MV匹配算法/歌词匹配算法已经尽力做准确了,关于这方面的issue不会被接受 您可以提高匹配精确度或手选 没人可以做到完美的算法. 功能相关的问题您可以随意题
>
> Ep.3:极端情况将不被考虑在内 例如:使用五寸显示器却要求我做适配、使用二十年前的电脑配置要求我做到流畅 抱歉,我没有义务去做这些事,如果您能做到 请PR

## ECHO NEXT 和 ECHO 有什么区别？

ECHO 是上一代完整播放器，重点在于把本地播放、歌词、MV、下载、插件、投屏和共听等体验功能做进一个桌面应用里。但ECHO的内存占用高,性能差

ECHO NEXT 则是面向长期维护和高性能曲库重新设计的新架构版本，它不是在旧代码上继续堆功能，而是把曲库、音频、Renderer、Preload、原生宿主和系统集成重新拆层。

简单说，ECHO 更像已经成型的功能型播放器；ECHO NEXT 更像一次工程底座重建。它优先解决旧架构里最容易拖累体验的部分：大曲库扫描、SQLite 持久化、专辑墙分页、封面缓存、原生音频宿主、ABI 检查、Linux 构建和可测试的模块边界。部分体验功能已经迁移或重做，部分功能仍在按 Roadmap 继续补齐。

如果你想要成熟功能集合，可以关注 ECHO；如果你更关心下一代架构、性能、Linux 适配和后续 HiFi 能力，ECHO NEXT 是新的主线。

## 30 秒看懂 ECHO NEXT

ECHO NEXT 是一个完整的桌面音乐产品工程，而不是简单的播放器界面。它覆盖 Electron 主进程、React 渲染层、SQLite 曲库、原生音频宿主、封面缓存、系统媒体控制、网络元数据、歌词、MV、下载和跨平台打包链路。

项目的核心目标是把听歌场景里经常被拆散的能力收束成一条稳定的桌面端体验链路：本地曲库负责长期管理，音频核心负责可靠输出，Renderer 负责清晰交互，原生宿主负责 HiFi 能力，测试脚本和文档负责发布前的回归边界。

| 方向 | 项目里的实现 |
| --- | --- |
| 桌面端工程 | Electron 负责窗口、IPC、系统能力与本地资源管理；React 负责播放器交互、曲库视图和沉浸式界面 |
| 音频链路 | 独立 `echo-audio-host` 承担输出，Audio Core 拆分解码、输出桥、设备状态、EQ 和播放时钟 |
| 内容体验 | 本地曲库、文件夹导入、专辑墙、搜索、歌词、MV、下载、播放队列和媒体控制按模块组织 |
| 元数据质量 | 嵌入式元数据、封面缓存、网络候选和字段来源优先级共同保证曲库数据可追踪 |
| 发布质量 | 提供类型检查、单元测试、编码检查、FFmpeg 检查、原生宿主烟测和构建脚本 |

## 快速上手指南

如果你只是想尽快把 ECHO NEXT 跑起来，按下面顺序走即可。Windows 是当前主要开发和验证平台；Linux 用户请先看后面的 [Linux 用户构建](#linux-用户构建)。

### 1. 准备环境

| 依赖 | 推荐 |
| --- | --- |
| Node.js | 20 LTS |
| npm | 9 或更高 |
| Windows 构建工具 | Visual Studio 2022 Desktop development with C++ |

如果你只看界面和文档，通常不需要额外折腾原生工具链；如果要跑完整开发环境、音频宿主或打包，就需要准备好 C++ 构建工具。

### 2. 安装依赖

```bash
git clone https://github.com/moekotori/echo.git
cd echo
npm install
```

首次安装会拉取 Electron、React、SQLite、封面处理、音频宿主相关依赖。切换 Node/Electron 版本后，如果遇到 native module ABI 问题，优先使用仓库脚本修复，不要手动替换二进制文件。

### 3. 启动开发模式

```bash
npm run dev
```

如果你需要在启动前同时构建音频宿主和 Windows SMTC 宿主：

```bash
npm run dev:full
```

### 4. 按改动范围做检查

ECHO NEXT 不鼓励无意义地全量跑测试。你改什么，就验证什么：

| 改动范围 | 建议检查 |
| --- | --- |
| README / 文档 | 通常不需要跑测试，检查 Markdown 内容即可 |
| Renderer UI | 优先跑相关页面或组件的 focused check |
| 曲库 / SQLite / 扫描 | 跑对应 Library 相关测试或脚本 |
| 音频输出 / EQ / 宿主 | 跑音频相关测试，必要时再跑 `npm run smoke:audio-host` |
| SMTC | 跑 `npm run smoke:smtc-host` |
| 打包 / 工具链 | 跑对应平台的构建或 `npm run verify:ffmpeg` |

### 5. 常见新手判断

- 想体验应用：先 `npm install`，再 `npm run dev`。
- 想验证 HiFi/原生输出：用 `npm run dev:full`，并确认音频宿主能正常构建。
- 想构建 Windows 包：使用 `npm run build:win`。
- 想构建 Linux 包：请在 Linux x64、WSL2、Linux VM 或 CI runner 中使用 `npm run build:linux`。
- 只是改 README：不用跑项目测试，别浪费时间。

## 项目定位

ECHO NEXT 不是旧播放器的界面翻新，而是一套重新拆分边界的桌面音乐系统。它把播放器 UI、音乐库、音频输出、原生宿主、SQLite 持久化和系统集成放在各自清晰的层级里，目标是在大曲库、复杂元数据和 HiFi 输出场景下仍然保持稳定。

项目重点不是堆叠功能清单，而是把真实使用中最容易失控的部分做扎实：本地扫描不阻塞界面，专辑墙不在 Renderer 中重组全库，播放时钟来自输出侧，原生模块有明确的打包与 ABI 检查，测试和烟测脚本能覆盖关键路径。

## 核心能力

| 方向 | 说明 |
| --- | --- |
| 桌面应用框架 | Electron、React、TypeScript 和 electron-vite 组成主进程、Preload Bridge 与 Renderer 的清晰边界 |
| 本地音乐库 | SQLite 持久化曲目、专辑、艺术家、封面、文件夹和扫描任务，支持分页读取与增量扫描 |
| 封面缓存 | 基于 `sharp` 生成 `thumb.webp`、`album.webp`、`large.webp`，列表和专辑墙只读取轻量封面 |
| 音频核心 | `AudioSession`、`DecoderPipeline`、`NativeOutputBridge`、`DeviceService` 等模块拆分播放、解码、设备和输出 |
| 原生输出 | 独立 `echo-audio-host` 承载音频输出，支持 WASAPI Shared、WASAPI Exclusive、ASIO 探测和采样率状态回传 |
| EQ 链路 | 原生 10-band EQ、Preamp、预设管理和 bit-perfect 状态提示，DSP 状态与输出模式分开表达 |
| 系统集成 | Windows SMTC、Discord Presence、Last.fm、自动更新、日志与崩溃恢复等能力按模块接入 |
| 网络元数据 | 网络补全以候选数据进入数据库，遵守字段来源优先级，不覆盖手动或嵌入式元数据 |

## HiFi 音频能力

ECHO NEXT 的 HiFi 不是一个界面标签，而是一条尽量少干扰播放链路的工程边界。播放器 UI、曲库扫描、封面生成、网络补全和系统集成不会直接挤进音频输出热路径；真正的播放、解码、设备状态和输出模式由 Audio Core 与独立原生音频宿主承载。

当前重点包括：

- 独立 `echo-audio-host`：把音频输出从 Renderer 生命周期里拆出去，降低界面刷新、曲库扫描和页面状态变化对播放稳定性的影响。
- WASAPI Shared / WASAPI Exclusive：Windows 下支持共享模式与独占模式，独占模式用于更直接的设备输出链路。
- ASIO 探测与接入边界：面向专业声卡和低延迟场景保留 ASIO 能力，同时遵守驱动与平台差异。
- 采样率与输出状态回传：让界面能展示当前输出路径、设备状态、采样率状态和 bit-perfect 提示。
- EQ 与 bit-perfect 明确分离：启用 EQ、Preamp 或其他 DSP 时会清楚表达信号链路已被处理，不把 DSP 输出伪装成 bit-perfect。
- 稳定优先：DirectSound 等兼容模式保留为用户显式选择，不作为静默默认；音频错误、设备断开和宿主异常会尽量降级处理，而不是让播放器崩溃。

HiFi 目标不是承诺所有设备、驱动和格式都能神奇变好，而是把输出链路做得可解释、可验证、可维护：该直出的地方尽量直出，该提示的地方明确提示，该回退的地方保留用户选择。

## 架构概览

```text
┌─────────────────────────────────────────────────────────────┐
│ React Renderer                                               │
│ 页面、组件、虚拟列表、主题、播放控制、资料展示                 │
└──────────────────────────────┬──────────────────────────────┘
                               │ Typed Preload Bridge
┌──────────────────────────────▼──────────────────────────────┐
│ Electron Main Process                                        │
│ IPC、窗口、生命周期、协议、系统集成、服务组合                  │
├──────────────────────────────┬──────────────────────────────┤
│ Library Core                  │ Audio Core                   │
│ SQLite、扫描、元数据、封面     │ 解码、输出桥、设备、状态时钟     │
└──────────────┬───────────────┴──────────────┬───────────────┘
               │                              │
┌──────────────▼──────────────┐   ┌───────────▼───────────────┐
│ Worker-ready Interfaces      │   │ Native Audio Host          │
│ FileScanner / MetadataReader │   │ WASAPI / ASIO / EQ / PCM   │
│ CoverExtractor               │   │ output-side timing         │
└──────────────────────────────┘   └───────────────────────────┘
```

Renderer 只负责交互和展示，不解析音频文件、不扫描目录、不生成封面、不计算权威播放进度。Main Process 通过类型化 IPC 暴露受控能力，重任务进入 Library Core、Audio Core 或原生宿主。

更完整的设计约束见 [ECHO_NEXT_ARCHITECTURE.md](./docs/ECHO_NEXT_ARCHITECTURE.md)、[ECHO_NEXT_LIBRARY_CORE.md](./docs/ECHO_NEXT_LIBRARY_CORE.md) 和 [ECHO_NEXT_AUDIO_CORE.md](./docs/ECHO_NEXT_AUDIO_CORE.md)。

## 当前状态

ECHO NEXT 正在从架构核心向完整播放器体验推进。

已落地或正在验证的重点包括：

- Electron 37、React 18、TypeScript、Vite 构建链
- 类型化 Preload API 和集中 IPC 注册
- SQLite 曲库模型、迁移、分页曲目与专辑读取
- 文件夹导入、后台扫描、扫描进度、取消扫描和增量跳过
- 本地封面提取、WebP 缓存和专辑墙持久化
- 本地文件播放、音频设备查询、输出模式状态和原生音频宿主集成
- SMTC、Last.fm、Discord Presence、下载、歌词、MV、流媒体搜索等模块化实现
- Vitest 单元测试、原生 ABI 检查、FFmpeg 工具链检查和音频烟测脚本

路线图见 [ECHO_NEXT_ROADMAP.md](./docs/ECHO_NEXT_ROADMAP.md)。

## 体验亮点

<table>
  <tr>
    <td valign="top" width="50%">
      <b>HiFi Audio Engine</b><br>
      通过独立原生音频宿主承载输出路径，降低 Renderer 变更对播放稳定性的影响，并为 WASAPI Exclusive、ASIO、EQ 和采样率状态回传保留清晰边界。
    </td>
    <td valign="top" width="50%">
      <b>Local Library Core</b><br>
      以 SQLite 作为曲库事实来源，支持分页读取、增量扫描、封面缓存和专辑墙持久化，避免重启后重新解析整库。
    </td>
  </tr>
  <tr>
    <td valign="top">
      <b>Lyrics And MV</b><br>
      歌词解析、在线歌词源、歌词匹配、罗马音转换、MV 匹配和视频播放能力被拆成独立服务，方便继续扩展体验层。
    </td>
    <td valign="top">
      <b>Network Metadata</b><br>
      网络元数据作为候选进入数据库，只补充弱来源或缺失字段，不覆盖手动、嵌入式或明确来源的数据。
    </td>
  </tr>
  <tr>
    <td valign="top">
      <b>Desktop Integration</b><br>
      Windows SMTC、Discord Presence、Last.fm、自动更新、崩溃恢复和日志诊断按模块接入，保持桌面体验完整。
    </td>
    <td valign="top">
      <b>Release Discipline</b><br>
      构建、测试、编码检查、主题色检查、FFmpeg 工具链验证和原生宿主烟测都有对应脚本，发布前可复现。
    </td>
  </tr>
</table>

## 更多能力

- 本地音乐文件夹导入、扫描进度、取消扫描和缺失文件标记
- 曲目列表分页读取、虚拟列表渲染和专辑墙懒加载
- 专辑、艺术家、封面、播放历史、收藏和队列相关数据模型
- 输出设备查询、播放状态同步、播放进度和音频采样率状态展示
- 10-band EQ、Preamp、预设管理和 bit-perfect 状态提示
- 网易云、QQ 音乐、Spotify、Bilibili、YouTube、SoundCloud 等 Provider 边界
- NCM 转换、FFmpeg、yt-dlp 等外部工具链集成
- 英文、简体中文、日文等多语言资源基础
- 单元测试、压力测试、桌面烟测和稳定性复盘文档

## Linux 支持

ECHO NEXT 已经加入 Linux 构建适配。当前 Linux 目标以 x64 桌面环境为主，构建产物包括 AppImage 和 deb 包。Linux 包必须在 Linux x64 环境中构建，可以使用原生 Linux、WSL2、Linux 虚拟机或 Linux CI runner。

项目没有把 Windows 到 Linux 的交叉打包作为默认路径，因为 Linux 包需要 Linux 版 `echo-audio-host`、Linux 打包工具链，以及 AppImage/deb 相关校验。`npm run build:linux` 会在非 Linux 或非 x64 环境下直接失败并给出提示。

Linux 版音频宿主当前提供基于 JUCE 的 shared native output。Windows SMTC、WASAPI Exclusive 和 ASIO 仍然是 Windows-only 能力；Linux 用户可以正常构建和验证桌面包，但 HiFi 输出能力的完整度会随 Linux 音频链路继续推进。

## 快速开始

### 环境要求

| 依赖 | 版本 |
| --- | --- |
| Node.js | 20 LTS 推荐，最低 18 |
| npm | 9 或更高 |
| Windows 构建工具 | Visual Studio 2022 Desktop development with C++ |
| Linux 构建工具 | CMake、g++、pkg-config、fakeroot、dpkg、rpm、binutils 和 JUCE 依赖库 |

Windows 是当前主要开发和验证平台。Linux x64 构建脚本已提供，macOS 支持会随原生音频链路继续完善。

### 安装

```bash
git clone https://github.com/moekotori/echo.git
cd echo
npm install
```

项目包含 `better-sqlite3`、`sharp`、原生音频宿主和外部工具链。首次安装或切换 Node/Electron ABI 后，如果原生模块不匹配，请优先运行项目脚本而不是手动替换二进制文件。

### 开发运行

```bash
npm run dev
```

如需同时构建音频宿主和 SMTC 宿主后再启动：

```bash
npm run dev:full
```

### 原生音频宿主

开发环境下可以单独构建或同步音频宿主：

```bash
npm run build:audio-host
npm run sync:audio-host
```

生产打包会通过 Electron Builder 的 `extraResources` 将宿主程序和工具目录带入安装包。发布前不要依赖 `../ECHO` 之类的本地迁移路径。

## 常用脚本

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 检查 Electron ABI 并启动开发模式 |
| `npm run dev:full` | 构建音频宿主和 SMTC 宿主后启动开发模式 |
| `npm run build` | TypeScript 检查并执行 electron-vite 构建 |
| `npm run build:win` | 构建 Windows NSIS 与 Portable 包 |
| `npm run build:linux` | 构建 Linux 发行包 |
| `npm run test` | 运行 Vitest 测试 |
| `npm run lint` | 编码检查、主题色检查和 ESLint |
| `npm run verify:ffmpeg` | 检查 FFmpeg 工具链 |
| `npm run smoke:audio-host` | 原生音频宿主烟测 |
| `npm run smoke:smtc-host` | Windows SMTC 宿主烟测 |

## 构建发布

Windows 构建：

```bash
npm run build:win
```

构建产物输出到 `dist/`，包含 NSIS 安装包和 Portable 包。Electron Builder 配置位于 `package.json`，当前应用标识为 `app.echo.next`，产品名为 `ECHO NEXT`。

Linux 构建：

```bash
npm run build:linux
```

## Linux 用户构建

Linux 用户建议在 Ubuntu、Debian 系发行版、WSL2、Linux VM 或 Linux CI runner 中构建。不要在 Windows shell 里直接构建 Linux 包，脚本会阻止这种交叉打包。

Ubuntu 依赖示例：

```bash
sudo apt update
sudo apt install cmake g++ pkg-config fakeroot dpkg rpm binutils
sudo apt install \
  libasound2-dev libjack-jackd2-dev \
  libfreetype-dev libfontconfig1-dev \
  libx11-dev libxcomposite-dev libxcursor-dev libxext-dev \
  libxinerama-dev libxrandr-dev libxrender-dev
```

完整构建：

```bash
npm ci
npm run build:linux
```

`npm run build:linux` 会依次完成：

1. 构建 Linux 版 `electron-app/build/echo-audio-host`。
2. 执行 TypeScript 与 electron-vite 生产构建。
3. 运行 `electron-builder --linux`。
4. 校验打包后的 Linux 音频宿主、AppImage 和 deb 产物。

预期产物：

```text
dist/linux-unpacked/resources/echo-audio-host
dist/*.AppImage
dist/*.deb
```

更完整的 Linux 构建说明见 [ECHO_NEXT_LINUX_BUILD.md](./docs/ECHO_NEXT_LINUX_BUILD.md)。

发布前建议至少执行：

```bash
npm run lint
npm run test
npm run verify:ffmpeg
npm run smoke:audio-host
```

音频、曲库和桌面行为的人工检查可参考 `docs/` 下的 smoke test 与稳定性文档。

## 项目结构

```text
src/
  main/
    app/             Electron 生命周期、窗口、托盘、更新与桌面集成
    audio/           Audio Core、解码、输出桥、设备、EQ、播放状态
    database/        SQLite schema、迁移和数据库创建
    diagnostics/     日志、崩溃恢复和诊断
    downloads/       下载服务
    integrations/    SMTC、Discord、Last.fm 等系统或外部服务集成
    ipc/             IPC 注册和通道处理
    library/         曲库、扫描、元数据、封面、专辑、远程源和网络补全
    lyrics/          歌词解析、匹配、罗马音和在线歌词源
    mv/              本地和在线 MV 匹配
    streaming/       流媒体搜索、缓存、Provider Registry 和播放解析
  preload/           类型化 Context Bridge
  renderer/
    app/             应用布局、路由和 Provider
    components/      播放器、曲库、歌词、专辑、设置等 UI 组件
    hooks/           Renderer 交互 Hook
    pages/           页面入口
    stores/          播放状态和队列状态
    styles/          主题、布局和模块样式
  shared/            跨进程常量、类型和工具函数

native/
  audio-host/        原生音频宿主
  audio-engine/      EQ 和音频处理模块
  smtc-host/         Windows SMTC 宿主

electron-app/
  build/             本地构建出的宿主程序
  tools/             FFmpeg、yt-dlp、NCMConverter 等外部工具

docs/                架构、音频、曲库、构建、稳定性和发布文档
scripts/             构建、检查、烟测和维护脚本
```

## 工程原则

- Renderer 保持轻量：列表分页、封面懒加载，重任务不进入界面线程。
- SQLite 是曲库事实来源：重启后读取持久化数据，不重新解析整库。
- 元数据合并可追踪：字段来源有优先级，网络补全只能补缺，不能覆盖强来源。
- 音频输出独立：播放、解码、设备和输出状态与 UI 生命周期解耦。
- 原生能力可验证：ABI、FFmpeg、音频宿主和 SMTC 宿主都提供脚本化检查。
- 发布流程显式化：构建、测试、工具链检查和烟测文档共同构成发布闸门。

## 相关文档

- [Architecture](./docs/ECHO_NEXT_ARCHITECTURE.md)
- [Roadmap](./docs/ECHO_NEXT_ROADMAP.md)
- [Library Core](./docs/ECHO_NEXT_LIBRARY_CORE.md)
- [Audio Core](./docs/ECHO_NEXT_AUDIO_CORE.md)
- [EQ](./docs/ECHO_NEXT_EQ.md)
- [Linux Build](./docs/ECHO_NEXT_LINUX_BUILD.md)
- [UI Guide](./docs/ECHO_NEXT_UI_GUIDE.md)

## Q/A

### ECHO NEXT 是 ECHO 的换皮版本吗？

不是。ECHO NEXT 是重建架构后的新主线，重点在大曲库、稳定播放、原生输出、SQLite 持久化、可维护模块边界和跨平台构建。部分 ECHO 功能会迁移或重做，但不会直接把旧架构整块搬过来。

### ECHO NEXT 的 HiFi 能力现在能做什么？

当前已经围绕独立音频宿主、WASAPI Shared、WASAPI Exclusive、ASIO 探测、采样率状态、EQ 和 bit-perfect 提示建立了链路。后续会继续补齐更细的设备兼容、格式边界和平台差异。

### 开启 EQ 还是 bit-perfect 吗？

不是。EQ、Preamp 和其他 DSP 都会改变信号链路。ECHO NEXT 会把 DSP 状态和 bit-perfect 状态分开表达，避免把处理后的输出误称为 bit-perfect。

### Linux 支持完整 HiFi 吗？

Linux 版已经有构建适配和基于 JUCE 的 shared native output，但 Windows 专属的 WASAPI Exclusive、ASIO 和 SMTC 不会在 Linux 上直接可用。Linux HiFi 链路会按平台能力继续推进。

### 为什么 issue 要求这么严？

因为项目维护时间有限，真正有价值的问题应该能帮助定位、复现或改进。请提交具体环境、复现步骤、预期行为、实际行为和必要日志。情绪化挑刺、无依据否定、重复催促和不合理要求不会提高优先级。

### 我应该跑哪些检查？

只跑和你改动相关的检查。文档修改通常不需要跑测试；音频、数据库、扫描、打包等改动则应该选择对应的 focused check，并在 PR 中说明命令和结果。

## English README

<p align="center">
  <img src="./logo.png" alt="ECHO NEXT" width="420" />
</p>

<h1 align="center">ECHO NEXT</h1>

<p align="center">
  <strong>Open-Source Hybrid Music Player</strong>
</p>

<p align="center">
  A cross-platform desktop music player built for local libraries, HiFi output, and long-term maintainability.
</p>

> [!IMPORTANT]
> Please open issues only when they are specific, reproducible, and useful to the project. Unreasonable complaints, vague nitpicking, hostile demands, or preference-only requests may be ignored and will not be treated as valid project feedback.

### What Is ECHO NEXT?

ECHO NEXT is not a visual refresh of the old ECHO player. It is a new architecture for a desktop music system: Electron owns the app shell and native resources, React owns the player interface, SQLite owns the library state, and the native audio host owns the output path.

The project is designed around high-performance local libraries, stable playback, traceable metadata, and a clearer separation between UI work and audio work. Heavy operations such as scanning, cover extraction, metadata parsing, and native output should not compete with the renderer hot path.

### ECHO NEXT vs ECHO

ECHO is the previous full-featured player, focused on bringing local playback, lyrics, MV, downloads, plugins, casting, and listening features into a desktop app. ECHO NEXT is the new mainline for a more maintainable and performance-oriented foundation.

If you want the mature feature set of the older app, follow ECHO. If you care more about the next architecture, large-library performance, Linux packaging, native audio boundaries, and ongoing HiFi work, ECHO NEXT is the direction.

### HiFi Audio

HiFi in ECHO NEXT is not just a badge in the UI. It is an engineering boundary that keeps playback and output state away from expensive UI and library work.

- `echo-audio-host` carries native output outside the renderer lifecycle.
- WASAPI Shared and WASAPI Exclusive are supported on Windows.
- ASIO probing and integration are kept for professional audio devices and low-latency scenarios.
- Sample-rate and output-state feedback are surfaced to the app.
- EQ, Preamp, and DSP are clearly separated from bit-perfect output.
- Compatibility backends stay explicit user choices instead of silent defaults.

The goal is not to claim that every device, driver, or file magically becomes better. The goal is an output chain that is understandable, verifiable, and maintainable.

### Core Capabilities

| Area | Implementation |
| --- | --- |
| Desktop app | Electron, React, TypeScript, and electron-vite with a typed Preload bridge |
| Local library | SQLite-backed tracks, albums, artists, folders, covers, and scan jobs |
| Cover cache | `sharp` generates lightweight WebP assets for lists and album walls |
| Audio core | Playback, decoding, devices, output state, EQ, and timing are split by module |
| Native output | `echo-audio-host` owns WASAPI, ASIO probing, EQ, PCM output, and state feedback |
| Metadata | Embedded metadata stays authoritative; network metadata fills candidates and missing fields |
| Integration | Windows SMTC, Discord Presence, Last.fm, updater, logs, and crash recovery are modular |

### Quick Start

```bash
git clone https://github.com/moekotori/echo.git
cd echo
npm install
npm run dev
```

To build the audio host and SMTC host before starting development:

```bash
npm run dev:full
```

### Common Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Check Electron ABI and start development mode |
| `npm run dev:full` | Build audio and SMTC hosts before development mode |
| `npm run build` | Run TypeScript checks and electron-vite build |
| `npm run build:win` | Build Windows NSIS and Portable packages |
| `npm run build:linux` | Build Linux packages on Linux x64 |
| `npm run test` | Run Vitest tests |
| `npm run lint` | Run encoding checks, theme color checks, and ESLint |
| `npm run verify:ffmpeg` | Verify FFmpeg tooling |
| `npm run smoke:audio-host` | Smoke test the native audio host |
| `npm run smoke:smtc-host` | Smoke test the Windows SMTC host |

### Q/A

#### Is ECHO NEXT just a reskin of ECHO?

No. ECHO NEXT is a new architecture. Some features from ECHO will be migrated or rebuilt, but the old architecture is not being copied wholesale.

#### Is EQ still bit-perfect?

No. EQ, Preamp, and DSP change the signal path. ECHO NEXT keeps DSP state and bit-perfect state separate so the UI does not misrepresent processed output.

#### Is Linux HiFi complete?

Not yet. Linux builds and a JUCE-based shared native output path are available, but Windows-only features such as WASAPI Exclusive, ASIO, and SMTC do not apply directly to Linux.

#### What makes a useful issue?

A useful issue includes environment details, reproduction steps, expected behavior, actual behavior, and logs or screenshots when relevant. Vague complaints, hostile demands, and preference-only arguments are not useful.

## Star History

<p align="center">
  <a href="https://star-history.com/#moekotori/echo&Date">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=moekotori/echo&type=Date&theme=dark" />
      <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=moekotori/echo&type=Date" />
      <img alt="ECHO NEXT Star History" src="https://api.star-history.com/svg?repos=moekotori/echo&type=Date" />
    </picture>
  </a>
</p>

## Contributors

<p align="center">
  <a href="https://github.com/Moekotori" title="Moekotori">
    <img src="https://github.com/Moekotori.png?size=96" width="72" height="72" alt="Moekotori" />
  </a>
  <a href="https://github.com/Tkingxiao" title="Tkingxiao">
    <img src="https://github.com/Tkingxiao.png?size=96" width="72" height="72" alt="Tkingxiao" />
  </a>
</p>

Thanks to everyone who has contributed to ECHO NEXT. GitHub commit contributors are also available in the repository graph:
[contributors](https://github.com/moekotori/echo/graphs/contributors).

- [Moekotori](https://github.com/Moekotori)
- [Tkingxiao](https://github.com/Tkingxiao)

## Contributing

1. Fork the repository and create a feature branch.
2. Run the focused checks for the area you changed.
3. Open a pull request with a clear description, screenshots or logs when useful, and the commands you used for verification.

## 致谢

ECHO NEXT 建立在这些优秀的开源项目之上：

- [Electron](https://www.electronjs.org/)
- [React](https://react.dev/)
- [Vite](https://vite.dev/)
- [electron-vite](https://electron-vite.org/)
- [electron-builder](https://www.electron.build/)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
- [sharp](https://sharp.pixelplumbing.com/)
- [music-metadata](https://github.com/Borewit/music-metadata)
- [taglib-wasm](https://github.com/robintribe/taglib-wasm)
- [Shaka Player](https://github.com/shaka-project/shaka-player)
- [Vitest](https://vitest.dev/)

## License

当前仓库尚未附带 `LICENSE` 文件。正式公开发布前，请先确认授权策略并补充对应许可证文本。
