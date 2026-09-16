<div align="center">
  <img src="./assets/readme/vibe-board-hero.svg" alt="Vibe Board：停靠在屏幕边缘的 AI 编程 Agent 任务看板" width="100%" />

  <p>
    <strong>屏幕边缘的 AI 编程 Agent 任务看板</strong><br />
    Vibe Board 是一个本地优先的 Tauri 桌面应用，把 Claude Code、Codex、Gemini CLI、OpenCode、Antigravity 等 Agent 的任务状态、审批和额度收进屏幕边缘的一条常驻看板。
  </p>

  <p>
    <a href="./README.en.md">English</a> ·
    <a href="./UPSTREAM.md">上游与许可</a> ·
    <a href="./docs/privacy-policy.md">隐私说明</a>
  </p>

  <p>
    <img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-111820" />
    <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20x64-f5b84b" />
    <img alt="Stack" src="https://img.shields.io/badge/Tauri-React%20%2B%20Rust-0c6b63" />
  </p>
</div>

## 这是什么

Vibe Board 常驻屏幕顶部或左右边缘，展开后按顺序显示当前任务、Agent 在线状态与额度。它解决的是三个日常问题：

- 多个 Agent 并行时，不用切窗口就能看到每个任务的对话名称和运行状态。
- 点击任务可以恢复并置顶对应的桌面 Agent；纯 CLI Agent 会提示手动打开终端。
- 有 token 就显示 token；没有就显示 Provider quota 和重置时间，不生成价格估算。

看板外观默认纯黑，可切换磨砂玻璃；侧边停靠有三档尺寸：64×132（窄，默认）、72×148（标准）、80×168（宽）。

## Windows 安装（x64，未签名）

1. 从 [GitHub Releases](https://github.com/hyNous/agent-island/releases) 下载最新安装包，或直接使用仓库内的 [Vibe Board-latest-setup.exe](./releases/Vibe%20Board-latest-setup.exe)。
2. 安装并启动 Vibe Board。首次启动进入设置向导：扫描本机已安装的 Agent，选择一个宿主 Agent，按需选择子 Agent，然后“批准并完成设置”。
3. 向导会安装所选 Hook、保存启动选项并重新校验；校验失败会留在向导中提示错误。之后打开宿主 Agent 的新会话即可连接。
4. 需要调整时，在 **Settings → General → Agent connection** 重新选择宿主、子 Agent 或重新校验。

安装包是未签名的 Windows x64 构建，SmartScreen 可能要求确认；自动更新未启用，发布采用 GitHub Releases 手动下载。完整的首次设置、权限边界和迁移说明见 [产品安装与首次设置说明](./docs/product-setup.md)。

## 主要能力

| 能力 | 说明 |
| --- | --- |
| 任务看板 | 显示当前任务、Agent 在线状态和完成提醒；任务区可滚动，只显示 Agent、对话名称和运行状态，不显示会话正文。 |
| 审批与提问 | 在执行过程中批准、拒绝、回答问题或确认计划，不必切回终端。 |
| 用量 | 优先显示真实 token；没有 token 时显示 Provider quota、周期和重置时间。 |
| Agent 管理 | 扫描 CLI 与桌面 App，查看版本、路径、Hook 和配置状态，并支持自定义 Agent。 |
| Skills 管理 | 从 Agent、本地目录或 GitHub 导入，接管到中心库，再用软链接或副本分发。 |
| 外观与停靠 | 默认纯黑、可切磨砂玻璃；可停靠顶部或左右边缘，侧边支持三档尺寸。 |

## 同步边界

Hook 与本地 app-server 事件是实时主链路，前端另有默认 3 秒（可调 1–30 秒）的轮询兜底，Codex 还会补读本地 rollout 日志。

各 Agent 目前没有统一稳定的任务生命周期接口，因此任务同步是尽力而为，不能承诺 100% 捕获所有正在执行的任务；进程扫描只能确认 Agent 在线，不能据此创建任务。Vibe Board 不把会话内容上传到中转服务，会话正文、工具详情和 Hook 原始输入都不进入看板。

## 从源码开发

环境要求：Node.js 20+、pnpm、Rust/Cargo、Tauri CLI；Windows 还需要 Microsoft C++ Build Tools 与 WebView2。

```bash
git clone https://github.com/hyNous/agent-island.git
cd agent-island
pnpm install
pnpm tauri:dev
```

只调试浏览器 UI：`pnpm dev`（http://localhost:1423）。提交前运行仓库要求的检查：

```bash
pnpm lint
pnpm test:run
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml
```

## 许可与上游来源

Vibe Board 代码基于 [Apache License 2.0](./LICENSE) 发布，并保留上游的 [NOTICE](./NOTICE) 与品牌边界 [TRADEMARKS.md](./TRADEMARKS.md)。

本项目是基于 [AgentBro](https://github.com/shirenchuang/agentbro) 的独立修改版：产品名称、图标和发布配置已替换，不代表上游项目的官方发行版，详见 [UPSTREAM.md](./UPSTREAM.md)。欢迎提交 Issue 或 Pull Request，提交前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。
