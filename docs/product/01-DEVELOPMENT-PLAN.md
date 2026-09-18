# Agent Control Tower — 开发规划与实施路线

> 对应 PRD：`00-PRD.md`  
> 开发策略：基于现有成熟能力做裁剪和扩展，不从零重写桌面 Agent Monitor。  
> 第一目标平台：Windows x64。

---

# 1. 总体开发策略

建议采用：

```text
AgentBro
  +
Usage Collector
  +
自研 Trace Layer
```

而不是从零开发。

复用目标：

```text
AgentBro
├── Tauri Desktop Shell
├── Windows Always-on-top
├── System Tray
├── Hook Transport
├── Session Observation
├── Agent Adapters
├── Notifications
└── Existing Island

Usage Dashboard / existing collectors
├── Codex session parser
├── Codex quota reader
├── Claude usage reader
├── Gemini usage reader
└── Cost calculation ideas

自研
├── Task Model
├── Agent Run Model
├── Trace ID
├── agentctl
├── Task Tree
├── Unified Usage API
└── Product-specific UI
```

核心原则：

> **复用底层采集能力，重做产品层，不把两个桌面应用直接拼接。**

---

# 2. 技术架构

推荐：

```text
┌────────────────────────────────────────────┐
│                Tauri Desktop               │
│                                            │
│  React UI                                  │
│  ├── Island                                │
│  ├── Tasks                                 │
│  ├── Usage                                 │
│  └── Settings                              │
│                                            │
│  Zustand / Frontend Store                  │
└───────────────────┬────────────────────────┘
                    │ Tauri IPC
                    ▼
┌────────────────────────────────────────────┐
│                Rust Core                   │
│                                            │
│  Event Bus                                 │
│  Agent Runtime                             │
│  Trace Runtime                             │
│  Usage Runtime                             │
│  Notification                              │
│  SQLite                                    │
└──────────────┬──────────────┬──────────────┘
               │              │
               ▼              ▼
        Agent Adapters    Usage Adapters
        ├ Codex           ├ Codex
        ├ Claude          ├ Claude
        ├ Gemini          ├ Gemini
        └ Pi              └ API Billing
               │
               ▼
           agentctl
               │
               ▼
         Child Processes
```

---

# 3. 初期项目结构建议

如果直接 fork AgentBro：

```text
control-tower/
│
├── src/
│   ├── app/
│   ├── components/
│   │   ├── island/
│   │   ├── tasks/
│   │   ├── usage/
│   │   └── settings/
│   │
│   ├── stores/
│   │   ├── taskStore.ts
│   │   ├── agentStore.ts
│   │   └── usageStore.ts
│   │
│   ├── services/
│   │   ├── taskService.ts
│   │   └── usageService.ts
│   │
│   └── types/
│       ├── task.ts
│       ├── agent.ts
│       └── usage.ts
│
├── src-tauri/
│   └── src/
│       ├── agents/
│       ├── trace/
│       ├── usage/
│       ├── storage/
│       └── notifications/
│
├── tools/
│   └── agentctl/
│
├── docs/
│   ├── 00-PRD.md
│   ├── 01-DEVELOPMENT-PLAN.md
│   └── architecture/
│
└── tests/
```

不强制一开始就按这个结构重构。

第一原则：

> 先理解原项目结构，再决定迁移位置。

---

# 4. 开发阶段总览

原 Phase 0–11 保留为执行子阶段，归并为以下五个开发里程碑：

```text
Milestone 1  Baseline & Product Slimming
  Phase 0   Baseline
  Phase 1   Product Slimming

Milestone 2  Codex Observability & Trace
  Phase 2   Codex Observability
  Phase 3   Codex Quota / Usage
  Phase 4   Trace Layer

Milestone 3  Agent Orchestration
  Phase 5   agentctl
  Phase 6   Child Native Hook

Milestone 4  Unified Task Experience
  Phase 7   Unified Task UI
  Phase 8   Usage Dashboard
  Phase 9   Notifications

Milestone 5  Multi-provider & Release
  Phase 10  Multi-provider Usage
  Phase 11  Windows Release
```

---

# 5. Phase 0 — 建立 Baseline

## 目标

确认原项目在当前 Windows 开发环境真实可运行。

## 任务

1. Fork / Clone AgentBro；
2. 阅读：
   - README；
   - AGENTS.md；
   - package.json；
   - src；
   - src-tauri；
3. 安装依赖；
4. 运行开发环境；
5. 确认 Island；
6. 确认 Codex Integration；
7. 确认 Hook Doctor；
8. 创建 baseline commit。

## 必须输出

```text
docs/architecture/original-agentbro.md
```

内容：

- 当前技术栈；
- 前端状态管理；
- Tauri commands；
- Hook server；
- Agent adapter；
- Codex 数据流；
- Windows-specific code。

## 验收

- [ ] Windows app 启动；
- [ ] Island 出现；
- [ ] Codex session 能观察；
- [ ] Codex 完成事件出现；
- [ ] build 可通过。

## 禁止

- 不重构；
- 不删除模块；
- 不改 UI；
- 不添加新功能。

---

# 6. Phase 1 — Product Slimming

## 目标

把 AgentBro 从“全功能 Agent 工具箱”变成 Control Tower Shell。

## 隐藏

先只隐藏，不物理删除：

```text
Pet
Pet Market
Skills
Skill Packs
MCP
Plugins
Agent installation
Agent update
Provider Switch
SSH Remote
```

## 保留

```text
Island
Agent Monitor core
Hook
Notifications
Settings
Diagnostics
```

## 新导航

```text
Tasks
Usage
Settings
```

Usage 此阶段为空页面。

## 验收

- [ ] 原 Codex Monitor 不受影响；
- [ ] 原 Hook 不受影响；
- [ ] 新导航正常；
- [ ] 非需求功能 UI 不可见；
- [ ] build / tests 通过。

---

# 7. Phase 2 — Codex Observability

## 目标

先把 Codex 做成第一个完整 Agent Adapter。

## 建立统一 Agent Event

```ts
type AgentEvent =
  | SessionStarted
  | StatusChanged
  | ToolStarted
  | ToolFinished
  | WaitingInput
  | PermissionRequested
  | RateLimited
  | Error
  | Completed
  | UsageUpdated;
```

## 建立统一 Agent State

```ts
interface AgentRunState {
  agent: string;
  sessionId?: string;

  status:
    | "idle"
    | "starting"
    | "running"
    | "waiting_input"
    | "waiting_permission"
    | "blocked"
    | "rate_limited"
    | "error"
    | "completed"
    | "cancelled"
    | "unknown";

  phase?: string;
  currentAction?: string;

  startedAt?: string;
  updatedAt: string;
}
```

## Island

仅显示 Codex：

```text
Codex
Running
Running tests
```

## 验收

- [ ] session start；
- [ ] running；
- [ ] tool activity；
- [ ] waiting；
- [ ] error；
- [ ] completed；

全部能被统一模型表达。

---

# 8. Phase 3 — Codex Quota / Usage

## 目标

先只接 Codex。

不要同时开发所有 Provider。

## 第一步：独立验证 Collector

先独立验证：

```text
Codex session logs
Codex app-server / local rate limit source
```

确保能读到真实数据。

## 第二步：建立 Usage Adapter

```ts
interface UsageProvider {
  providerId: string;

  getQuota(): Promise<QuotaSnapshot>;
  getUsage(range: TimeRange): Promise<UsageRecord[]>;
  getCost?(range: TimeRange): Promise<CostRecord[]>;
}
```

## Codex Adapter

```text
CodexUsageProvider
├── SessionLogReader
├── RateLimitReader
└── TokenAggregator
```

## Island

增加：

```text
Codex 72%
```

## Usage 页面

第一版只显示：

```text
Codex

Quota
Tokens Today
Tokens 7d
Tokens 30d
```

## 验收

- [ ] quota 可读；
- [ ] reset time；
- [ ] token；
- [ ] freshness；
- [ ] source；
- [ ] failure state；
- [ ] unknown 不伪造数据。

---

# 9. Phase 4 — Trace Layer

这是项目最关键的新能力。

## 目标

建立：

```text
Codex
→ Child Agent
```

的可追溯关系。

## 新增模型

```text
Task
AgentRun
Trace
```

## Trace

```ts
interface AgentTrace {
  traceId: string;
  taskId: string;
  parentRunId?: string;
  runId: string;

  agent: string;
  role?: string;
  dispatchedTask?: string;
}
```

## 数据库

先建立：

```text
tasks
agent_runs
agent_events
```

## 验收

可以手动创建：

```text
Task
└── Codex
    └── Dummy Child
```

并在 Tasks 页面正确显示。

这一阶段可以暂时不用真实调用 Claude。

---

# 10. Phase 5 — agentctl

## 目标

任何由 Codex 派发的 Child Agent，经过统一入口启动。

## CLI

```bash
agentctl dispatch \
  --agent claude \
  --role backend \
  --task "Implement auth middleware"
```

## agentctl 工作

```text
1. 获取当前 Task
2. 获取 Codex parent run
3. 创建 Child Run
4. 写 trace_id
5. 写环境变量
6. 启动 Agent
7. 捕获 PID
8. 捕获 process exit
9. 汇报状态
```

## 环境变量

```text
AGENT_TRACE_ID
AGENT_TASK_ID
AGENT_PARENT_RUN_ID
AGENT_ROLE
AGENT_PROJECT
```

## 第一版

只支持一个 Child Agent。

推荐：

```text
Claude Code
```

或用户最常使用的另一个 Agent。

## 验收

运行：

```text
Codex
→ agentctl dispatch
→ Claude
```

Dashboard 必须显示：

```text
Codex
└── Claude
```

并能看到：

```text
starting
running
completed / error
```

---

# 11. Phase 6 — Child Native Hook

## 目标

Launcher 只能知道：

```text
Process Running
```

Native Hook 才能知道：

```text
Running pytest
Editing auth.ts
Waiting permission
```

因此二者需要合并。

## 状态合并

```text
Launcher
        \
         → Unified Run State
        /
Native Hook
```

优先级：

```text
blocking
>
error
>
native state
>
process state
>
launcher state
```

## 验收

Claude：

```text
Process = running
Hook = waiting_permission
```

最终：

```text
waiting_permission
```

---

# 12. Phase 7 — Unified Task UI

## Tasks 首页

```text
Active
Completed
Failed
```

每个 Task 卡片：

```text
Title
Project
Root Agent
Child Agent Count
Blocking Count
Duration
Usage
```

## Task Detail

```text
Task Tree
Timeline
Agent Runs
Usage
Errors
```

## Task Tree

```text
Codex
├── Claude
├── Gemini
└── Pi
```

## Timeline

```text
14:21 Codex started
14:23 Claude dispatched
14:24 Gemini dispatched
14:28 Gemini completed
14:30 Claude waiting permission
```

## 验收

一个 Task 包含至少：

```text
1 root
2 children
```

且完整渲染。

---

# 13. Phase 8 — Usage Dashboard

## 数据库新增

```text
quota_snapshots
usage_records
cost_records
```

## 页面

```text
Usage

├── Overview
├── Quota
├── Token Trend
├── Cost
└── Breakdown
```

## Overview

```text
Tokens Today
Actual API Cost
Equivalent API Cost
Active Providers
```

## Breakdown

```text
By Agent
By Provider
By Model
By Project
By Task
```

## Cost

一定区分：

```text
Actual API Cost
Equivalent API Cost
```

## 验收

- [ ] Today；
- [ ] 7d；
- [ ] 30d；
- [ ] Provider；
- [ ] Task；
- [ ] Project。

---

# 14. Phase 9 — Notifications

## P0

Windows Toast：

```text
Claude waiting for permission
Pi failed
Gemini completed
Task completed
```

## Rate Limit

后续：

```text
Codex usage > 80%
Codex rate limited
Quota reset
```

## 去重

防止同一 blocking event 无限通知。

建议：

```text
event fingerprint
cooldown
acknowledged
```

---

# 15. Phase 10 — Multi-provider Usage

按以下顺序增加：

```text
1. Claude
2. Gemini
3. Pi
4. OpenCode
5. Other
```

每新增 Provider 都必须单独验收：

```text
usage
quota
source
freshness
error handling
```

不要写一个“万能 parser”。

---

# 16. Phase 11 — Windows Release

## 检查

- System Tray；
- Always on top；
- multi-monitor；
- DPI；
- launch on startup；
- notification；
- minimize to tray；
- app restart；
- log location；
- database migration。

## 构建

最终：

```text
NSIS EXE
MSI
```

## Release

```text
v0.1.0
```

---

# 17. 开发顺序中的关键原则

## 原则 1

先单 Agent，后多 Agent。

## 原则 2

先 Codex，后 Claude。

## 原则 3

先状态，再 Usage。

## 原则 4

先 Usage，再 Cost。

## 原则 5

先 Launcher Trace，再 Native Hook 关联。

## 原则 6

先隐藏旧功能，再删代码。

## 原则 7

每个阶段必须可运行。

---

# 18. Git 策略

主分支：

```text
main
```

Feature branches：

```text
feat/slim-shell
feat/codex-observability
feat/codex-usage
feat/task-model
feat/agentctl
feat/claude-trace
feat/task-tree
feat/usage-dashboard
feat/windows-notifications
feat/windows-release
```

## Commit 原则

一个 commit 只解决一个逻辑问题。

示例：

```text
feat(tasks): add task and agent run domain models
feat(trace): add parent-child run relationship
feat(codex): normalize session status events
feat(usage): add codex quota adapter
fix(windows): persist island position across monitors
```

禁止：

```text
update everything
final changes
fix bugs
```

---

# 19. 每阶段 Codex 工作方式

不要告诉 Codex：

> 把整个项目完成。

应该：

```text
Phase N
→ 阅读相关代码
→ 给出修改计划
→ 修改
→ lint/test/build
→ git diff
→ 用户验收
→ commit
```

每阶段输入包含：

```text
Goal
Scope
Non-goals
Files likely involved
Acceptance criteria
Required tests
```

---

# 20. 每阶段质量检查

前端：

```bash
pnpm lint
pnpm test:run
pnpm build
```

Rust：

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

Windows release 阶段：

```bash
pnpm tauri:build:windows
```

如果实际仓库脚本名称不同，以 package.json 为准。

---

# 21. 数据库 Migration

从第一张表开始就必须使用 migration。

不要：

```text
启动时 CREATE TABLE IF NOT EXISTS 然后无限 patch
```

建议：

```text
migrations/
001_tasks.sql
002_agent_runs.sql
003_agent_events.sql
004_usage.sql
005_cost.sql
```

---

# 22. Adapter 设计

## AgentAdapter

```ts
interface AgentAdapter {
  id: string;

  detect(): Promise<boolean>;
  observe(): AsyncIterable<AgentEvent>;
}
```

## UsageProvider

```ts
interface UsageProvider {
  id: string;

  getQuota(): Promise<QuotaSnapshot>;
  getUsage(range: TimeRange): Promise<UsageRecord[]>;
}
```

二者不要混合。

原因：

```text
Agent Runtime State
≠
Provider Usage
```

Claude Agent 可以由 Anthropic 账号运行，也可能通过不同 Provider。

---

# 23. Event Bus

内部统一事件：

```text
AgentEvent
TraceEvent
UsageEvent
SystemEvent
```

例如：

```text
agent.session.started
agent.status.changed
agent.permission.requested
agent.completed

trace.child.dispatched
trace.child.started
trace.child.exited

usage.quota.updated
usage.tokens.updated

system.integration.error
```

好处：

Island、Tasks、Notifications 不直接依赖某个 Agent parser。

---

# 24. Logging

日志分级：

```text
ERROR
WARN
INFO
DEBUG
TRACE
```

默认不要记录：

- full prompt；
- code content；
- API key；
- full hook payload。

Diagnostics 模式才允许更多信息。

---

# 25. 测试策略

## Unit

重点：

```text
status merge
quota normalization
token aggregation
cost calculation
trace relationship
```

## Integration

```text
fake Codex events
fake Claude events
agentctl process
SQLite
```

## Manual Windows

```text
Codex normal
Codex permission
Codex error
Child agent exit
Provider unavailable
Multi-monitor
Sleep / wake
Restart
```

---

# 26. 第一批应实现的数据类型

优先定义：

```text
Task
AgentRun
AgentEvent
QuotaSnapshot
UsageRecord
CostRecord
```

不要让 UI 自己拼临时对象。

---

# 27. 第一版 UI 组件

```text
IslandCompact
IslandExpanded
AgentRunRow
TaskCard
TaskTree
QuotaCard
UsageSummary
UsageChart
BlockingBadge
ProviderStatus
```

不要过早创建复杂 Design System。

---

# 28. 第一版状态颜色语义

建议由现有主题系统决定具体颜色，不在业务代码硬编码。

语义：

```text
running
success
warning
danger
muted
```

---

# 29. 风险清单

## Risk 1 — Windows AgentBro 不够成熟

处理：

先验证 baseline，再开发。

## Risk 2 — Agent Hook 协议变化

处理：

Adapter 隔离。

## Risk 3 — Provider quota 不是公开稳定 API

处理：

source + freshness + graceful degradation。

## Risk 4 — 多 Agent 关联失败

处理：

agentctl 作为唯一可靠 trace source。

## Risk 5 — Token Cost 误导

处理：

Actual / Equivalent 分离。

## Risk 6 — 项目被改成“大而全”

处理：

严格遵守 PRD Non-goals。

---

# 30. MVP 最短路径

如果只追求最快获得可用版本：

```text
Week / Stage 1
AgentBro Windows baseline
        ↓
Slim UI
        ↓
Codex status

Stage 2
Codex quota
        ↓
Usage page

Stage 3
Task model
        ↓
agentctl
        ↓
Codex → Claude

Stage 4
Task tree
        ↓
Notifications
        ↓
Windows build
```

MVP 不需要：

```text
Gemini
Pi
OpenCode
API Billing
charts
export
SSH
```

---

# 31. 推荐开发里程碑

## M0 — Baseline

原版 Windows 可跑。

## M1 — Control Tower Shell

只剩 Tasks / Usage / Settings。

## M2 — Codex Monitor

完整观察 Codex。

## M3 — Codex Usage

Quota + Token。

## M4 — First Child Agent

Codex → agentctl → Claude。

## M5 — Task Tree

Task-first UI 完成。

## M6 — Windows MVP

通知 + installer。

## M7 — Multi-Agent

Gemini / Pi / OpenCode。

## M8 — Cost Intelligence

真实 API cost + equivalent cost。

---

# 32. Definition of Done

任何 Feature 要进入 main：

- [ ] 功能实现；
- [ ] 不破坏现有 Agent execution；
- [ ] error state 有处理；
- [ ] unknown state 有处理；
- [ ] lint；
- [ ] tests；
- [ ] build；
- [ ] Rust check；
- [ ] Windows 手动验证；
- [ ] 文档更新；
- [ ] git diff reviewed。

---

# 33. 第一次给 Codex 的任务

项目建立后，不要让 Codex 直接开发。

第一条任务应该是：

```text
阅读当前仓库，不做功能修改。

目标：
1. 确认 Windows 下项目能够启动；
2. 梳理 Codex session 从 Hook 输入到 Island UI 的完整数据流；
3. 找出 Agent Monitor、Island、Hook、Notification、Agent Adapter 的边界；
4. 找出适合新增 Task / Trace / Usage 的扩展点；
5. 输出 docs/architecture/baseline.md；
6. 运行现有 lint/test/build；
7. 不删除、不重构、不格式化无关代码。

完成后停止，等待验收。
```

---

# 34. 第二次给 Codex 的任务

Baseline 验收后：

```text
执行 Product Slimming。

目标：
- 产品暂命名 Control Tower；
- 主导航改为 Tasks / Usage / Settings；
- Usage 暂为空；
- 隐藏 Pet / Skills / MCP / Plugin / Agent Management /
  Provider Switch / SSH Remote；
- 不物理删除代码；
- 保留 Island / Hook / Codex Monitor / Notifications /
  Integration / Diagnostics；
- 不修改 Agent Hook 协议；
- 所有现有测试保持通过。

完成后：
1. 输出修改文件列表；
2. 输出 git diff 摘要；
3. 输出被隐藏模块清单；
4. 停止等待验收。
```

---

# 35. 第三个任务才进入功能开发

```text
建立统一 Codex Agent State Model。

只处理 Codex。
不处理 Claude/Gemini/Pi。
不处理 Usage。

要求：
- session start
- running
- tool activity
- waiting
- permission
- error
- completed

统一映射到 AgentRunState。

Island 使用统一状态，不直接消费 Codex-specific payload。
```

---

# 36. 最终推荐节奏

整个项目始终遵循：

```text
Research
   ↓
Small change
   ↓
Run
   ↓
Test
   ↓
Inspect
   ↓
Commit
   ↓
Next phase
```

不要采用：

```text
给 AI 一份 PRD
   ↓
让 AI 连续改两小时
   ↓
祈祷项目能跑
```

这个项目真正复杂的部分不是写 UI，而是处理：

```text
多个 Agent
+
多个 Hook
+
多个 Usage Source
+
多个不稳定接口
+
Windows Desktop Runtime
```

所以开发策略必须以 **可观察、可回滚、可阶段验收** 为核心。
