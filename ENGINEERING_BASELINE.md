# ENGINEERING_BASELINE — Vibe Board（逐项测试与 UI 改版阶段）

> 建立：2026-09-21 · 最后修订：2026-09-21 · 代码基线：`c86f601`
> 需求唯一依据：[`docs/product/backlog-2026-09-18.md`](docs/product/backlog-2026-09-18.md)（2026-09-21 维护者确认）。
> 本文件只把范围拆成可验收的里程碑，不重新讨论范围。

---

## 1. Goal / Non-goals / Success Criteria

### Goal

把 Vibe Board 收敛为多 Agent「任务观察 + 额度观察 + 成本分析」桌面看板：修复看板对
Claude Code 失明的 P0 缺陷，删除观察之外的交互与非目标模块，重组设置页，补上 Skill 来源、
派发框架搭建向导、用量记录仪表盘和首次向导教程。

### Non-goals

| Non-goal | Why excluded | Revisit when / Alternative |
| --- | --- | --- |
| 在看板上批准、回答、与 Agent 对话 | 定位只看不操作；权限提示会误报 | 需先解决自动审批下的误报 |
| MCP 管理、Plugin 管理、技能包 | PRD 5.3 非目标 / 与「生效于」重复 | — |
| Agent 安装 / 升级 | PRD 5.3 非目标 | 由各 Agent 自身或包管理器负责 |
| 运行时派发通道（任务经 Vibe Board 转发） | 派发只做「搭建助手」 | — |
| 软件内接入未知 CLI、自动写派发规则 | 需判断力；全局指令文件属用户 | 交给 Agent 运行 `external-agent-setup` |
| 实际账单成本 | 订阅制下不存在按 token 计费的真实金额 | Provider 提供账单接口且维护者要求时 |
| 任何默认开启的自动行为（开机自启、会话拉起、联网取数） | 维护者原则：由用户自己打开 | — |
| Windows 上既有 32 项 Rust 测试失败的修复 | 测试自身 POSIX 假设，非本阶段范围 | ROADMAP「修 Windows 上的单元测试」 |

### Success Criteria

| # | Criterion | Verification |
| --- | --- | --- |
| S1 | Windows 上 Claude Code 触发的 Hook 事件能到达看板 | 自动：模拟 bash/cmd 执行生成的命令（M1）。**真机：维护者开 Claude Code 会话后 `invocations.jsonl` 出现 `claude-code` 记录** |
| S2 | 任何 Hook 都不会让 Agent 等待看板回应 | 假服务端「接受连接但永不回复」时，bridge 对所有事件在 2 秒内退出（M2） |
| S3 | 已删除功能在命令注册表与界面中均不存在 | `invoke_handler` 与前端 grep 为零（M2、M3、M4） |
| S4 | 全新配置下没有任何自动行为被开启 | 全新配置夹具断言（M4、M8c） |
| S5 | 设置页结构与范围文件第 4 节一致，且原有可编辑配置项无遗漏 | 结构测试 + 配置项清单对照（M6） |
| S6 | 记录在 `.skill-lock.json` 中的 GitHub Skill 显示为 GitHub 来源 | 隔离 HOME 夹具测试（M5） |
| S7 | 派发框架向导能幂等地把已知工人装进派发者，且不改全局指令文件 | 隔离 HOME 夹具测试（M7） |
| S8 | 额度页显示剩余额度与日/周/月等价成本（标 Estimated），联网取数仅在逐 Provider 授权后发生 | 夹具测试 + 网络调用断言（M8） |
| S9 | 教程出现在首次向导中，可从设置重开，离线可用，用应用窗口打开 | 夹具测试 + 维护者目视（M9） |
| S10 | 每个里程碑结束时标准检查全绿，Rust 失败集合是基线的子集 | 见第 2 节「检查命令」 |

---

## 2. Constraints & Assumptions

| Item | Type | Status / Evidence |
| --- | --- | --- |
| Windows x64 为唯一交付平台 | Constraint | VERIFIED — RELEASING.md |
| 本机无全局 pnpm，前端脚本用 `corepack pnpm` | Constraint | VERIFIED — 2026-09-18 构建 |
| 前端测试基线：46 文件 519 项全过 | Constraint | VERIFIED — `97aef2f` 复核 |
| Rust `cargo test --lib` 在 Windows 上有既有失败，名单固定在 `docs/engineering/windows-known-rust-failures.txt` | Constraint | VERIFIED — 2026-09-21 于 `c86f601` 采集 |
| 外部 Agent（OpenCode，`opencode-go/deepseek-v4.1-flash`，max）执行里程碑；不提交、不推送；父级读 diff 并独立验证 | Constraint | 维护者规则 |
| Hook 命令路径 bug 根因：`hook_manager::bridge_command_parts` 在 Windows 上使用 `bridge.display()`，产生反斜杠 | Evidence | VERIFIED — 代码 + bash 复现（退出码 127）+ 正斜杠复测通过 |
| 阻塞超时 `21_600` 秒出现在多家事件表：Claude Code / Codex / Qwen / Qoder / ZCode 的权限请求，Antigravity 的 `PreToolUse`，Gemini 的 `BeforeTool` | Evidence | VERIFIED — `agents/profiles.rs` |
| Claude Code 在 Windows 上通过 bash 执行 Hook | Assumption | ASSUMPTION — NOT VERIFIED（与 4.8 万条记录中 Claude Code 仅 1 条一致，未读其源码确认） |
| Codex 等其它 Agent 在 Windows 上执行 Hook 所用的 shell | Assumption | UNKNOWN — M1 需同时满足 bash 与 cmd |
| 桌面版 Agent（Claude 桌面 App、Codex 桌面版）不执行命令行 Hook | Assumption | ASSUMPTION — NOT VERIFIED，需维护者开 Codex 命令行会话实测 |
| 价格表随安装包内置、随版本更新，运行时不下载 | Assumption（设计取舍） | 由「默认不联网」原则推出，维护者未单独确认；可改为可选下载 |
| 界面只提供中文、英文；日、韩、土三种语言已删除，旧配置中的这三种语言回落英文 | Constraint | 维护者 2026-09-22 决定 |
| 旧配置里默认开启的「宿主会话拉起」不迁移为新的每 Agent 开关（升级后一律为关） | Assumption（设计取舍） | 由「自动行为默认关」原则推出，维护者未单独确认 |

### 检查命令（每个里程碑的最低门槛）

```bash
corepack pnpm lint
corepack pnpm test:run
corepack pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --manifest-path src-tauri/Cargo.toml --all-targets
cargo test --manifest-path src-tauri/Cargo.toml --lib   # 失败集合 ⊆ 已知失败名单
node scripts/check-release-readiness.mjs
```

前端测试总数可以因删除功能而减少，但被删测试必须只覆盖被删功能，并在交付说明中列出。
**不允许只删断言让测试变绿。**

---

## 3. Architecture Boundaries

只列本阶段会改动且需要守住的边界。

| Module | Owns | Must not know | Stable Interface |
| --- | --- | --- | --- |
| Bridge（`src-tauri/src/bridge/`） | 读取 Agent 的 Hook 输入，转发为事件，立即退出 | 界面、审批决定；**不得等待看板回应** | 进程参数 `--source` 等；stdin 事件 JSON；stdout 不输出决定 |
| Hook 安装器（`agents/profiles.rs`、`agents/hook_manager.rs`） | Vibe Board 托管的 Hook 条目的写入、升级、移除 | 用户自己的非托管 Hook 条目（不得改动） | 每个 Agent 的事件表；托管条目识别规则 |
| 会话状态（`hooks/session_store.rs` + 前端 `sessionStore`） | 把事件归并为「执行中 / 等待输入 / 结束」 | 审批状态（删除后不存在） | 会话快照结构 |
| 用量 Provider（M8 新建） | 每家：读凭据 → 取数 → 归一化 | 界面布局；其它 Provider 的细节 | 统一快照结构（剩余额度、重置时间、来源、新鲜度） |
| 用量历史（M8 新建） | 增量扫描 Agent 会话日志、按天汇总、持久化 | 联网；凭据 | 按日期查询的日汇总 |
| 派发搭建引擎（M7，复用 `setup-agent.mjs`） | 检测、预览、确认后写入具名 Skill | 凭据的值；用户全局指令文件 | `--detect` / `--plan` / `--apply --confirm` |

**反过度设计检查**：用量 Provider 抽象成立，因为至少四家（Codex / Claude / OpenCode /
Antigravity）的取数方式真实不同，且现有「一家一个定制函数」已造成页面看不懂。不新增事件总线、
通用插件系统、远程价格服务或独立守护进程。

---

## 4. Contracts & External Integrations

| Boundary | Input / Output / Failure Contract | Verification |
| --- | --- | --- |
| Agent → Bridge | 输入：Hook 事件 JSON。输出：退出码 0，**不向 stdout 写任何审批决定**。看板不可达：记录 `forwarded:false` 后立即退出 | 假服务端测试（M2） |
| Vibe Board → Agent 配置文件 | 只增删改托管条目；非托管条目逐字节不变；重复安装幂等 | 夹具对比测试（M1、M2） |
| `.skill-lock.json`（外部工具写入） | 只读。缺失或格式损坏时回落为无来源信息，不报错 | 夹具测试（M5） |
| 派发 Skill 安装 | 预览列出的文件 = 实际写入的文件；未确认不写；不写 `CLAUDE.md` / `AGENTS.md` | 夹具测试（M7） |
| Provider 官方用量接口 | 仅在该 Provider 授权后请求；超时有上限；失败显示 Unknown 不伪造；凭据不进日志 | M8c 能力矩阵 + 测试 |

### Provider 能力矩阵（M8c 第一步填写，当前均为 UNKNOWN）

| Provider | 剩余额度来源 | 历史用量来源 | 需联网 | Verified |
| --- | --- | --- | --- | --- |
| Codex | 本地 app-server 桥接（现有） | `~/.codex/sessions/*.jsonl`（本机 654 个，含 token 分项与模型名） | 否 | 历史字段 VERIFIED；接口 UNKNOWN |
| Claude Code | UNKNOWN | `~/.claude/projects/*.jsonl`（本机 18 个） | UNKNOWN | UNKNOWN |
| OpenCode | `OPENCODE_GO_USAGE_URL`（现有，读本地 API key） | UNKNOWN | 是 | 现有实现，未 probe |
| Antigravity | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |

---

## 5. Failure / Side Effects / Lifecycle

| Case | Recoverable? | Handling | Verification |
| --- | --- | --- | --- |
| 看板未运行时 Agent 触发 Hook | 是（事件丢失可接受） | 立即退出，不阻塞 | M2 假服务端测试 |
| 看板运行但无响应 | 是 | bridge 不读回应，写完即退出 | M2 |
| 已安装用户的旧 Hook 命令（反斜杠格式） | 是 | 自检标记为「需修复」；重新安装时原位替换 | M1 |
| 升级后 Agent 配置中残留已删除的事件条目 | 是 | 重新安装时移除；非托管条目不动 | M2 |
| 旧配置含 `hostAgent` / `childAgents` / `autoStartOnHostSession` | 是 | 读取时忽略，不再写回 | M4 兼容测试 |
| 旧 Skill 库中已有技能包数据 | 是 | 停止读写，**不删表**（保留回退余地） | M3 |
| 单个会话日志超大（实测 176 MB） | 是 | 增量扫描，按路径+大小+修改时间缓存，分批读取，超大单条跳过并记日志 | M8b |
| Agent 清理旧日志 | 是 | 日汇总已持久化，历史不丢 | M8b |
| Provider 接口超时 / 认证失败 / 格式变化 | 是 | 显示 Unknown + 原因，不重试风暴，不伪造数 | M8c |
| 用户撤销某 Provider 授权 | 是 | 立即停止该 Provider 的请求；已取得的数据保留并标注来源 | M8c |
| 派发 Skill 重复安装 | 是 | 幂等，不产生重复条目 | M7 |

---

## 6. Conditional Risks

- **C-SEC**：写入用户的 Agent 配置文件（Hook）与 Skill 目录；使用用户凭据调接口。
  → 只动托管条目；预览 + 确认后才写；凭据只在运行时读取、不落日志、不在界面显示值；
  联网取数逐 Provider 授权、默认关、可撤销。
- **C-EXT**：Provider 官方用量接口。→ M8c 先做能力矩阵与最小真实 probe，未验证的 Provider
  不上线联网取数。
- **C-RUN**：Hook 进程生命周期（不得阻塞）；超大日志扫描。→ 见第 5 节。
- **C-PERSIST**：配置字段删除与新增（宿主、启动开关）；Skill 库保留旧表；新增用量日汇总存储。
  → 旧配置可加载的兼容测试；新存储带版本号；启动后状态可恢复。

---

## 7. Milestones

执行顺序即编号顺序，**串行**（大量共享 `lib.rs` 命令注册表、i18n 五语言文件与设置页）。
每个里程碑完成后，父级按第 2 节检查命令独立验证，并对照本节验收标准逐条判定。

### M0 — 已完成，待维护者真机验证

| 项 | 提交 | 验证 |
| --- | --- | --- |
| 设置窗口最小化后无法恢复 | `6a10602` | 打开设置 → 标题栏最小化 → 从灵动岛再次打开设置 → 应还原并获得焦点 |
| 角色主题整块删除 | `97aef2f` | 目视灵动岛收起态、展开态与删除前一致 |

### M1 — P0：Hook 命令在 Windows 上可执行

**Scope**：修正所有托管 Hook 命令在 Windows 上的可执行路径格式；让已安装用户能发现并修复旧格式。

**Acceptance Criteria**
1. Windows 上生成的每一条托管 Hook 命令中，可执行文件路径不含反斜杠 `\`。
2. 在隔离的临时 HOME 下，把生成的命令字符串分别交给 `bash -c` 与 `cmd /c` 执行、stdin 喂一条事件 JSON：两者退出码均为 0，且 `invocations.jsonl` 各新增一条记录。路径**含空格**的情况（例如用户名含空格）同样满足。
3. Hook 自检中「已安装 Hook」一项，能把配置里仍为旧格式的托管条目标为「需要修复」。
4. 重新安装 Hook 后，旧格式托管条目被原位替换；同一配置文件中的非托管条目**逐字节不变**。
5. 以上 2–4 条有自动化测试覆盖；第 2 条的 bash 执行测试在未安装 bash 的环境下跳过并注明原因，而不是失败。

**Verification**：检查命令全绿；父级另在本机用 bash 与 cmd 各执行一次新生成的命令并核对记录。

**状态（2026-09-21）：PASS WITH RISKS，代码已合入，待维护者真机验证 S1。**
父级独立验证：`cargo fmt --check` 通过；`cargo test --lib` 552 通过 / 32 失败，失败集合与已知名单完全一致；
`release:check` ok；在带空格的隔离目录中以 Git Bash 与 `cmd /d /s /c` 分别执行新命令，均退出码 0 并写入记录，
真实记录未被写入。风险记录：第 4 条在「条目内容」层面满足——JSON 配置会被安装器整体重新排版
（既有行为，非 M1 引入），因此整个文件并非逐字节不变。另：本机 PATH 上的 `bash` 是 WSL，
不能执行 Windows 程序；测试会自动改用 Git Bash。
**维护者真机**：升级后在「Hook 诊断」重新安装，开一个 Claude Code 会话，确认 `invocations.jsonl` 出现 `claude-code` 记录（S1）。

### M2 — 审批删除 + Hook 瘦身（必须同批）

**Scope**：删除灵动岛上全部三类交互卡片及其背后的回应通道；bridge 不再等待任何回应；按范围文件第 2 节瘦身事件表，其它 Agent 按同一原则处理。

**Acceptance Criteria**
1. 前端不存在权限审批、计划确认、问题回答三类卡片组件，也不存在调用 `respond_permission` / `respond_question` / `respond_plan` / `respond_auto_approve` 的代码；这四个命令从 `invoke_handler` 注销。
2. `agents/profiles.rs` 中任何事件表都不含 `21_600` 超时。
3. Claude Code 事件表恰为：`SessionStart`、`SessionEnd`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop`、`Notification`、`SubagentStart`、`SubagentStop`（9 个）。
4. 其它 Agent 事件表中不含权限请求、权限拒绝、工具失败、压缩开始、压缩结束五类事件（按各家事件名）；Gemini 的 `BeforeTool` 与 Antigravity 的 `PreToolUse` 保留但不阻塞。
5. 用一个「接受连接但永不回复」的假看板服务端，对 `PreToolUse`（含提问工具）、`BeforeTool`、`PermissionRequest` 三种输入各跑一次 bridge：均在 **2 秒内**退出，退出码 0，stdout 不含任何审批决定。
6. 向会话状态喂一条 `PreToolUse` 事件后，会话显示为执行中，状态中不存在「等待审批」。
7. 对一个已装有旧事件条目的配置夹具重新安装 Hook：被删事件的托管条目被移除，非托管条目逐字节不变。

**Verification**：检查命令全绿；父级复核 `grep -rn "21_600\|respond_permission\|PermissionCard"` 除「断言不存在」的测试外为零。

**状态（2026-09-21）：PASS WITH RISKS，已合入。**
父级独立验证：前端 lint / build 通过，`test:run` 44 文件 470 项全过（由 519 降至 470，被删测试逐条核对均只覆盖被删功能）；
`cargo fmt --check`、`cargo check --all-targets` 通过；`cargo test --lib` 541 通过 / 32 失败，失败集合与已知名单一致；
`release:check` ok。**自写假看板实测**：对提问工具、普通工具、Gemini BeforeTool、权限请求、Antigravity 五种输入，
bridge 均连上「只接受不回复」的服务端并在 0.3 秒内退出，退出码 0，stdout 无任何审批决定（Antigravity 输出 `{}` 为其协议所需的空回应）。

**父级复核中发现并修复的 S1 安全遗留（C-SEC）**：旧版安装 Gemini Hook 时会把 `security.permissions.mode` 写为 `auto`，
使 Gemini 不再自行询问、改由看板审批框拦截。M2 删除审批后，已安装用户的 Gemini 将**无任何确认地执行所有工具**。
已修复：重装或卸载 Gemini Hook 时，若该文件原本含 Vibe Board 托管的 Gemini Hook，则撤销 `mode: "auto"`；
从未装过托管 Hook 的文件中用户自设的 `auto` 保留。三条测试覆盖。

**Plan Drift（UNJUSTIFIED，轻微）**：worker 删除了浏览器开发专用的 `ClaudeHookUiLab` 调试台，其中含空岛、回复提示、
多会话等非审批场景。不影响用户，可从 `b87f5c4` 恢复；UI 改版若需要调试台可取回。

**已确认无风险**：Codex app-server 的审批请求不再被回应——但前端已无任何调用「向 Agent 发消息」的入口，
看板不会发起 Codex 回合，因此不会收到需它回应的审批请求。

**遗留给后续里程碑的死代码**（已不产生任何行为）：
- M3：`send_message` 命令、前端 `sendMessage`、`sessionCapabilities` 的 Composer 能力判断、`claude_code::send_message_to_terminal`
  等「向 Agent 发消息」整套代码（属「与 Agent 对话」非目标，前端已无入口）；webhook 模板中的 `WaitingApproval` 通知；
  五语言中三类卡片与 `notch.tool.*` 的文案键。
- M6：设置页中的全局「批准 / 拒绝 / 跳过」快捷键与 `autoApproveTools` 控件（已无作用）。

### M3 — 删除非目标模块

**Scope**：MCP 管理、Plugin 管理、Agent 更新 / 安装操作、技能包（v1 `*_pack_cmd` 与 v2 `*skill_pack*` 两套，含托盘技能包选择器）、`agentctl` 与任务追踪演示；
以及 M2 复核时发现的死代码：「向 Agent 发消息」整套（`send_message` 命令、`sendMessage`、Composer 能力判断、`send_message_to_terminal`）、
webhook `WaitingApproval` 通知模板、三类卡片与 `notch.tool.*` 的五语言文案键。**声音包（`import_sound_pack`、`set_sound_pack`）不在范围内，必须保留。**

**建议拆成两个派发包**：(a) MCP + Plugin；(b) 技能包 + Agent 更新安装 + `agentctl`。

**Acceptance Criteria**
1. `invoke_handler` 中不再注册：全部 `*mcp*` 命令、`install_plugin_cmd`、`*plugin*_v2` 命令、`agent_install`、`agent_update`、v1 `list/create/update/delete/apply_pack_cmd`、v2 全部 `*skill_pack*` 命令与 `skill_pack_picker_data`、`dispatch_agent`、`create_demo_task_trace`。`import_sound_pack`、`set_sound_pack` 仍在。
2. `skills/mcp_management.rs`、`skills/plugin_management.rs`、`control_tower/agentctl.rs`、`bin/agentctl.rs` 不存在；`Cargo.toml` 无 `agentctl` 二进制目标。
3. 前端不存在 MCP、Plugin、技能包的页面、标签页与组件；托盘菜单无技能包选择器入口；任务看板页无「演示任务」按钮，「当前实时任务」区块照常工作。
4. Agent 页不再有更新 / 安装按钮；已安装 Agent 的版本号、程序路径仍以只读方式显示。
5. 旧 Skill 库（含技能包相关表）能正常打开，**不执行删表迁移**。
6. 五语言文件中因此失效的键删除；i18n 键完整性测试通过。

**Verification**：检查命令全绿；父级按第 1 条逐个 grep 命令名。

**状态（2026-09-22）：M3 PASS WITH RISKS，M3a、M3b 均已合入。**

M3b 父级独立验证：前端 40 文件 407 项全过，lint / build 通过；`cargo test --lib` 511 通过 / 23 失败，失败集合 ⊆ 已知名单；
`release:check` ok；`invoke_handler` 中被删命令命中 0，`set_sound_pack`、`import_sound_pack` 仍注册。
worker 修改了 `check-release-readiness.mjs` 的置顶窗口检查：原检查在 `lib.rs` 中搜索 `.always_on_top(true)`，唯一满足者是被删的
技能包选择窗口；现同时接受 `tauri.conf.json` 中 `alwaysOnTop: true` 的窗口（灵动岛窗口即如此）。父级判定为**保持检查意图、
改用准确依据**，不是放宽。
**已记录的技术债（S2）**：v2 服务内部的技能包读写逻辑与表保留（与分发 claim 汇总交织，已无命令 / 界面可达）；
`control_tower/db.rs` 的 `insert_child_run` 等 4 个方法已无调用者，新增 dead_code 警告。
**移交 M6**：派发器删除后已无任何代码写入任务追踪库，但任务看板页仍读取 `get_task_traces` 并保留任务树渲染代码，
该区块只会为空；另有 `jumpBeforeSend` 设置已无消费者。
M3a 父级独立验证：前端 42 文件 461 项全过，lint / build 通过；`cargo test --lib` 523 通过 / 24 失败，失败集合 ⊆ 已知名单
（8 项随被删功能消失或裁掉 MCP/Plugin 断言后转绿）；命令注册表 mcp/plugin 命中 0；`release:check` ok。
worker 额外删除 `skills/codex_config.rs`：父级核实其全部公开函数只服务 MCP/Plugin；`profiles.rs` 中同名的 `set_plugin_enabled`
是本地函数（Hook 插件激活），OpenCode / Hermes Hook 安装测试均通过。保留了 MCP **工具调用的观察显示**（属观察功能，正确）。
遗留：`SkillManagerV2.css` 中约 463 处 `.sm2__mcp-*` / `.sm2__plugin-*` 死样式，并入 M3b 机械清理。

### M4 — 宿主移除 + 启动行为

**Scope**：删除宿主概念与 `plugins/vibe-board-host`；「会话开始时拉起看板」改为每个 Agent 一个开关，默认全关；开机自启保持默认关。

**Acceptance Criteria**
1. 后端不再读写 `host_agent`、`child_agents`、`auto_start_on_host_session`，不再使用 `usage_host` 标记文件。含这些旧字段的 `config.json` 能正常加载且字段不被写回（兼容测试）。
   **更正（2026-09-22）**：本条原文要求注销 `activate_session_host`，是父级写基准时**按名称误判**。该命令的作用是把承载会话的桌面 App 窗口
   （如 Codex Desktop）调到前台，即「点任务唤回桌面 Agent」这一核心功能；纯命令行会话时返回 false 以提示用户手动打开 CLI。它与「宿主 Agent」
   概念无关，**必须保留**。M4 执行时据此误删，父级已原样恢复（见下方状态）。
2. 全新配置下：`launch_at_login` 为关；没有任何 Agent 的「会话开始时拉起」为开（测试断言）。
3. 升级用户：旧配置中的 `autoStartOnHostSession: true` **不**转换为任何 Agent 的开关（测试断言）。
4. bridge 收到某 Agent 的 `SessionStart` 时，当且仅当该 Agent 的开关打开才尝试拉起看板（配置夹具测试，拉起动作以桩替代）。
5. 首次向导只有「选择要接入的 Agent」的多选，没有宿主 / 子 Agent 之分；每个 Agent 的拉起开关默认关，旁边注明「桌面版 Agent 可能不触发」。
6. 界面中不存在「宿主」字样与徽章；额度页无「Host Quota Remaining」头条。
7. `plugins/vibe-board-host` 目录、`.agents/plugins/marketplace.json` 中的对应条目及其安装代码移除。

**Verification**：检查命令全绿；父级 grep `hostAgent|host_agent|usage_host|宿主|vibe-board-host`，除兼容测试与迁移夹具外为零。

**状态（2026-09-22）：PASS WITH RISKS，已合入。**
父级独立验证：前端 40 文件 407 项全过，lint / build 通过；`cargo test --lib` 513 通过 / 23 失败，失败集合 ⊆ 已知名单；
bridge 测试 9/9（含「仅开关打开的 Agent 触发拉起」「全新配置从不拉起」）；配置兼容测试证明含旧宿主字段且
`autoStartOnHostSession: true` 的旧配置可加载、旧字段不写回、不产生任何拉起开关；宿主字样残留仅在兼容测试中；`release:check` ok。

**父级复核中发现并修正的回归（由基准错误导致）**：基准原 AC1 要求注销 `activate_session_host`，worker 照做，并把任务点击改为
`jump_to_terminal`、删除「纯命令行会话请手动打开 CLI」提示。该命令实为「点任务唤回桌面 Agent」的核心功能（见 AC1 更正）。
父级已从 `76c6534` 原样恢复：4 个后端函数、命令注册、`activateSessionHost` 包装、`TaskBoard` 点击行为与提示、提示样式、
五语言两条文案、2 条测试；恢复后 `TaskBoard.tsx`、`NotchPanel.css`、`taskBoard.test.tsx` 与恢复前版本**零差异**。
函数上补注释说明此处 host 指承载会话的 App 窗口，与已删除的宿主概念无关。

**风险记录**：向导的「会话拉起开关」与桌面版提示无自动化界面测试，已读代码核对（默认值取自空的 `autoLaunchAgents`，
未选 Agent 时开关禁用），待维护者目视。向导全部文案为内联中英双语（改动前即如此，39 处），不走五语言文件——既有债务，
与 M9 教程「第一版中英」一致。

### M5 — Skill 管理改造

**Scope**：「分发」改称「生效于」；只显示已安装 Agent；按来源自动分类并读取 `.skill-lock.json`；诊断改为页内提示；Skill 内的 Agent 视图只显示生效关系。

**Acceptance Criteria**
1. Skill 管理界面的用户可见文案中不再出现「分发 / Distribute」及其日、韩、土对应词；五语言键集合一致。
2. Agent 列表与筛选标签默认只显示检测到可执行程序的 Agent；其余（含「只找到配置目录」的）收在一个「+」控件后，点开才显示。测试夹具覆盖三种状态：已安装 / 仅配置 / 未安装。
3. 隔离 HOME 下放一份含 GitHub 条目的 `~/.agents/.skill-lock.json`：对应 Skill 显示来源为 GitHub，「GitHub 来源可检查」计数 ≥ 1，检查更新按钮可用。
4. `.skill-lock.json` 缺失或内容损坏时，Skill 页正常显示，不报错。
5. 提供「自定义 / GitHub / 从 Agent 同步」三个来源筛选，且每个 Skill 恰好归入其一。
6. 「诊断与修复」不再是独立标签页；坏链接等问题以提示形式出现在 Skill 库页面，测试夹具覆盖一个坏软链。
7. Skill 管理内的 Agent 视图只显示「该 Agent 生效了哪些 Skill」，不显示版本、Hook 等 Agent 本身信息。

**Verification**：检查命令全绿；父级用本机真实 `.skill-lock.json`（25 条）只读核对来源显示。

**状态（2026-09-22）：PASS WITH RISKS，已合入。**
父级独立验证：前端 40 文件 410 项全过（M4 为 407：删 6 条只覆盖被删的 Agent 概览 / Hooks / 配置子页，加 9 条），
lint / build / fmt / `cargo check --all-targets` 通过；`cargo test --lib` 519 通过 / 23 失败，失败集合 = 已知名单子集；`release:check` ok。
读 diff 核对：`skill_lock.rs` 只读、缺失或损坏返回空索引、来源不落库（删 lock 即还原）；程序检测纯文件系统、不起进程、缓存 60 秒；
诊断标签页删除后问题以 `SkillIssuesPanel` 嵌在 Skill 库页；Hook 安装入口仍在 `IslandSection` 与首次向导（M6 再迁）。
本机只读核对：lock 25 条中 23 条为 GitHub，其中 22 条在 `~/.agents/skills` 有同名目录。

**风险记录**：①「五语言键一致」只在 Skill 管理命名空间内成立；仓库整体既有不一致（tr 缺 169 键、zh 多 38 个旧键），留给 M6 清理。
②skills-v2 多数页面文案仍是硬编码中文（既有债务）。③store 的 `loadDiagnosisIssues` 已无调用者，未删。
④Agent 管理页仍保留自定义 Agent 增删 / 卸载，去留属 M6。⑤无界面目视，待维护者确认「＋」折叠与来源筛选。

### M6 — 设置页重组

**Scope**：按范围文件第 4 节重建导航；拆分 `IslandSection.tsx`；Hook 界面从设置移除，改为灵动岛上的健康指示；「派发框架」页先承载 Agent 检测（只读）。

**Acceptance Criteria**
1. 侧边导航的分组与条目、顺序恰为：运行（任务看板、使用额度）／管理（Skill、派发框架）／外观／快捷键／系统（通用、重看教程与向导、关于）。有测试断言。
2. 外观页中不含快捷键、Hook 诊断、已检测工具、自定义 Hook 配置、用量 Provider 设置。
3. **配置项不丢失**：列出重组前在设置页中可编辑的全部配置键（扣除 M2–M4 已删功能对应的键），重组后每一个仍可在某个页面编辑。清单与对照结果写入交付说明。
4. 灵动岛健康指示：自检全部通过时不显示；任一项失败时显示；点击展开六项自检结果。测试夹具覆盖两种状态。
5. 用量 Provider 设置出现在「使用额度」页。
6. 「派发框架」页显示已安装 Agent 的名称、版本、程序路径（只读），无更新 / 安装按钮。
7. 任务看板页只保留「当前实时任务」：移除任务追踪（任务树）区块与 `get_task_traces` 命令，以及已无调用者的
   `control_tower` 写入方法；`tasks.db` 文件与迁移逻辑保留（兼容旧安装）。
8. 移除已无作用的设置控件：全局「批准 / 拒绝 / 跳过」快捷键、`autoApproveTools`、`jumpBeforeSend`；旧配置含这些字段时仍能加载。

**Verification**：检查命令全绿；父级核对第 3 条清单。

**状态（2026-09-22）：PASS WITH RISKS，已合入。**
父级独立验证：前端 41 文件 412 项全过，lint / build / fmt / `cargo check --all-targets` 通过；`cargo test --lib` 518 通过 / 23 失败，
失败集合 = 已知名单子集；`release:check` ok。
- AC3 父级复算：用脚本比对改动前后所有 `updateConfig` 调用的配置键（旧 50 / 新 49），差集仅 `jumpBeforeSend`（AC8 要求删除）。
- 五语言清理复核：en 删除 481 键，其中落在动态拼接前缀下的只有 `settings.shortcutActions.approve-action / reject-action`（随 AC8 删除）；
  删除键无一仍被代码字面引用；代码引用而文件缺失的键由 66 降到 38，且 38 个均为改动前既有（靠内联 defaultValue）。
- 配置兼容：含批准 / 拒绝 / 跳过快捷键字段的旧配置可加载、旧字段不写回（新增 Rust 测试）。

**风险记录**：①健康指示复用原 Hook Doctor 全部检查，除 Hook 未安装外，「尚无任何 Agent 接入」「bridge 版本旧」「Codex live-sync 未运行」
也会亮灯，可能在维护者机器上常亮，待真机观察后决定是否收窄为只看 Hook 失败。②`uninstall_all_hooks` 命令已无界面入口，保留。
③界面未目视。

### M7 — 派发框架搭建向导

**Scope**：把四个派发 Skill 收进仓库并随安装包分发；在「管理 → 派发框架」提供检测 → 预览 → 确认安装的向导；未知工具交回 Agent；不碰全局指令文件。

**Acceptance Criteria**
1. `external-agent-core`、`external-agent-setup`、`opencode-agent`、`antigravity-agent` 位于仓库内一个明确目录，并列入安装包资源；`release:check` 通过。
2. 隔离 HOME + 桩可执行文件：向导检测出 OpenCode / Antigravity 的程序路径与版本；输出中不含任何凭据的值（只有「是否存在」）。
3. 「预览」列出的文件与「确认安装」实际写入的文件一致；未确认时不写任何文件。
4. 重复安装幂等：第二次安装不报错、不产生重复条目。
5. 安装前后 `CLAUDE.md`、`AGENTS.md` 等全局指令文件逐字节不变（测试断言）。
6. 未检测到 Node.js 时，向导显示提示且不尝试安装。
7. 对未知工具，向导显示「请在 Agent 中运行 `external-agent-setup`」的指引，不提供表单。

**Verification**：检查命令全绿；父级在隔离 HOME 下端到端跑一次。

**状态（2026-09-22）：PASS WITH RISKS，已合入。**
四个派发 Skill 由父级在维护者同意后原样复制进 `src-tauri/resources/dispatch-skills/`（审核：无密钥、账号、个人路径与运行记录），
worker 未改动其内容（父级 `diff -r` 与 `~/.agents/skills` 逐字节一致）。
父级独立验证：前端 43 文件 411 项全过，lint / build / fmt / `cargo check --all-targets` 通过；`cargo test --lib` 526 通过 / 23 失败，
失败集合 = 已知名单子集；派发向导 7 项 Rust 测试（隔离 HOME + 桩程序，使用仓库内真实 Skill 文件）覆盖预览 = 写入、未确认不写、
幂等、全局指令文件逐字节不变、缺 Node 阻断、凭据只报告文件是否存在；`release:check` ok。

**父级补充修正**：原预览不区分新建与覆盖。维护者机器上 `~/.claude/skills/opencode-agent` 是指向自建副本的软链，日后自建副本更新后
再点安装会被随包旧版静默覆盖。父级给每个预览文件加 `change`（create / unchanged / overwrite），有覆盖时显示醒目提示；
补 1 条 Rust 测试、2 条前端测试。

**风险记录**：①默认同时装进 Claude Code 与 Codex 两个目录，不做勾选。②没有走 Skill 管理的中心库，4 个 Skill 不会出现在 Skill 库的
「受管理」列表中（worker 理由：避免改变 Skill 管理行为）。③真实安装包内资源是否落盘未经完整打包验证。
④全量前端测试在本机负载下偶发 5 秒超时（`skillManagerV2View`、`unifiedUsageSection`），单跑与重跑均通过，属既有测试脆弱性。

### M8 — 用量记录仪表盘（三段）

体量最大，拆成三个里程碑，每段独立验收。

#### M8a — Provider 抽象 + 页面重构（只用现有本地数据）

1. 每个 Provider 实现同一「读凭据 → 取数 → 归一化」结构，输出同一快照类型；页面组件不含任何 Provider 名称分支。
2. 页面分上下两块：「现在」（各 Provider 剩余额度、重置时间、来源、新鲜度）与「用量与成本」（今天 / 本周 / 本月切换）。
3. 无数据时显示 Unknown，不显示 0。
4. 本阶段不新增任何网络请求（测试断言：用量模块中新增代码无 HTTP 调用）。

**M8a 状态（2026-09-22）：PASS WITH RISKS，已合入。**
新增 `src-tauri/src/usage/`（`UsageProvider` trait：`read_credentials` → `fetch` → `normalize`，统一 `UsageSnapshot`），
Codex / Claude Code / OpenCode / Antigravity 与目录项均走同一结构；页面分「现在」「用量与成本」两块，缺数据显示 Unknown；
删除 `CodexUsageSection` 与 `get_codex_usage_summary`（信息并入统一快照）。
父级独立验证：前端 43 文件 411 项（全量两次重跑均全过），lint / build / fmt / check 通过；`cargo test --lib` 532 通过 / 23 失败，
失败集合 = 已知名单子集；静态测试断言用量模块中 HTTP 客户端只在 `usage/opencode.rs`（原有调用）。

**风险记录**：①**既有隐私问题（非本次引入，父级比对 `HEAD` 确认）**：`list_usage_providers` 无论「用量查询」开关是否打开，都会调用
OpenCode 取数，在 10 分钟缓存过期后用本地 API key 请求 `opencode.ai`。M8c AC3「未授权零请求」必须修掉。
②「本周 / 本月」暂用近 7 / 30 天桶，真正的周月结算在 M8b。③旧页「每个 Agent 最近一次会话 token 合计」随改版移除。
④全量前端测试负载下偶发超时加重（本轮 4 条，超时后未清理 DOM 引发连锁「multiple elements」），单跑与重跑全过。

#### M8b — 历史与结算

1. 增量扫描 Codex 与 Claude Code 会话日志；以路径 + 大小 + 修改时间为缓存键，未变化的文件第二次扫描不重新解析（测试断言解析次数）。
2. 对一个 ≥ 150 MB 的合成日志文件：扫描期间内存峰值有上限（在交付说明中给出实测值），超大单条被跳过并记日志。
3. 按本地时区零点切分，按天汇总并持久化；删除源日志后，已汇总的历史仍可查询。
4. 周、月结算由日汇总加总得出，与直接逐条汇总结果一致（测试）。
5. 等价成本按内置价格表计算，界面一律标 `Estimated`；价格表带生效日期并在界面可见；未知模型显示 Unknown 而非 0 元。

**M8b 状态（2026-09-22）：PASS WITH RISKS，已合入。**
新增 `src-tauri/src/usage/history/`（流式扫描、SQLite 日汇总 `~/.vibeboard/usage-history.db`、价格表）与随包 `resources/usage/pricing.json`。
扫描由打开额度页触发、在后台线程执行，不在应用启动时自动跑。
父级独立验证：前端 43 文件 413 项全过，lint / build / fmt / check 通过；`cargo test --lib` 553 通过 / 23 失败，失败集合 = 已知名单子集；
大日志测试（约 152 MiB 合成日志）实测进程峰值约 15.2 MiB，断言 ≤ 128 MiB；测试未残留大文件。

**风险记录**：①价格表 17 条全部 `verified:false`，父级按已知公开价核对数值无误，但只覆盖较早的模型；维护者在用的新型号
（较新的 Claude Opus / Sonnet、`gpt-5.x` 系列等）不在表内，会显示 Unknown，需维护者按官网补表。②Codex 模型名字段与 Claude
日志结构由仓库既有解析推断，**未用维护者真实日志核对**（读取真实会话日志被权限检查拦下，按维护者「需确认的先跳过」处理），
待维护者回来后用真实日志核对统计数字。③Claude 的子 Agent 日志一并计入。

#### M8c — 逐 Provider 授权与联网取数

1. 先填写第 4 节 Provider 能力矩阵：每个拟联网的 Provider 做一次最小真实 probe，结果写入交付说明；未验证的 Provider 不上线联网取数。
2. 每个 Provider 有独立授权开关，**默认关**；开启前界面说明将向哪个地址发出什么请求。
3. 未授权时该 Provider 零网络请求（测试断言）；撤销授权后立即停止请求。
4. 请求有超时上限，失败显示原因与 Unknown，不自动高频重试。
5. 凭据的值不出现在日志、错误信息与界面中（测试断言）。
6. 同步修改 `README.md`、`README.en.md` 能力表与 `docs/privacy-policy.md`：删除「不生成价格估算」，新增「用户授权后以其本地凭据向 Provider 请求」。

**Verification（M8 各段）**：检查命令全绿；M8c 父级核对 probe 记录与网络断言。

### M9 — 首次向导教程（第一版）

**Scope**：教程并入已有首次向导，另可从「系统 → 重看教程与向导」打开；本地 HTML 随安装包分发，用应用自己的窗口打开，CSS 示意动画。

**Acceptance Criteria**
1. 全新配置（`setupWizardCompleted: false`）下，向导包含四个主题：岛怎么用、看板在显示什么、点任务会发生什么、Agent 接入。
2. 「重看教程」打开的是**应用内窗口**，加载随包分发的本地文件，不调用外部浏览器。
3. 教程文件中不含任何 `http://` / `https://` 资源引用、外部脚本或字体（grep 断言），断网可用。
4. 完整版另含 Skill 与使用额度两节。
5. 提供中文与英文，其余语言回落英文。

**Verification**：检查命令全绿；**维护者目视评审**（第一版，预期会迭代）。M8 完成后更新完整版中的使用额度一节。

**状态（2026-09-22）：自动化部分 PASS，待维护者目视。已合入。**
教程为 `public/tutorial/index.html`（构建后在 `dist/tutorial/`，单文件、内联 CSS 动画与 SVG、无任何外部资源），由新命令
`open_tutorial_window` 用应用窗口打开；首次向导新增「教程」步骤覆盖四个主题；「系统 → 重看教程与向导」可打开完整版（另含 Skill、
使用额度与派发框架简介）。
父级独立验证：前端 45 文件 423 项全过，lint / build / fmt / check 通过；`cargo test --lib` 555 通过 / 23 失败，失败集合 = 已知名单子集。
父级逐句读过中文教程文本（91 段），与当前代码行为一致、未提及已删除功能；抽查 Ctrl/Cmd+J 跳终端、Esc 30 秒静默确有其实现。

**风险记录**：①真机窗口未打开验证。②教程描述的「启用用量查询」总开关默认开启，属现状；M8c 改为逐 Provider 授权后需同步改教程这一段。
③教程窗口未加入 capabilities（页面不调用 IPC），属刻意收窄。

---

## 8. Known Trade-offs

- **推翻 PRD 两处**：保留 Skill 管理（PRD 5.3 非目标）；删除审批操作（PRD 8.5 MVP）。均为维护者确认。
- **删除审批 = 放弃「知道谁在等权限」**：PRD 第 23 行这条不再实现，因为现有检测会误报。
- **技能包数据不删表**：保留回退余地，代价是库中留有无用表。
- **价格表内置不下载**：避免默认联网，代价是新模型价格要等发版才更新。
- **桌面版 Agent 可能不触发 Hook**：会话拉起开关对其可能无效，只能在向导中说明。
- **M3–M6 串行**：共享命令注册表与五语言文件，并行会反复冲突。

---

## Revision Log

| Date | Change | Why |
| --- | --- | --- |
| 2026-09-21 | 建立 | 维护者确认范围后拆分里程碑与验收标准 |
| 2026-09-22 | 界面语言收窄为中文、英文；此后各里程碑的「五语言」一律按「中英两份」执行 | 维护者决定，M6 之后单独提交 |
