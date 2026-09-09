<div align="center">
  <img src="./assets/readme/vibe-board-hero.svg" alt="Vibe Board：在桌面边缘查看 AI 编程 Agent 的任务状态和额度" width="100%" />

  <p>
    <strong>你的 AI 编程 Agent 桌面看板</strong><br />
    在屏幕边缘查看任务状态和真实额度，点击任务即可回到对应的桌面 Agent。
  </p>

  <p>
    <a href="./README.en.md">English</a> ·
    <a href="./UPSTREAM.md">上游与许可</a> ·
    <a href="./docs/privacy-policy.md">隐私说明</a>
  </p>

  <p>
    <img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-111820" />
    <img alt="Platform" src="https://img.shields.io/badge/platform-Windows-f5b84b" />
    <img alt="Stack" src="https://img.shields.io/badge/Tauri-React%20%2B%20Rust-0c6b63" />
  </p>
</div>

## 这是什么

Vibe Board 是一个本地优先的 Tauri 桌面应用：把 Claude Code、Codex、Gemini CLI、OpenCode、Antigravity 等 Agent 的任务状态和额度接入同一个屏幕边缘看板。

它解决的是三个日常问题：

- 多个 Agent 同时运行时，你能看到当前对话名称和执行状态。
- 点击任务可以恢复并置顶对应的桌面 Agent；纯 CLI Agent 会提示手动打开终端。
- 能读取 token 就显示 token；读不到时只显示 Provider quota 和重置时间，不生成价格估算。

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
| 同时运行多个 Agent | 看板聚合对话名称、运行状态和完成提醒，不展开会话正文。 |
| 返回桌面 Agent | 点击任务即可恢复并置顶对应窗口；纯 CLI Agent 给出手动查看提示。 |
| 等待权限或输入 | 直接批准、拒绝、回答问题或确认计划。 |
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

Hook 是实时事件的主要入口；Codex 等支持的 Agent 还会通过本地 app-server 或状态文件补充线程、审批和 quota。会话状态另有可配置的定时轮询兜底（默认 3 秒），Codex Desktop 还会补读本地 rollout 日志。由于各 Agent 暂无统一、稳定的任务生命周期接口，当前同步属于尽力而为，不能承诺 100% 捕获所有正在执行的任务。

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
- `src-tauri/icons/`、`public/vibe-board-*`：当前 Vibe Board 图标和展示资源。
- `releases/`：唯一的当前 Windows 验收安装包。
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
