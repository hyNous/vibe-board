# Agent Control Tower — 产品需求文档（PRD）

> 版本：v0.1  
> 平台优先级：Windows x64 First  
> 产品形态：桌面常驻状态栏 / 悬浮岛 + 后台 Dashboard  
> 核心使用场景：Codex 作为主 Agent / Orchestrator，派发任务给 Claude Code、Gemini CLI、Pi、OpenCode 等 Agent，并统一观察任务状态、额度、Token 使用和费用。

---

## 1. 产品背景

在多 Agent Coding 工作流中，Codex 可以作为主控 Agent，根据任务类型把子任务派发给其他 Agent，例如：

- Claude Code：负责后端实现、复杂代码修改、测试；
- Gemini CLI：负责资料检索、长上下文分析；
- Pi：负责轻量执行、代码检查或特定工具链任务；
- OpenCode / 其他 Agent：作为补充执行节点。

问题在于，这些 Agent 通常运行在不同终端、不同客户端、不同 Session 中。用户需要频繁切换窗口才能判断：

1. 哪些 Agent 正在运行；
2. 哪些 Agent 已完成；
3. 哪些 Agent 正在等待权限或用户输入；
4. 某个子 Agent 属于哪个 Codex 主任务；
5. 当前各模型 / 账号还剩多少额度；
6. 今天、近 7 天、近 30 天用了多少 Token；
7. API 实际产生多少费用；
8. 订阅型模型如果按 API 价格估算，相当于消耗了多少价值。

现有状态栏项目通常只解决“Agent 是否在运行”，而现有 Usage Dashboard 通常只解决“用了多少 Token / 额度”。本产品目标是把二者整合，并额外加入 **Codex → Child Agent 的任务追踪关系**。

---

# 2. 产品定位

Agent Control Tower 是一个面向本地 AI Coding Agent 工作流的：

> **多 Agent 任务观测 + 配额观测 + 成本分析桌面控制台**

它不是：

- 新的 Coding Agent；
- Agent 聊天客户端；
- Agent 配置中心；
- MCP / Skill / Plugin 管理中心；
- API Provider 切换器；
- IDE 替代品；
- 完整项目管理工具。

它只解决一件事：

> **让我在不切换多个窗口的情况下，知道 Codex 正在调度谁、每个 Agent 现在做到哪里、哪里卡住、还剩多少额度，以及整个开发过程消耗了多少资源。**

---

# 3. 核心用户

## 3.1 首要用户

使用 Codex / Claude Code / Gemini CLI / Pi 等多种 Coding Agent，并采用以下工作流的个人开发者：

```text
User
  │
  ▼
Codex
  │
  ├── Claude Code
  ├── Gemini CLI
  ├── Pi
  ├── OpenCode
  └── Other Agents
```

其中 Codex 是“大脑 / 调度器”，其他 Agent 是“执行节点”。

## 3.2 非目标用户

第一阶段不重点支持：

- 企业级多人协作团队；
- 云端集中部署；
- 多租户；
- SaaS 计费；
- 手机端；
- macOS 优先体验；
- Linux Desktop 优先体验。

---

# 4. 核心问题

## P0：多 Agent 状态分散

用户必须不断切换终端、IDE、Agent 客户端判断任务状态。

## P0：缺少主从任务关系

普通 Agent Monitor 只能看到多个 Session：

```text
Codex Session A
Claude Session B
Gemini Session C
Pi Session D
```

但无法直接知道：

```text
Codex A
├── Claude B
├── Gemini C
└── Pi D
```

## P0：任务阻塞不能及时发现

Agent 可能因为：

- permission；
- user input；
- plan approval；
- rate limit；
- error；
- process crash；

停在那里，但用户不知道。

## P1：额度信息分散

Codex、Claude、Gemini 等额度窗口不同、重置周期不同、获取方式不同。

## P1：Token 和费用缺少统一视图

用户难以回答：

- 今天哪个 Agent 用得最多；
- 哪个项目最消耗额度；
- 哪个 Agent 的 API 成本最高；
- 某段时间内总消耗趋势如何。

---

# 5. 产品目标

## 5.1 MVP 目标

MVP 必须做到：

1. Windows 后台常驻；
2. 可观察 Codex 当前 Session 状态；
3. 可观察至少一个子 Agent；
4. 能建立 Codex → Child Agent 的任务关系；
5. 状态栏可显示：
   - 主任务；
   - 当前运行 Agent 数量；
   - running / waiting / blocked / done；
   - Codex quota；
6. Agent 卡住、失败、完成时通知；
7. 后台可以查看：
   - Task；
   - Agent；
   - Token；
   - Quota；
   - Usage History；
8. 数据缺失时明确显示 Unknown / Unsupported，而不是估算伪数据。

## 5.2 V1 目标

加入：

- Claude quota；
- Gemini usage；
- 多 Agent usage；
- API 真实费用；
- Equivalent API Cost；
- 项目维度统计；
- Task Tree；
- Timeline；
- 搜索和筛选。

## 5.3 非目标

第一版明确不做：

- MCP Server 管理；
- Skills 管理；
- Plugin 管理；
- Agent 安装 / 升级；
- Provider 切换；
- SSH Agent 管理；
- Pet / 桌宠系统；
- Agent 完整聊天；
- IDE 内代码编辑；
- 云同步；
- 多人协作；
- Web SaaS。

---

# 6. 产品原则

## 6.1 以 Task 为中心，而不是以 Session 为中心

错误：

```text
Active Sessions
- Codex #12
- Claude #43
- Gemini #08
```

正确：

```text
Task: Refactor Login

Codex
├── Claude — Backend
├── Gemini — Research
└── Pi — Review
```

## 6.2 状态优先于日志

状态栏首先回答：

> 现在发生什么？

而不是：

> 过去输出了什么？

## 6.3 阻塞优先级最高

状态优先级：

```text
blocked / waiting
>
error
>
running
>
completed
>
idle
```

## 6.4 不制造假“进度百分比”

Agent 通常无法准确知道任务完成百分比。

因此产品不展示：

```text
Claude 73%
```

除非该任务本身存在明确可量化步骤。

默认展示阶段状态：

```text
Reading
Editing
Testing
Waiting
Reviewing
Completed
```

## 6.5 Usage 数据必须标注来源

例如：

```text
Codex quota
Source: local app-server
Freshness: 14s ago
```

而不是把推测值伪装成官方数据。

## 6.6 Windows First

所有 MVP 决策优先考虑：

- Windows x64；
- WebView2；
- Tauri；
- System Tray；
- Always-on-top；
- Windows Notification；
- PowerShell / CMD / Windows Path。

---

# 7. 产品信息架构

```text
Agent Control Tower

├── Island
│   ├── Active Task
│   ├── Agent State
│   ├── Blocking Alert
│   ├── Quota
│   └── Quick Action
│
├── Tasks
│   ├── Active Tasks
│   ├── Task Tree
│   ├── Agent Timeline
│   ├── Session History
│   └── Tool Activity
│
├── Usage
│   ├── Quota
│   ├── Token
│   ├── API Cost
│   ├── Equivalent API Cost
│   ├── Agent Breakdown
│   ├── Project Breakdown
│   └── History
│
└── Settings
    ├── Integrations
    ├── Notifications
    ├── Usage Sources
    ├── Appearance
    └── Diagnostics
```

---

# 8. Island / 状态栏需求

## 8.1 收起状态

示例：

```text
┌─────────────────────────────────────────────┐
│ ● Codex   3 running   GPT 72%   Claude 43% │
└─────────────────────────────────────────────┘
```

至少显示：

- 主控 Agent；
- 当前活跃子 Agent 数；
- 阻塞数量；
- Codex quota；
- 可选第二 Provider quota。

## 8.2 展开状态

示例：

```text
┌─────────────────────────────────────────────┐
│ Refactor Login                             │
│                                            │
│ ● Codex       Reviewing                    │
│ ├ ● Claude    Running tests        04:18   │
│ ├ ✓ Gemini    Research done        02:31   │
│ └ ! Pi        Waiting permission   01:42   │
│                                            │
│ Codex  ███████░░ 72%  reset 2h31m         │
│ Claude ████░░░░░ 43%  reset 1h18m         │
└─────────────────────────────────────────────┘
```

## 8.3 状态类型

统一状态：

```text
idle
starting
running
waiting_input
waiting_permission
blocked
rate_limited
error
completed
cancelled
unknown
```

## 8.4 Agent 当前阶段

可选：

```text
reasoning
reading
searching
editing
running_command
testing
reviewing
waiting
```

## 8.5 快速操作

MVP：

- Open Session；
- Open Task；
- Allow；
- Deny。

V1 可增加：

- Retry；
- Cancel；
- Send short reply。

第一版不在 Island 内做完整聊天。

---

# 9. Task / Orchestration 需求

## 9.1 Task

Task 是产品核心一级对象。

示例：

```text
task_id
title
project
root_agent
status
created_at
completed_at
```

## 9.2 Agent Run

一个 Task 可以有多个 Agent Run。

```text
Task
├── Codex Run
├── Claude Run
├── Gemini Run
└── Pi Run
```

## 9.3 父子关系

每个 Child Agent 必须尽可能记录：

```text
parent_run_id
root_task_id
role
dispatch_reason
```

例如：

```text
Codex
└── Claude
    role = backend
    task = implement auth middleware
```

## 9.4 Trace ID

Codex 派任务时生成：

```text
trace_id
task_id
parent_run_id
child_run_id
```

推荐通过统一 launcher：

```text
agentctl dispatch
```

调用子 Agent。

## 9.5 Task Tree

Dashboard 示例：

```text
Refactor Login

Codex
│
├── Claude
│   ├── Read backend
│   ├── Modify auth.ts
│   └── Running pytest
│
├── Gemini
│   └── OAuth docs research ✓
│
└── Pi
    └── Waiting permission
```

---

# 10. 通知需求

触发通知：

## P0

- Agent waiting permission；
- Agent waiting user input；
- Agent error；
- Agent completed；
- Root task completed。

## P1

- Rate limit approaching；
- Rate limited；
- quota reset；
- Agent execution > configured duration；
- Child process unexpected exit。

通知应支持：

```text
Enabled
Quiet Hours
Sound
Windows Toast
```

---

# 11. Usage / Quota 产品需求

## 11.1 Quota

统一展示：

```text
Provider
Window
Used %
Remaining %
Reset At
Source
Freshness
Status
```

示例：

```text
Codex

5 Hour
███████░░░ 72%
Reset 18:31

Weekly
█████░░░░░ 51%
Reset Sep 2
```

## 11.2 Quota 状态

```text
available
stale
unsupported
unavailable
error
```

禁止在未知情况下生成一个估算百分比。

## 11.3 Token

记录：

```text
input_tokens
cached_input_tokens
output_tokens
reasoning_tokens
total_tokens
```

如果某 Provider 不支持某字段：

```text
null
```

而不是 0。

## 11.4 Cost 类型

必须区分：

### Actual API Cost

来自官方 API / Billing / Admin Usage 数据。

```text
Actual API Cost
$8.21
```

### Equivalent API Cost

订阅型 Agent 根据公开 API 单价估算：

```text
Equivalent API Cost
≈ $16.42
```

必须带：

```text
Estimated
```

标识。

## 11.5 Usage 分析

Dashboard：

```text
Today
7 Days
30 Days
Custom
```

维度：

```text
By Agent
By Provider
By Model
By Project
By Task
```

---

# 12. Usage 数据来源抽象

所有数据必须统一进入 Provider Adapter。

接口概念：

```ts
interface UsageProvider {
  providerId: string;

  getQuota(): Promise<QuotaSnapshot>;
  getUsage(range: TimeRange): Promise<UsageRecord[]>;
  getCost?(range: TimeRange): Promise<CostRecord[]>;
}
```

Quota：

```ts
interface QuotaSnapshot {
  provider: string;

  windows: {
    name: string;
    usedPercent?: number;
    remainingPercent?: number;
    resetAt?: string;
  }[];

  source:
    | "official-api"
    | "local-app-server"
    | "statusline"
    | "session-log"
    | "telemetry"
    | "estimate";

  fetchedAt: string;

  status:
    | "available"
    | "stale"
    | "unsupported"
    | "unavailable"
    | "error";
}
```

---

# 13. Dashboard 需求

## 13.1 Tasks 页面

显示：

- 当前 Task；
- Root Codex Session；
- 子 Agent；
- 状态；
- duration；
- 当前 action；
- blocking reason；
- start / finish。

## 13.2 Task Detail

显示：

```text
Task Tree
Timeline
Agent Runs
Tool Events
Usage
Errors
```

## 13.3 Usage 页面

顶部：

```text
Total Tokens
Actual API Cost
Equivalent API Cost
Active Providers
```

下面：

```text
Quota Cards
Usage Trend
Agent Breakdown
Project Breakdown
Recent Usage
```

## 13.4 Settings

包括：

- Agent Integrations；
- Usage Source；
- Notification；
- Island；
- Data Retention；
- Diagnostics。

---

# 14. 数据模型

建议 SQLite。

## tasks

```text
id
title
project_id
root_run_id
status
created_at
updated_at
completed_at
```

## agent_runs

```text
id
task_id
parent_run_id
trace_id

agent
provider
model
role

session_id
pid

status
phase
current_action

started_at
updated_at
completed_at
exit_code
error
```

## agent_events

```text
id
run_id
event_type
tool_name
summary
raw_payload
created_at
```

## quota_snapshots

```text
id
provider
window_name
used_percent
remaining_percent
reset_at
source
status
fetched_at
```

## usage_records

```text
id
run_id
task_id
provider
model

input_tokens
cached_input_tokens
output_tokens
reasoning_tokens
total_tokens

source
recorded_at
```

## cost_records

```text
id
provider
model
task_id

cost_type
amount
currency

pricing_version
source
recorded_at
```

---

# 15. 数据保留

默认：

```text
Raw hook events       7 days
Agent events          30 days
Task history          unlimited
Usage aggregates      unlimited
Quota snapshots       90 days
```

用户可以修改。

---

# 16. 隐私与安全

本产品默认：

- 所有数据本地存储；
- 不上传 Prompt；
- 不上传代码；
- 不上传 Session；
- API Key 使用系统安全存储；
- Dashboard 本地运行；
- Raw payload 默认不长期保存。

如果使用 Admin API Key：

- 只请求 usage / billing 必需权限；
- 不把 key 写入普通配置 JSON；
- 不写日志；
- UI 默认遮罩。

---

# 17. Agent Integration 需求

优先级：

## P0

- Codex

## P1

- Claude Code

## P2

- Gemini CLI
- Pi

## P3

- OpenCode
- Kimi
- Hermes
- other Agent adapters

每个 Agent Adapter 输出统一事件：

```text
session_started
status_changed
tool_started
tool_finished
waiting
permission_requested
error
completed
usage_updated
```

---

# 18. Agent Launcher

为了可靠建立父子关系，新增：

```text
agentctl
```

命令示例：

```bash
agentctl dispatch \
  --agent claude \
  --role backend \
  --task "Implement auth middleware"
```

Agent Launcher 负责：

1. 创建 child run；
2. 继承 root task；
3. 写入 trace_id；
4. 启动进程；
5. 记录 PID；
6. 记录 exit code；
7. 将 stdout / native hook 与 run 关联。

环境变量：

```text
AGENT_TRACE_ID
AGENT_TASK_ID
AGENT_PARENT_RUN_ID
AGENT_ROLE
AGENT_PROJECT
```

---

# 19. 状态合并策略

一个 Agent 状态可能来自：

- native Hook；
- process state；
- launcher；
- local logs；
- app-server。

统一优先级：

```text
Native blocking signal
>
Native error
>
Process exit
>
Native running state
>
Launcher state
>
Unknown
```

示例：

Launcher 显示 running，但 Claude Hook 显示 waiting_permission：

```text
最终状态 = waiting_permission
```

---

# 20. 异常与降级

## Provider quota 读取失败

显示：

```text
Codex
Quota unavailable
Last update: 12 min ago
```

## Agent Hook 不可用

退化到：

```text
Process running
Process completed
```

## Trace 缺失

Agent 显示：

```text
Unlinked Session
```

允许用户手动关联 Task。

## Dashboard Service 出错

不能影响 Agent 自己执行。

---

# 21. 性能要求

目标：

```text
Idle CPU < 1%
Idle RAM < 250 MB
Island event update < 500 ms
Notification latency < 2 s
```

MVP 不强制严格达标，但作为优化指标。

---

# 22. Windows UX

必须支持：

- System Tray；
- Launch at startup；
- Always on top；
- Multi-monitor；
- DPI scaling；
- Windows notification；
- 最小化到托盘；
- 不占任务栏；
- 窗口位置持久化。

---

# 23. MVP 验收标准

只有以下全部完成才算 MVP：

- [ ] Windows 可以安装并启动；
- [ ] System Tray 正常；
- [ ] Island 正常；
- [ ] Codex Session 可观察；
- [ ] Codex Running / Waiting / Error / Completed 可识别；
- [ ] Codex quota 可显示；
- [ ] Codex 可通过 agentctl 派发至少一种 Child Agent；
- [ ] Parent / Child 关系可在 Tasks 页面显示；
- [ ] Child Agent Process 状态可显示；
- [ ] Child Agent Native Hook 若存在，可补充当前 action；
- [ ] Waiting / Error / Completed 有 Windows 通知；
- [ ] Usage 页面显示 Codex Token 历史；
- [ ] SQLite 正常记录；
- [ ] 数据来源和 freshness 可查看；
- [ ] 额度未知时显示 Unknown；
- [ ] 不包含 Pet / Skill / MCP / Provider Switch 等非目标 UI；
- [ ] 可生成 Windows 安装包。

---

# 24. V1 验收标准

- [ ] Claude quota；
- [ ] Claude Token；
- [ ] Gemini usage；
- [ ] Pi session；
- [ ] 多 Agent Task Tree；
- [ ] Actual API Cost；
- [ ] Equivalent API Cost；
- [ ] 7 / 30 天趋势；
- [ ] Project breakdown；
- [ ] Task breakdown；
- [ ] Usage export；
- [ ] Rate limit warning。

---

# 25. 产品成功指标

个人工具第一阶段不追 DAU，重点看工作流价值：

```text
窗口切换次数下降
阻塞发现时间下降
Agent 完成后等待用户发现的时间下降
多 Agent Task 可追溯率提高
Usage / Cost 可解释率提高
```

可量化：

- 90% 以上通过 launcher 派出的 Agent 能自动建立 parent-child 关系；
- blocking 状态 2 秒内通知；
- usage 数据来源 100% 可追溯；
- unknown quota 不生成伪数据；
- 用户无需打开多个 Agent UI 即可判断当前工作状态。

---

# 26. 最终产品边界

Agent Control Tower 的核心模型是：

```text
Task
  │
  ▼
Root Agent
  │
  ├── Child Agent
  ├── Child Agent
  └── Child Agent

        +

Quota / Token / Cost

        ↓

One Island
One Dashboard
```

产品只做三件事：

1. **Observe** — 谁在做什么；
2. **Trace** — 谁派给了谁；
3. **Measure** — 用了多少资源。

不把产品扩展成第二个 IDE、第二个 Agent Client 或第二个 Agent 配置中心。
