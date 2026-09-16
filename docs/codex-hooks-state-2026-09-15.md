# Windows Codex hooks.state 重复写入排查

## 当前结论与范围

本项目存在能够复现报告中故障的写入缺陷：`src-tauri/src/agents/codex.rs` 中的 `upsert_codex_trust_state` 按生成后的双引号 table 原文删除旧状态，遗漏同一 key 的单引号表示，再向文件内容追加双引号 table。两种表示经 TOML 解析后是同一个 key，因此导致配置整体无法解析。

这不是单引号或双引号本身不合法，也没有证据说明 ponytail、codex-usage-audit 插件有错。问题在本软件以文本形式而非 TOML 语义判断是否已存在。修复及最终验证结果见文末，未完成项不会标为通过。

## 真实配置和备份

- 实际存在的配置：`C:\Users\27312\.codex\config.toml`。请求中无目录分隔符的 `C:\Users\27312.codex\config.toml` 不存在。
- 本次修改前已创建可恢复副本：`C:\Users\27312\.codex\config.toml.before-hooks-repair-20260914-e7b563.bak`，11764 字节。
- 本次首次审计的当前文件时间为 2026-09-14 23:21:56（本地时间），11764 字节，标准 Python `tomllib` 解析成功，14 个 hook state，无语义重复。因此本次没有删除当前配置中的任何状态，也未重置配置或禁用插件。
- 历史损坏文件：`C:\Users\27312\.codex\config.toml.bad-20260914-230936`，13452 字节，最后修改时间 2026-09-14 22:40:57，与用户观察一致。标准解析器在第 378 行报告重复定义。

## 实际发现的重复项

以下行号均来自上述历史损坏文件，不作为修复时的定位依据。公共路径前缀为 `\\?\C:\Users\27312\.codex\hooks.json`，每项后缀为 `:事件:0:0`。逐 table 独立解析键名与 hash 后，确认以下 10 对均为相同逻辑 key 且 hash 相同。

| 事件 | 单引号 table 行 | 双引号 table 行 |
| --- | ---: | ---: |
| notification | 281 | 378 |
| permission_denied | 284 | 381 |
| permission_request | 287 | 384 |
| post_tool_use | 290 | 387 |
| post_tool_use_failure | 293 | 390 |
| pre_tool_use | 296 | 393 |
| session_end | 299 | 396 |
| session_start | 302 | 399 |
| stop | 305 | 402 |
| user_prompt_submit | 308 | 405 |

当前有效文件保留上述 10 个单引号状态；另有 ponytail 的 session_start、user_prompt_submit、subagent_start，以及 codex-usage-audit 的 stop 状态，全部保留。

## 写入流程与证据强度

调用链：看板安装 hook → `CodexAdapter::install_hooks` → `trust_codex_hooks` → `upsert_codex_trust_state`。生成状态时，`hooks.json` 路径经过 `canonicalize()`；Windows 会得到 extended-length 路径，再拼接事件及索引作为 key。旧 writer 将 key 转成 TOML basic string 的反斜杠转义文本，只匹配这种形式的旧表，而没有识别 literal string 的等价形式。其行为是读取整个文件、移除匹配表、在内存中追加新表、整份写回，不是操作系统文件句柄的 append 模式。

已核对的触发入口：

- `src-tauri/src/lib.rs` 启动时，为 Claude 及 `enabled_agents` 中其他已启用 Agent 重新安装 hook。
- `src-tauri/src/hooks/recovery.rs` 恢复监听器检测到需要恢复时重新调用 adapter 的安装函数。
- `src-tauri/src/commands/mod.rs` 手动 hook 安装入口及其他共享 adapter 调用。

安装位置记录为 `D:\Vibe Board`；安装目录中的卸载程序时间为 2026-09-14 22:40:42，历史损坏配置时间为 22:40:57，相隔 15 秒。此时间关系和启动调用链支持“安装后启动看板时触发”。但没有该时刻的进程级文件写入追踪，不能仅凭修改时间宣称已捕获历史写入 PID。

旧 Agent Island 注册表条目仍在，但指向的 `D:\agent island` 目录不存在，不应把这个残留条目当作第二个正在运行的 writer。已查到的 `agent-island.log` 最后更新于 9 月 11 日，不能用于证明 9 月 14 日的确切执行时刻。

已在隔离临时目录用本项目真实 writer 复现：预先存在 literal table 时，旧实现保留它并写入 basic table。此证据足以确认本项目的实际缺陷；无需推测 Codex 内部或第三方插件存在同样问题。没有证据证明另有升级迁移或退出持久化流程才是必要条件，旧缺陷在普通重复安装调用中即可出现。

[Codex 官方 Hooks 文档](https://learn.chatgpt.com/docs/hooks) 说明 hook 信任与具体定义的 hash 绑定，并支持配置层旁的 hooks.json 和插件 hook。文档解释了这些状态的用途，但不能代替本地 writer 的责任证据。

## 修复和验证记录

最终实现保留标准 TOML 解析、literal 优先、冲突 hash 拒绝、读失败拒绝、候选验证、外部变化检查和 `create_new` 备份。重复状态只有在 hash 一致、且被删除 section 的每个字段都能在保留 section 中找到等值内容时才合并；否则拒绝写入并保留原文件，未知字段不会被丢弃。Codex 相关测试 30/30 通过，其中真实 writer 回归覆盖全部 10 事件等价重复修复、幂等、数组表与第三方内容保留、额外字段保全与拒绝、冲突拒绝、读取失败拒绝，以及 basic 先出现、literal 后出现时仍保留 literal。

主审已在 Windows 独立运行 `cargo test --manifest-path src-tauri/Cargo.toml --lib agents::codex`：30 通过、0 失败，退出码 0。测试使用隔离临时文件，不操作真实 Codex 配置。

安全整改阶段的全量 Rust 库测试记录为 561 通过 / 35 失败 / 5 ignored；随后增加了反向引号顺序回归。35 个失败位于未改动的 `skills`、`remote`、`control_tower`、`agents::claude_code`、`agents::toml_hooks` 等模块，在旧实现对照中也存在，未扩展为本次修复任务。最终 Codex 相关测试的主审结果为上述 30/30，不宣称全量 Rust 测试全绿。

已完成的独立检查：当前配置标准 TOML 解析成功；历史文件标准 TOML 解析失败；文本分块后逐块使用标准解析器确认全部 10 对重复及相同 hash；实际用户配置已备份且未被改写。

还使用当前安装的 `codex-cli 0.154.0-alpha.6.2` 执行了只读 `features list`，退出码为 0，显示 `hooks stable true`，未出现 configuration layers 读取错误。这验证了 Codex 本身可以读取当前配置，但不是发送消息或真实重启测试，也没有禁用 hook。

尚未确认：安装最终修复版后真实 Codex 启动、提交消息、关闭重启，以及插件 refresh/hook reload/配置保存后的不复发。本任务运行于用户正在使用的 Codex 中，不会擅自关闭宿主。隔离回归通过也不等同于已经完成真实重启验证。

## 修复边界与安装后复测

- 当前有效配置没有被本次操作改写；源码修复不会自动替换已安装的旧可执行文件。旧版再次启动仍可能触发旧缺陷，需安装最终修复包后再验证。
- 修复后的有效配置使用标准 TOML 文档模型更新原状态，而不是按 header 文本删除后追加。对于已经损坏的文件，只尝试安全、保守的等价状态合并；无法独立解析的复杂片段或无法保全的未知字段会报错并保持原文件，不强行“修好”。
- 有内容变化时，程序先在用户应用数据目录 `hooks/backups/codex` 下创建带时间与 UUID 的不可覆盖备份，再写临时文件，确认原文件未变化后替换。没有变化时不写回、不新增备份。
- 写入前重读能发现准备期间的外部修改，但不能宣称所有不合作 writer 之间实现了跨进程事务锁；本次已去掉失败时无条件回滚覆盖文件的行为。
- 当前没有进程级历史追踪，最初单引号状态由哪个进程生成不能仅凭文本确定。任何合法 TOML writer 都可能输出它；本软件的漏匹配与重复追加已通过真实函数确定，不依赖知道初始单引号的来源。

安装最终修复包后，建议按以下顺序验收并记录结果：

1. 完成当前工作后退出旧看板，安装新包；不要同时运行旧版与新版。无须删除 `.codex` 或插件。
2. 启动看板，正常启动 Codex 并提交一条消息，确认无 configuration layers/duplicate key 错误。
3. 退出并重新启动两者，再提交消息；随后使用现有入口重新安装/恢复 Codex hook，重复检查。
4. 如日常使用插件刷新、hook reload 或配置保存，分别执行正常操作，再检查状态唯一性。不要为了测试禁用全部 hook。
5. 每阶段可运行只读 `codex features list`；本次只读语义审计脚本位于工作区 `.tmp/audit_codex_hook_state.py`，以真实配置路径为参数运行可检查解析结果和重复 key。文件时间变化本身不是错误，应以标准解析成功及状态唯一为准。

这些真实重启与刷新验收尚待执行，不能用单元测试结果代替。

## 同轮界面调整及验证

- Agent 页原来一次只展示当前选中的详情，默认选中 Claude，且技能库存与程序安装概念混用。现增加受支持 Agent 的检测总览，区分程序已安装、仅发现配置、未安装等状态；卡片可切换详情，维护 Skills、Hook 和配置。只发现配置不再计入程序安装数量，也不被称为在线。
- 纯黑和磨砂玻璃合并到总览的单一效果入口，移除显示页重复的配色选择和大块示意预览。磨砂玻璃背景更不透明，模糊从 24px 增至 40px，文字加粗。
- 左右侧边折叠岛的高度改为 148px、外壳宽约 72px，使用竖向长条圆角与竖排 Agent 名，实际命中区域同步调整。
- 主审浏览器渲染检查确认文字导航、两种效果选择、大预览移除，以及纯黑选择刷新后保留。浏览器检查不等于 Windows 桌面背景合成/鼠标停靠的原生验收。
- 主审独立运行 `pnpm test:run --maxWorkers=2`：56 文件、626 测试通过，退出码 0。默认并发曾出现既有测试 5 秒超时；单跑及降低并发后全量均通过，未修改超时掩盖它。
- 2026-09-16 再次运行 `pnpm lint`，退出码 0；再次只读审计真实配置，标准解析成功、14 个 state、无重复 key 和分块解析错误。真实配置仍为 11764 字节，未被本次改写。

## 安装包交付（2026-09-16）

- 新版 NSIS EXE：`releases/Vibe Board-test-2026-09-16-hooks-agent-appearance-setup.exe`，15,615,923 字节，构建产物时间为 2026-09-15 17:31:13，晚于最终界面修改。交付日期与构建日期不同。
- 已检查 EXE 的 MZ/PE 文件头，并确认交付副本与构建目录原件逐字节一致。没有自动运行安装器；这些检查不代表真实安装或数字签名验证。
- 构建目录中的 MSI 仍为 2026-09-14 的旧产物，本次不交付它。此前构建会话输出已无法恢复，因此不宣称 MSI 构建成功；实际交付的是上述新 EXE。
- 旧测试安装包保留，未覆盖。请退出旧看板后安装本次 EXE，再按上文完成真实 Codex 提交、重启和刷新验收。尚未确认安装后不复发，不能将源码回归通过表述为已完成真实环境重启测试。
