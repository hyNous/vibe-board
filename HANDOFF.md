# Agent Island 开发交接

更新时间：2026-09-06

## 1. 当前项目

- 仓库：`D:\Projects\code island\control-tower`
- 分支：`local/control-tower-dev`
- 产品名：`Agent Island`
- Rust package：`agent-island`，版本 `3.1.1`
- Tauri identifier：`com.agentisland.desktop`
- 当前工作树有未提交修改；不要执行 reset、checkout 或清理未提交文件。

## 2. 用户目标

Agent Island 是一个 Windows/Tauri 桌面灵动岛，用于聚合 Codex、Claude Code、OpenCode、Antigravity 等 Agent 的会话、Trace、状态、Token/额度和重置时间，并通过统一 Skill 目录跨 Agent 使用 Skill。

用户当前希望：

1. 使用 Codex 插件自动启动/连接 Agent Island；
2. 使用统一 Skill 中心；
3. 当前 Codex 作为主要宿主，其他 Agent 保持独立显示；
4. 保留 Trace 计时、额度快照、重置窗口、托盘与灵动岛位置设置；
5. 清除旧 AgentBro 本地路径，但保留必要的代码兼容读取逻辑。

## 3. 已完成的代码改动

### 统一 Skill

- 规范中心目录：`%USERPROFILE%\.agents\skills`
- Agent Island 运行数据目录：`%USERPROFILE%\.agent-island`
- Skill Manager v2、数据库、快照、Agent metadata、安装器已切到 Agent Island 路径。
- 旧 `.agentbro` Skill 内容只在迁移/兼容读取时使用。

### Codex/宿主插件

- 插件目录：`plugins/agent-island-host/`
- 清单：`plugins/agent-island-host/.codex-plugin/plugin.json`
- Codex Hook：`plugins/agent-island-host/hooks/hooks.json`
- 显式 Codex Hook 副本：`plugins/agent-island-host/hooks/codex-hooks.json`
- Claude Code Hook：`plugins/agent-island-host/hooks/claude-hooks.json`
- 启动脚本：`plugins/agent-island-host/scripts/host-hook.mjs`
- 本地 marketplace：`.agents/plugins/marketplace.json`

插件在 `SessionStart`：

1. 调用 Agent Island Bridge；
2. 记录当前宿主（Codex 或 Claude Code）；
3. 如果桌面程序已记录可执行文件路径，则尝试自动启动；
4. 将宿主标记为主要用量来源，OpenCode/Antigravity 等仍独立显示。

当前 Codex 插件状态曾验证为：`agent-island-host@agent-island-local 1.0.0 installed, enabled`。

### 灵动岛与状态

- Codex 最小化跟随/独立显示设置。
- 灵动岛位置支持顶部、左侧、右侧、自定义拖动。
- 设置页切换左侧/右侧后会立即调用原生重定位；后端启动、配置广播和拖动保存均使用同一套位置模式/垂直偏移。
- Session 刷新间隔可配置。
- Agent 状态包含在线状态、Trace/会话状态、Token、5 小时/7 天/月窗口等快照。
- Claude Code 已通过官方 `statusLine` command 接入现有 bridge：安装 Claude hooks 时自动写入 `StatusLineUpdate`，把 `rate_limits`、`context_window` 和任务生命周期事件送入 Agent Island；已有自定义 status line 会保留。
- Claude 适配器在桌面程序拿不到 CLI PATH、但 `~/.claude/settings.json` 已存在时仍按 `Installed` 处理，避免漏装 status line。
- 托盘/任务栏行为和桌面窗口设置已完成前一轮实现。
- Tauri updater 配置已补齐显式空 `pubkey`；无签名发布仍走既有 GitHub 手动下载回退，不再阻断应用启动。

## 4. 旧路径迁移结果

按用户所说的“agent PRO”理解为旧 `AgentBro` 路径，已完成一次实际迁移：

- `C:\Users\27312\.agentbro\control_tower` → `C:\Users\27312\.agent-island\control_tower`
- `C:\Users\27312\.agentbro\network` → `C:\Users\27312\.agent-island\network`
- `C:\Users\27312\.agentbro\skill-manager` → `C:\Users\27312\.agent-island\skill-manager`
- `C:\Users\27312\.agentbro\switch` → `C:\Users\27312\.agent-island\switch`
- `%APPDATA%\agentbro\config.json` → `%APPDATA%\agent-island\config.json`
- `%APPDATA%\agentbro\agent-status.json` → `%APPDATA%\agent-island\agent-status.json`
- 旧 `.agentbro\skills` 当时为空；现有 Skill 已在 `%USERPROFILE%\.agents\skills`。

当前核对时以下旧路径均不存在：

- `C:\Users\27312\.agentbro`
- `C:\Users\27312\AppData\Roaming\agentbro`
- `C:\Users\27312\AppData\Local\com.agentbro.desktop`

旧缓存、旧 Bridge 和迁移前的新配置备份保存在可恢复归档：

`C:\Users\27312\AppData\Local\Agent Island\legacy-archive-20260905-114147`

归档不参与运行。源码仍保留旧路径字符串，仅用于一次性迁移、兼容读取、远程协议或历史测试，不应重新作为本机写入路径。

## 5. 安装版本的重要事实

- 开始菜单快捷方式目标：`D:\agent island\agent-island.exe`
- 该已安装程序版本：`3.1.1`
- 仓库中的 `releases\Agent Island-latest-setup.exe` 版本：`3.1.1`
- 最新工作树已于 2026-09-06 构建为 `src-tauri\target\release\bundle\nsis\Agent Island_3.1.1_x64-setup.exe`，并覆盖安装到 `D:\agent island`。
- `C:\Users\27312\.agent-island\agent-island.path` 已生成，内容为 `D:\agent island\agent-island.exe`。
- 仓库中的 `releases\Agent Island-latest-setup.exe` 仍是旧的同版本产物，尚未替换。

## 6. 已执行验证

- `cargo check --manifest-path src-tauri/Cargo.toml --all-targets`：通过，有既有 dead-code 警告。
- `pnpm build`：通过。
- `pnpm lint`：通过。
- Vitest 使用 `--testTimeout=15000` 重跑：53 个文件、656 个测试全部通过。
- `git diff --check`：无问题。
- 插件清单/marketplace/Hook smoke check：已通过。
- `cargo test --lib` 在当前 Windows 环境曾遇到 DLL `STATUS_ENTRYPOINT_NOT_FOUND`，属于运行环境问题；`cargo test --lib --no-run` 曾通过。
- 新 Codex 模型回合曾受本机 TLS `UnknownIssuer` 阻断，不能据此声称已完成真实模型端到端验证。
- 修复 updater 配置后，`cargo tauri build --bundles nsis --ci --config '{"bundle":{"createUpdaterArtifacts":false}}'`：通过。
- 修复后的 NSIS setup 已静默安装；Agent Island 启动成功并保持运行。
- 最新安装版本已在 2026-09-06 15:02（本地时间）重启验证；`C:\Users\27312\.claude\settings.json` 已自动出现：
  `{"type":"command","command":"C:\\Users\\27312\\.agent-island\\bin\\agent-island-bridge.exe --source claude-code --event StatusLineUpdate"}`。
- 实际 bridge smoke test 已将 Claude `StatusLineUpdate` 写入 `AppData\Roaming\agent-island\agent-status.json`，快照包含 5 小时 42%、7 天 7% 和上下文 token 数据。
- Codex 插件 SessionStart smoke test：`usage-host=codex`，Bridge 事件 `forwarded=true`。
- 自动启动 smoke test：关闭 Agent Island 后，仅运行插件 Hook 即成功重新启动桌面端并转发 SessionStart。
- `pnpm tauri:build:windows` 已生成 NSIS，但组合构建在额外 MSI 阶段因 WiX `light.exe` 失败；NSIS-only 构建不受影响。
- 本轮 `cargo check --manifest-path src-tauri/Cargo.toml` 与 `pnpm build` 均通过；针对新增 status line helper 的单测已编译，但测试二进制在当前 Windows 环境启动后超过 6 分钟无输出，已停止，不能据此声称单测运行通过。

## 7. 新 session 建议顺序

1. 先读本文件，再查看 `git status` 和 `git diff --stat`。
2. 不要重做已完成的统一 Skill、插件和路径迁移。
3. 检查 `codex plugin list`；必要时重新执行：

   ```powershell
   cd "D:\Projects\code island\control-tower"
   codex plugin marketplace add .
   codex plugin add agent-island-host@agent-island-local
   codex plugin list
   ```

4. 新建一个 Codex 任务，按需在 `/hooks` 中信任 Hook，做最后的真实 Codex Hook、灵动岛显示和统一 Skill UI 检查。
5. 若要发布仓库内安装包，再替换 `releases\Agent Island-latest-setup.exe`；本地运行验证不依赖该副本。
6. 不要删除 `legacy-archive-20260905-114147`，除非用户明确要求回收归档占用的磁盘空间。

## 8. 不要做的事

- 不要把旧 `.agentbro` 路径重新设为默认写入路径。
- 不要删除 `%USERPROFILE%\.agents\skills`。
- 不要提交、推送或创建 PR，除非用户另外明确要求。
- 不要把旧兼容字符串全部机械替换；它们有些用于迁移、远程兼容和历史配置识别。

## 9. 2026-09-06 本轮修复

### Anti-gravity 额度显示

- 实际数据不是后端返回了两份 Anti-gravity 快照；同一个 provider 的 live/persisted 快照已按 provider 去重。
- 重复来自展开态同时渲染顶部 `RateLimitBar` 和下方 `AgentPresenceStrip`，两者都展示了 Anti-gravity 窗口。
- 现在 hover 展开态只保留 `AgentPresenceStrip` 的完整窗口列表；detail 展开态保留顶部额度条，避免同一窗口在同一视图重复出现。

### 刘海拖动与边缘吸附

- 拖动改为完整二维拖动，释放时按最近边缘自动判定 `left`、`right`、`top` 或 `custom`，不再依赖设置里的左右位置下拉框。
- 距离左右边缘 48 logical px 内自动吸附；左右模式使用显示器的精确 `x` 坐标，去掉原来的 8px 浮空边距。
- 左右模式关闭顶部 collapsed 的宽画布和横向 hit slop，并同步调整 shell 的圆角/边框，使可见刘海贴在显示器左右边缘。
- 位置设置页保留状态展示和“重置为顶部居中”；用户正常使用时直接拖动即可改变吸附位置。
- 拖动结束后后端返回最终模式及水平/垂直偏移，前端等待结果后再结束拖动态，避免旧模式 resize race。

### 本轮验证

- `cargo check --manifest-path src-tauri/Cargo.toml --all-targets`：通过，仅有既有 dead-code 警告。
- `pnpm build:bridge:release`：通过。
- `cargo tauri build --bundles nsis --ci --config '{"bundle":{"createUpdaterArtifacts":false}}'`：通过。
- 生成的 NSIS 已覆盖安装到 `D:\agent island`，安装后的 `D:\agent island\agent-island.exe` 已重新启动。
- `git diff --check`：通过；`cargo fmt --check` 仍会报告仓库原有的跨文件格式差异，本轮未进行全仓格式化。
- 新增的 Rust 边缘吸附测试已随 `--all-targets` 编译；当前 Windows 环境的 Rust 测试二进制此前启动超过 6 分钟无输出，因此没有将其标记为运行通过。

## 10. 2026-09-06 侧边竖向 UI

- 侧边收起态改为窄竖向胶囊：图标在上、额度/数量在下，设置入口保留在底部。
- 侧边展开态仍使用横向内容，避免会话、额度窗口和操作按钮被强制压成竖排。
- 侧边收起态尺寸固定为 58 logical px 内容宽、92 logical px 高；顶部模式尺寸完全不变。
- `pnpm build`、`pnpm lint` 与最终 NSIS 构建均通过；最终包已覆盖安装并重新启动。

## 11. 2026-09-06 侧边收起动画

- 录屏中的抽搐来自侧边模式收起时立即缩小 Tauri 透明原生窗口；窗口高度、居中位置和 WebView 视口同时改变，导致大面板被截断后再出现小面板。
- 侧边收起态复用稳定原生画布，面板只在画布内做宽高和上下居中过渡；左右容器分别贴齐对应屏幕边缘，不再通过原生窗口 resize 参与收起动画，展开态仍按真实面板尺寸工作。
- 原生 hover 探测补充了侧边左右/上下偏移，避免稳定画布扩大后命中区域与可见面板错位。
- `pnpm build`、`pnpm lint`、`pnpm test:run src/test/notchPanel.test.tsx`（66/66）和 `cargo check --manifest-path src-tauri/Cargo.toml --all-targets` 通过。
- 最终 NSIS 已生成并覆盖安装到 `D:\agent island`，安装后的 `D:\agent island\agent-island.exe` 已于 21:37 重新启动。
- 动画阶段整套 Vitest 曾有 3 个旧额度断言失败（`collapsedBarTips.test.tsx`）；后续已将断言对齐到去重后的 detail 展开行为，当前全量测试结果见第 12 节。

## 12. 2026-09-06 Anti-gravity 分行与任务实时同步

### Anti-gravity 额度

- 新增共享额度窗口分组逻辑；Anti-gravity 按模型组分行显示，组内保留 5h/7d 窗口。
- 顶部 `RateLimitBar` 与 hover 详情中的 `AgentPresenceStrip` 复用同一分组规则；普通 Agent 仍保持原来的紧凑单行显示。
- Anti-gravity `/usage` 返回的 Gemini/Office（或后端实际模型组名）不再挤在同一行。

### Tasks 实时显示

- 原 Tasks 页面读取的是持久化 `Task Trace` 数据库，历史/演示任务因此会和当前正在运行的 session 数量不一致；进入 Tasks 页面时也没有持续刷新。
- 页面现在单独显示“当前实时任务”，数据来源是 `get_monitor_sessions`，只列出 processing/compacting/waiting 状态的当前 session，宿主和其他 Agent 均纳入。
- 嵌套 subagent 仍作为宿主 session 的 `sub` 数量展示，避免把同一执行链重复计数；持久化 Trace 区域继续保留并明确标注为历史/演示数据。
- Tasks 页面按配置的 session 刷新间隔同时刷新实时 session 和持久化 Trace；手动“重新加载”也会同时刷新两条数据链。

### 本轮验证

- `pnpm build`：通过。
- `pnpm lint`：通过。
- `pnpm test:run`：53 个文件、659 个测试全部通过。
- `git diff --check`：通过；仅有既有的 LF/CRLF 提示。
- `cargo tauri build --bundles nsis --ci --config '{"bundle":{"createUpdaterArtifacts":false}}'`：通过；NSIS 已覆盖安装到 `D:\agent island`，安装后的 Agent Island 已重新启动。

## 13. 2026-09-07 Windows 首次设置与可迁移闭环

### 已实现

- 新增首次启动设置向导：解释本地权限边界，扫描本机 Agent，选择一个宿主和多个子 Agent。
- 向导一次批准后会保存宿主/子 Agent、宿主自动启动、Windows 登录启动选项，安装所选 Hook，并重新读取 Hook 状态校验；失败时不会把向导标记为完成。
- Bridge 在宿主的 `SessionStart` 读取 Agent Island 本地配置，匹配宿主后自动记录主要宿主并唤醒桌面组件；子 Agent 仍只负责同步，不会抢占宿主启动职责。
- 设置 → General 新增 Agent connection 入口，可重新运行向导，改变宿主/子 Agent 或修复 Hook。
- 新增 [产品安装与首次设置说明](./docs/product-setup.md)，明确配置路径、批准范围、迁移行为和 Windows 首版边界；README 已改为向导优先，手动插件降为兼容方式。

### 本轮验证

- `pnpm build`：通过。
- `pnpm lint`：通过。
- `pnpm test:run`：53 个文件、659 个测试全部通过；此前一次全量运行的单个设置测试时序失败，单测重跑及随后全量均通过。
- `cargo check --all-targets`：通过，仅有仓库原有 dead-code 警告。
- `pnpm build:bridge:release`：通过，包含新的配置宿主自动启动逻辑。
- `git diff --check`：通过；仍有既有的 LF/CRLF 提示。
- `cargo tauri build --bundles nsis --ci --config '{"bundle":{"createUpdaterArtifacts":false}}'`：通过；生成 `src-tauri\target\release\bundle\nsis\Agent Island_3.1.1_x64-setup.exe`。本轮未覆盖 `releases\Agent Island-latest-setup.exe`，也未在新机安装验收。

## 14. 2026-09-07 首次设置非阻断修复

- Agent 检测、子 Agent Hook 安装/校验、旧 Hook 清理和 Windows 登录启动项失败时，改为记录可修复警告，不再阻断首次设置完成；只有 Agent Island 自身配置无法保存时才返回设置步骤。
- 完成页会列出需要后续处理的 Agent，用户可以先进入桌面使用，再从设置 → General 重新运行向导修复。
- `pnpm build`、`pnpm lint`、`pnpm test:run`（53 个文件、659 个测试）通过。
- NSIS 已重新生成：`src-tauri\target\release\bundle\nsis\Agent Island_3.1.1_x64-setup.exe`。

## 15. 2026-09-07 Agent 状态诊断与 Gemini CLI 报错修复

- Tasks 页的“当前实时任务”来源明确为内存 `SessionStore`：由 Agent Hook 事件和 Codex app-server 同步写入；`Task Trace` 数据库只用于持久化/历史链路，不作为实时任务来源。
- Tasks 页现在合并后端轮询快照与前端实时快照，避免轮询竞态隐藏刚收到的会话；同时显示 Codex app-server 是否已连接，并在未连接时给出宿主/Hook 配置和重启提示。
- 首次设置向导只把真正找到 CLI 的 Agent（`Available`）提供给宿主/子 Agent 选择；只有配置目录但没有 CLI 的 Agent 会显示为“发现配置，但缺少 CLI”，不会再触发到安装 Hook 才失败。
- Gemini 缺少 CLI 时，向导和后端错误均给出可执行处理：`npm install -g @google/gemini-cli`，然后完全退出并重新打开 Agent Island，再重新检测/配置。该错误是 CLI 缺失，不是额度或登录失败。
- 当前机器核对：`codex-cli 0.153.4` 可解析，Codex app-server 同步配置已开启；本机 `gemini` 命令不存在，但 `%USERPROFILE%\.gemini` 配置目录存在，因此此前向导才会出现“看似已安装、实际无法装 Hook”的矛盾。

### 本轮验证

- `pnpm build`：通过。
- `pnpm lint`：通过。
- `pnpm test:run`：53 个文件、659 个测试全部通过。
- `cargo tauri build --bundles nsis --ci --config '{"bundle":{"createUpdaterArtifacts":false}}'`：通过；生成 `src-tauri\target\release\bundle\nsis\Agent Island_3.1.1_x64-setup.exe`。
- `git diff --check`：通过；仅有既有的 LF/CRLF 提示。
- `cargo fmt --check`：仓库当前已有大量跨文件格式差异，本轮未进行全仓格式化。

## 16. 2026-09-07 Antigravity CLI 与刘海边缘吸附修复

- 已按官方文档纠正命名：Antigravity 的 CLI 启动命令是 `agy`，Windows 安装脚本为 `irm https://antigravity.google/cli/install.ps1 | iex`；Gemini CLI 是另一个独立工具，不能作为 Antigravity 的启动入口。官方文档：`https://antigravity.google/docs/cli/install/`。
- 本机验证：`agy --version` 返回 `1.1.27`，路径为 `%LOCALAPPDATA%\agy\bin\agy.exe`。
- 修正 Antigravity 检测、首次设置提示和 Hook 安装错误提示，明确使用 `agy`；同时将 Gemini CLI 检测收窄到 `.gemini/settings.json`，避免 Antigravity 的 `.gemini/config` 被误判成 Gemini CLI。
- 刘海不再支持自由悬浮：拖动释放时按距离在顶部、左侧、右侧三条屏幕边缘中选择最近的一条；旧配置中的 `custom` 会迁移到顶部。侧边仍可通过拖动调整上下位置。

### 本轮验证

- `pnpm build`：通过，902 个模块。
- `pnpm lint`：通过。
- `pnpm test:run`：53 个文件、659 个测试全部通过。
- `cargo check --manifest-path src-tauri/Cargo.toml --lib`：通过，仅有仓库既有 dead-code 警告。
- `cargo tauri build --bundles nsis --ci --config '{"bundle":{"createUpdaterArtifacts":false}}'`：通过；生成 `src-tauri\target\release\bundle\nsis\Agent Island_3.1.1_x64-setup.exe`。
- `cargo test --manifest-path src-tauri/Cargo.toml pet_window_tests`：编译通过，但测试进程在当前 Windows 运行环境启动时返回 `STATUS_ENTRYPOINT_NOT_FOUND`，未能执行测试用例；不是本轮 Rust 代码编译错误。

## 17. 2026-09-07 Codex Desktop 实时任务来源修复

- 根因：Agent Island 的 Codex app-server `thread/list` 请求没有指定 `sourceKinds`。Codex app-server 在未指定时默认只返回 `cli` 和 `vscode` 来源，因此当前 Codex Desktop 的任务不会进入同步结果。
- 修复：请求显式包含 `cli`、`vscode`、`appServer`、`subAgent` 及其他官方支持的来源类型，宿主选择和 Hook 配置逻辑不变。
- 官方依据：`https://developers.openai.com/codex/app-server/` 的 `thread/list` 文档说明了默认来源过滤和 `appServer` 来源类型。

### 本轮验证

- `cargo check --manifest-path src-tauri/Cargo.toml --lib`：通过，仅有仓库既有 dead-code 警告。
- `cargo tauri build --bundles nsis --ci --config '{"bundle":{"createUpdaterArtifacts":false}}'`：通过；已生成更新后的 `src-tauri\target\release\bundle\nsis\Agent Island_3.1.1_x64-setup.exe`。
- 本轮未自动安装新包；需要安装后重启 Agent Island，当前 Codex Desktop 任务才会按新来源过滤规则同步。

## 18. 2026-09-08 Windows 顶部展开分段修复

- 新录屏逐帧确认：顶部刘海展开时，原生窗口的宽度和位置分两次提交，Windows 会显示中间帧，造成左侧先出现、右侧稍后补齐。
- Windows 的 `set_notch_window_frame` 已改为一次 `SetWindowPos` 原子提交位置与尺寸，并按目标显示器 DPI 换算物理坐标；macOS 和侧边稳定画布逻辑未改。
- `cargo check --all-targets`、灵动岛 68 项测试、Lint、前端生产构建和 NSIS 构建通过。全量前端测试首轮 660/661，通过项外唯一 Skill 页面异步用例超时，单独复跑通过。
- 最新安装包：`releases/Vibe Board-latest-setup.exe`；SHA-256：`f37b398d25e5bbda2a558a60e032ec1f47856d66045c965b16635bbdef22a177`。

## 19. 2026-09-08 悬停直接展开/收回

- 上一轮原生窗口原子更新不是本次现象的实际触发链路；真正触发重复展开和等待收回的是完成/回复通知的自动展示、倒计时进度条，以及悬停展开/离开收回延迟。
- 普通完成/回复通知不再自动撑开刘海，也不再倒计时或定时消失；通知在折叠态等待，鼠标进入后展示，离开命中区域后立即清除并收回。
- 刘海不再读取悬停展开、离开收回延迟和可选自动收回配置；相关设置项及反馈卡片进度条已移除。回复输入框中存在草稿时仍保持展开，避免误收回丢失输入。
- 阻塞式审批、提问和更新提醒的主动展示逻辑保留。
- 灵动岛与反馈输入 72 项测试、Lint、前端生产构建和 NSIS 构建通过。全量前端测试 660 项中 659 项通过，唯一 Skill 页面异步用例超时，单独复跑通过。
- 最新安装包：`releases/Vibe Board-latest-setup.exe`；SHA-256：`f02ffa25c4255dd039ec432be6269addaf7c38c4c36a3b18b0e3354f48680b4c`。

## 20. 2026-09-09 左右分区式展开与任务信息精简

- 用户实测确认上一轮“左右分区式二次展开”仍未解决。继续排查后移除了两个剩余触发源：宽度动画期间同步插值绝对坐标 `clip-path: path(...)`，以及外壳首次展开后再由 `ResizeObserver` 测量内容并提交第二次高度。
- 顶部、左侧、右侧外壳统一改为不依赖当前宽高的 `inset(...)` 裁剪；悬停列表直接使用一次计算得到的目标高度，不再先展开外壳、后测量内容并二次调整。
- 普通运行、压缩和完成任务在折叠条及悬停列表中只显示对话名称；不再挂载用户消息、模型回复、工具目标、模型名、子 Agent、任务清单、缓存和上下文详情。审批、提问、错误及安装/信任提醒仍保留必要操作内容。
- 针对性测试 95 项、全量前端测试 53 个文件 618 项、Lint、前端生产构建和 NSIS 构建全部通过；前端构建由 902 个模块降至 892 个模块。
- 最新安装包：`releases/Vibe Board-latest-setup.exe`；SHA-256：`57a7aaf384eb04e9810224fab20e2d1ed367acf850da399321a12312fff0a8e6`。
