<div align="center">
  <img src="./assets/readme/vibe-board-hero.svg" alt="Vibe Board：把 AI 编程 Agent 会话、审批、Trace 和用量放进一个桌面工作台" width="100%" />

  <p>
    <strong>你的 AI 编程 Agent 桌面控制台</strong><br />
    少盯终端，直接在一个悬浮工作台里看清会话、处理审批、查看 Trace 和真实用量。
  </p>

  <p>
    <a href="./README.en.md">English</a> ·
    <a href="./UPSTREAM.md">上游与许可</a> ·
    <a href="./docs/privacy-policy.md">隐私说明</a>
  </p>

  <p>
    <img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-111820" />
    <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-f5b84b" />
    <img alt="Stack" src="https://img.shields.io/badge/Tauri-React%20%2B%20Rust-0c6b63" />
  </p>
</div>

## 这是什么

Vibe Board 是一个本地优先的 Tauri 桌面应用：把 Claude Code、Codex、Gemini CLI、OpenCode、Antigravity 等 Agent 的事件接入同一个悬浮窗。

它解决的是三个日常问题：

- Agent 在等待审批、提问或计划确认时，你不用切回终端。
- 多个会话同时运行时，你能区分当前任务、Trace 时长、工具调用和完成状态。
- 能读取 token 就显示 token；读不到时只显示 Provider quota 和重置时间，不生成价格估算。

## 先看真实界面

<table>
  <tr>
    <td width="50%">
      <img src="./docs/assets/screenshots/island-expanded.png" alt="Vibe Board 展开的会话列表与审批状态" width="100%" />
      <sub>展开后查看会话、工具调用、审批和计划。</sub>
    </td>
    <td width="50%">
      <img src="./docs/assets/screenshots/island-detail.png" alt="Vibe Board 的会话详情和 Trace 信息" width="100%" />
      <sub>详情页保留 Trace、Token、Rate Limit 和原始事件。</sub>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="./docs/assets/screenshots/island-permission.png" alt="在 Vibe Board 中处理 Agent 权限请求" width="100%" />
      <sub>审批、提问和计划确认直接在悬浮窗完成。</sub>
    </td>
    <td width="50%">
      <img src="./docs/assets/screenshots/agent-management-skill-library.png" alt="Vibe Board 的统一 Skill 库" width="100%" />
      <sub>Skills 可接管到中心库，再分发给多个 Agent。</sub>
    </td>
  </tr>
</table>

## 30 秒开始

### Windows 安装包

1. 从 [GitHub Releases](https://github.com/hyNous/agent-island/releases) 下载最新安装包，或直接使用仓库内的 [Vibe Board-latest-setup.exe](./releases/Vibe%20Board-latest-setup.exe)。
2. 安装并启动 Vibe Board；首次启动会打开设置向导，扫描本机已安装的 Agent。
3. 选择一个宿主 Agent、可选的子 Agent，确认“批准并完成设置”；向导会自动安装 Hook、保存启动选项并重新校验。
4. 重启对应的 CLI 会话。以后宿主 Agent 创建新会话时，Vibe Board 会按选择自动唤醒；也可在 **Settings → General → Agent connection** 重新配置。

Windows 安装包目前未签名，SmartScreen 可能会提示确认；自动更新暂未启用，发布采用 GitHub Releases 手动下载。

完整的首次设置、权限边界和迁移说明见 [产品安装与首次设置说明](./docs/product-setup.md)。

### 从源码运行

环境要求：Node.js 20+、pnpm、Rust/Cargo、Tauri CLI；Windows 还需要 Microsoft C++ Build Tools 与 WebView2，macOS 需要 Xcode Command Line Tools。

```bash
git clone https://github.com/hyNous/agent-island.git
cd agent-island
pnpm install
pnpm tauri:dev
```

只调试浏览器 UI：

```bash
pnpm dev
```

## 你能用它做什么

| 需求 | Vibe Board 的处理方式 |
| --- | --- |
| 同时运行多个 Agent | 灵动岛聚合会话、运行阶段、工具、Subagent 和完成提醒。 |
| 等待权限或输入 | 直接批准、拒绝、回答问题或确认计划。 |
| 看清一次任务跑了多久 | 以当前 Agent trace 为单位显示执行时间，不用 Session 存活时长代替。 |
| 读取用量 | 优先显示真实 token；没有 token 时显示 Provider quota、周期和重置时间。 |
| 管理多个 Agent | 扫描 CLI、桌面 App、版本、路径、Hook 和配置状态。 |
| 统一管理 Skills | 从 Agent、本地目录或 GitHub 导入，接管到中心库，再用软链接或副本分发。 |

## 工作方式

Vibe Board 不把会话内容上传到中转服务。基本链路是：

```text
Agent Hook / 本地 App 状态
        ↓
本地 Bridge → Hook Server → Agent Adapter
        ↓
SessionStore / Trace / Usage snapshot
        ↓
灵动岛 · Agent Monitor · Skills 管理
```

Hook 是实时事件的主要入口；Codex 等支持的 Agent 还会通过本地 app-server 或状态文件补充线程、审批和 quota。所有外部 Agent 不在线时，界面会保留上一次已读取的状态，并标注数据来源和更新时间。

## 宿主插件（可选兼容方式）

首选使用首次启动向导，不需要手动注册插件或额外安装 Node 运行时。`plugins/agent-island-host/` 仍保留 Codex 与 Claude Code 的手动/兼容清单，适用于已有插件工作流或需要在 Agent 自己管理 Hook 的场景。

在仓库根目录执行以下命令即可把本地插件注册到 Codex：

```bash
codex plugin marketplace add .
codex plugin add agent-island-host@agent-island-local
codex plugin list
```

## 支持范围

运行时 Hook 适配和 Agent 管理扫描是两层能力，具体事件深度取决于 Agent 本身公开的 Hook/CLI 接口。

| 能力 | 当前覆盖 |
| --- | --- |
| 灵动岛 / Hook | Claude Code、Codex、Gemini CLI、Cursor、Copilot、Cline、Qoder、CodeBuddy、Qwen、Kimi、DeepSeek、OpenCode、Factory Droid、StepFun、Antigravity、WorkBuddy、Hermes、Pi、Kiro、ZCode |
| 管理扫描 | 上述 Agent，另含豆包、`.agents` 共享目录、Junie、Windsurf、Augment、KiloCode、OB1、Amp、Aider、OpenClaw / QClaw / EasyClaw / AutoClaw，以及自定义 Agent |

## 目录导航

- `src/`：React 灵动岛、设置页、Agent/Skill 管理和主题。
- `src-tauri/src/`：Rust Hook Server、Bridge、Agent 适配器、Trace/Usage 和本地存储。
- `src-tauri/icons/`、`public/agent-island-*`：当前 Vibe Board 图标和展示资源。
- `releases/`：当前 Windows 验收安装包；旧包只放在 `releases/archive/`。
- `UPSTREAM.md`、`LICENSE`、`NOTICE`、`TRADEMARKS.md`：来源、许可和品牌边界。

## 本地检查

```bash
pnpm lint
pnpm test:run
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml
pnpm release:check
```

## 贡献与发布

欢迎提交 Issue 或 Pull Request。提交前请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)，并附上验证结果；UI 改动请附截图。

当前版本通过 GitHub Releases 手动发布。签名密钥和更新地址没有配置前，不会启用自动更新或自动发布工作流。

## 许可与来源

Vibe Board 代码基于 [Apache License 2.0](./LICENSE) 发布，同时保留上游的 [NOTICE](./NOTICE) 和品牌边界说明 [TRADEMARKS.md](./TRADEMARKS.md)。

本项目是基于 [AgentBro](./UPSTREAM.md) 的独立修改版：产品名称、图标和发布配置已经替换，不代表上游项目的官方发行版。
