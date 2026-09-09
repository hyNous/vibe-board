# Vibe Board 开发交接

更新时间：2026-09-09

## 1. 当前基线

- 仓库：`D:\Projects\code island\control-tower`
- 分支：`local/control-tower-dev`
- 产品名：`Vibe Board`
- 当前版本：`3.1.1`
- 当前阶段：Windows 产品化与悬浮看板体验完善
- 功能检查点提交：`c66cd17 feat: simplify Vibe Board task panel`
- 开始新任务前请先执行 `git status --short` 和 `git log -3 --oneline`，不要重做已经提交的功能。

保留旧名称的 Rust package、Tauri identifier、本地数据目录、深链、插件目录和兼容读取字符串，不代表仓库存在另一套旧版本。它们仍承担安装升级、本地数据迁移或既有 Hook 兼容，不能机械删除。

## 2. 当前产品形态

### 屏幕边缘看板

- 悬浮组件只挂靠在屏幕顶部、左侧或右侧，不再自由悬浮。
- 用户直接拖动即可切换挂靠边缘；侧边模式可以沿屏幕上下调整位置。
- 左右侧收起态采用上下式排列并贴紧屏幕边缘。
- 鼠标进入后展开，移出后立即收回；没有倒计时进度条或完成通知自动停留。
- 顶部展开使用一次原生窗口位置/尺寸提交，并移除了依赖宽高插值的裁剪与二次测高，避免左右分区式二次展开。

### 展开内容

展开后的固定看板按从上到下排列：

1. 当前任务；
2. Agent 在线状态与额度；
3. Vibe Board 图标和 `Vibe Coding 看板` slogan。

任务区域支持垂直滚动，以适配不同数量的 Agent。任务只显示 Agent、对话名称和运行状态，不显示模型回复、用户消息、工具详情、上下文或会话正文。

### 点击任务

- 有 Desktop 端的 Agent：点击任务会恢复最小化窗口并将其置于前台。
- 只有 CLI 的 Agent：点击后提示“请手动打开 CLI 查看执行进度”。
- 按下状态只在指针或键盘按下期间轻微加深/下沉，不形成持续选中态，也不改变布局。

### Agent 与额度

- Codex、Claude Code、OpenCode、Antigravity 等可同时出现在看板中；宿主只决定自动唤醒关系，不会排除其他 Agent。
- Antigravity 额度按实际模型组分行显示，Gemini 主模型和 Office/其他模型组不再压在同一行。
- 在线状态与“正在执行任务”是两套信号：进程扫描只能确认 Agent 在线，不能据此创建任务。

## 3. 当前任务同步链路

当前采用“事件推送 + 定时轮询兜底”：

1. Agent Hook 或 Codex app-server 事件写入 Rust `SessionStore`。
2. `SessionStore` 发送 `session-update`，看板立即替换前端会话快照。
3. 前端定时调用 `get_sessions` 和 `get_agent_statuses`；默认每 3 秒，可在设置中调整为 1–30 秒。
4. Codex app-server 保持 WebSocket 通知，并定期执行 `thread/list`。默认配置下，活跃、空闲可见、安静后台模式分别约为 30、60、300 秒。
5. `get_sessions` 会补读 `%USERPROFILE%\.codex\sessions` 下最近的 Codex rollout，根据 `task_started`、`task_complete`、`turn_aborted` 和 `turn_failed` 恢复状态。

这条链路是尽力同步，不是强一致。Codex Desktop 不保证调用 Vibe Board Hook，本地 rollout 的写入时机和格式也不是 Vibe Board 控制的；仅靠轮询无法承诺 100% 捕获所有正在执行的任务。

## 4. 首次设置与迁移

- Windows 首次启动向导会说明本地权限边界、扫描已安装 Agent，并允许选择一个宿主和多个子 Agent。
- 用户批准后，向导保存宿主关系、自动启动和登录启动选项，并安装、校验所选 Hook。
- Agent 或 Hook 配置失败属于可修复警告，不再阻止用户完成首次设置和进入产品。
- 设置页可以重新运行 Agent connection 流程。
- 宿主 Agent 新会话可通过 Bridge 唤醒 Vibe Board；辅助进程以隐藏窗口方式运行。
- Antigravity CLI 使用 `agy`，不是 Gemini CLI。

## 5. 仓库清理与发布物

本轮已经清理：

- `releases/archive/` 中 4 个 Agent Island 历史安装包；
- `src-tauri/target/release/bundle/nsis/` 中 2 个旧名安装包；
- 未被当前代码引用的 Agent Island 旧品牌图片；
- 展示旧 AgentBro/Agent Island 界面的 README 截图和 social preview；
- 两份被忽略的 `debug-check` 临时日志。

中英文 README 已移除旧界面展示，并改为描述当前固定任务看板、点击唤回 Agent 和尽力同步边界。

仓库和 NSIS 输出目录现在各只保留一个当前 Windows 安装包：

- `releases/Vibe Board-latest-setup.exe`
- SHA-256：`484C7070B1CFA179A112EEA4DEE853761B202ACDDF6F3ECCEC9B51A81B6E63EF`

本轮未安装这个新包，也未覆盖用户机器上当前已安装的版本。

## 6. 本轮验证

- `pnpm test:run`：54 个测试文件、611 项测试全部通过。
- `pnpm build`：通过，873 个模块。
- `cargo check --manifest-path src-tauri/Cargo.toml --all-targets`：通过；只有仓库既有 dead-code 警告。
- `git diff --check`：通过；仅有既有的 LF/CRLF 提示。
- `cargo tauri build --bundles nsis --ci --config '{"bundle":{"createUpdaterArtifacts":false}}'`：通过。

## 7. 已知边界与下一步

优先级最高：

1. 使用真实 Codex Desktop 活跃任务做端到端验收，记录 app-server、rollout 和看板状态，继续提高漏检场景的同步可靠性。
2. 安装本轮最新 NSIS，手动验收顶部/左右挂靠、悬停展开收回、任务滚动和点击唤回 Desktop Agent。

当前边界：

- Codex 正在执行任务时，看板仍不能保证 100% 同步。
- Windows 是当前交付平台；macOS 尚未做设备级安装与交互验收。
- Windows 安装包尚未签名，SmartScreen 可能提示。

待用户确认后再处理：

- `docs/plans/` 和 `docs/superpowers/` 的历史设计/实施文档；
- 根目录 `qa-agent-island-state-tests.py`、`test-agent-island-hook.py`、`test-agent-island-hook.sh` 手工 QA 脚本。

这些文件不参与运行和安装，但仍可能用于历史追溯或手工回归，因此本轮没有擅自删除。

## 8. 新任务注意事项

- 不要为了“去除旧名称”删除兼容路径、旧配置读取、Tauri identifier 或既有插件入口。
- 不要把 Agent 进程在线状态当作正在执行任务。
- 不要恢复会话正文、模型回复或工具详情到任务看板。
- 普通任务点击只负责唤回 Desktop Agent；CLI-only Agent 只提示手动查看。
- 修改动画前先复现并核对原生窗口尺寸、位置和 WebView 内容动画，不要重新引入二次 resize 或自动展开计时器。
