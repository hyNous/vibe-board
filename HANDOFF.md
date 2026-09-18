# Vibe Board 开发交接

更新时间：2026-09-18

## 最新进度（优先于下方历史记录）

### 2026-09-18 独立发布生命周期收尾：上游更新通道下线 / 残留远程胶水清理 / 用量口径校正

承接上一轮中断的 `independence-release-lifecycle-8` 工作包（该包此前只写出了任务描述，从未执行）。前面 1–7b 各包的改动全部保留，未回退、未重做。

- **删除指向上游的更新通道**：`useUpdater.ts` 的 `HOMEBREW_UPDATE_COMMAND`（值为 `brew upgrade --cask agent-island`）会把 Vibe Board 用户引去安装上游产品，而 Vibe Board 没有任何 Homebrew cask。整条 homebrew 安装渠道已删除：`UpdateInstallChannel` 类型、`installChannel` 状态与 UI 透传（`useUpdater` / `SettingsApp` / `UpdateDialog` / `AboutSection`）、Rust `is_homebrew_install` 命令与 `is_homebrew_install_path`、`tauriApi.isHomebrewInstall`、五语言的 `settings.updateAvailableHomebrew` / `update.homebrewHint` / `update.copyCommand`、`.update-dialog__command` 样式、随之失去调用者的 `copyText` 辅助函数。Tauri 原生 updater 的 endpoints/pubkey 本来就是空的，GitHub Releases 兜底查询（依赖 `VITE_VIBEBOARD_RELEASE_API_URL`）保持不变。
- **清掉残留的远程 Skill 预览与整条运行环境选择链路**：上一轮只标记了 `browseRemoteSkillSources`/`RemoteSourcePicker` 孤儿路径。独立核查发现范围更大——`runtimeEnvironmentStore.selectEnvironment` 全仓库没有任何调用者，rehydrate 又恒钳制为 `local`，所以 `isLocal` 永远为真，整条远程分支在 Tauri 与浏览器预览下都不可达。已删除：`stores/runtimeEnvironmentStore.ts`、`hooks/useRuntimeEnvironment.ts`、`InstallView` 的 `RemoteSourcePicker` 组件与全部 `isLocal` 三元分支、`skillApiV2.browseRemoteSkillSources` 与 `RemoteSkillSourceEntry`/`RemoteSkillSourceListing`/`AddCenterSkillInput.sourceLocation`、`SkillPackPicker` 的远程徽章与 rehydrate/refresh 调用、`SkillManagerShell` 的运行环境 gating、`configStore` 的 `SSHHost`/`RemoteHostEntry`/`sshHosts`/`remoteHostEntries`/`tcpPort` 及其 action、`skills.runtimeEnvironment.*` 与 `tray.skillPickerRemoteHint` 五语言键、`sm2__*remote-source*` 与 `skill-pack-picker__environment` 样式。
- **顺带清掉同源的死代码**：后端 `SessionState` 在 remote 包里已删除 `remote_host_id`/`remote_host_name`，因此前端 `remoteHostId`/`remoteHostName` 字段及其派生的 `isRemoteSession`（`sessionCapabilities` 的 `locked/remote` 能力、`islandInteraction.sessionHasVisibleActivity` 的提前返回、`sessionStore` 的 `remoteNewPromptSessionIds`/`remoteResponseReady`/`remoteGenericCompletion` 分支）永远为假，一并删除。`NotchPanel` 的 `tray-open-agentisland` 监听在 Rust 侧没有任何 emit（只 emit `tray-open-vibeboard`，且前后端同包发布，不存在版本错配），属于死监听，已删除。`ClaudeHookUiLab` 的演示夹具字符串（`/Users/demo/projects/agentbro`、`.agentbro/bin/agentbro-bridge` 等）改为 Vibe Board 路径。
- **`skillStoreV2.runtimeEnvironmentId` 有意保留**：它被约 40 处异步流程当作"防过期结果"的 generation token 使用。运行环境已经不可切换，所以这些守卫实际恒真；把常量下沉到 `skillStoreV2` 自身并删除了没有调用者的 `switchRuntimeEnvironment`，但没有拆掉这 40 处守卫——那是纯机械改动且有破坏异步流程的风险，收益只是删掉一个恒定值。这是一处**保留的退化代码**，不是"已清理干净"。
- **启动期迁移失败日志现在可见**：`lib.rs::run` 里 `migrate_legacy_webview_storage` 必须在第一个窗口创建前执行，也就是在 `tauri_plugin_log` 安装之前，原先的 `log::warn!` 因此没有任何 logger 接收，失败完全不可见。改为把错误存下来，在 `.setup` 里（logger 已就绪）再输出，并补上"旧副本保留、下次启动重试"的说明。不重跑迁移，不在窗口创建后再迁移。
- **Usage 页 token 口径校正（推翻上一节的描述）**：`session_store.rs` 的 `entry.tokens = session.tokens` 是**覆盖赋值**，所以 `get_agent_statuses` 给出的是每个 Agent **最近一次会话**的 token 快照，不是跨会话累计。下一节 2026-09-17 收尾里写的"跨会话累计、持久化"是错的。UI 文案已改为 `Last Session Tokens` / "每个 Agent 最近一次会话之和" / 表格 Source 列 `last session tokens`，Provider Coverage 卡片明确写出"不是当天或历史全部会话的累计"，聚合处加了注释。未新建任何采集器，未用 quota 百分比冒充 token。
- **新增 `src/test/unifiedUsageSection.test.tsx`（4 项）**：覆盖真实 token 求和、统计范围文案、无 token 时回退 quota 而不是编造数字、既无 token 也无 quota 时显示 Unknown。这是上一轮明确记为"没有测试覆盖"的部分。
- **发布生命周期文档**：新增 [`RELEASING.md`](RELEASING.md)（发版权责、四文件版本同步、唯一分发渠道=本仓库 GitHub Releases 手动下载、无包管理器渠道、自动更新当前不生效的具体原因与启用条件、签名与升级承接的未验证边界）与 [`ROADMAP.md`](ROADMAP.md)（明确列出不做的已下线功能、近期/中期/待定事项）。README（中英）、CONTRIBUTING（中英）、`.claude/CLAUDE.md` 已接入这两份文档；修掉 CONTRIBUTING 里指向 `.claude/CLAUDE.md#6-禁区不要动` 的失效锚点（该章节不存在）。
- **CI 补 Windows 门禁**：原先后端只在 `macos-latest` 跑，而 Windows 才是交付平台。`ci.yml` 拆成 `backend-windows`（fmt + clippy + `cargo check --all-targets`）与 `backend-macos`（fmt + clippy + test），另加 `release-readiness` job 跑 `check-release-readiness.mjs`。**Windows 有意不跑单元测试**：现存 32 项失败全部来自测试自身假设 POSIX 路径分隔符/可写 `$HOME`/符号链接权限，放进 CI 会让 Windows 常红；这条限制已写进 `RELEASING.md` 与 `ROADMAP.md`，不是掩盖。
- **删除根目录旧名 QA 脚本**：`qa-agent-island-state-tests.py`、`test-agent-island-hook.py`、`test-agent-island-hook.sh`。三者均无任何引用，使用 `socket.AF_UNIX` 与 `/tmp/agentbro.sock`，在 Windows 交付平台上无法运行，且指向已被新 socket 取代的旧路径。已提交历史（`b80182d`）中可恢复。此前它们被标为"待用户确认"，本轮按"能删则删"处理。
- **保留未动的兼容面**：`.agent-island`/`.agentbro` 数据根读取与迁移、`AGENTBRO_HOOK_*` 环境变量、旧 socket 回退、`agentisland:`/`agentbro:` 深链识别、`com.agentisland.desktop` WebView/login plist 承接、`disabledByAgentbro` IPC 字段、`App.tsx`/`agentStore` 的旧 localStorage key 回退、`LICENSE`/`NOTICE`/`TRADEMARKS.md`/`UPSTREAM.md` 上游归属。仓库 remote 地址（`hyNous/agent-island`、`hyNous/agentbro`）与 README 中的 clone/releases 链接是真实地址，未改名、未伪造新仓库。
- **验证**：`npx tsc -b`、`npx eslint .`、`npx vitest run`（47 文件 **523 项全部通过**）、`npx vite build`、`node scripts/check-release-readiness.mjs`（ok，仅 updater pubkey 为空的既有警告）、`cargo fmt --check`、`cargo check --all-targets` 通过。`cargo test --lib` 为 **547 通过 / 32 失败 / 3 忽略**，与上一轮记录的基线数量完全一致，均为既有 Windows 路径/HOME/符号链接类失败，本轮无新增失败。注：本机未安装 `pnpm`，以上用 `npx` 调用同名脚本执行，命令等价。前端全量跑了三次：第一次与第三次 47 文件 523 项全过，第二次 `settingsIslandMenu > saves the island effect choice from the appearance page` 单项失败，单独重跑该文件 22/22 通过——判定为与既有 `skillManagerV2View` 超时同类的并发 flake，不是本轮引入的回归，但也没有去修它。
- **深链不恢复（维护者 2026-09-18 决定）**：原始验收条件要求"深链使用 Vibe Board 命名"，但 `agentisland:`/`ccswitch:` scheme 已随 switch 子系统删除，应用现在不注册任何 URL scheme。维护者确认不恢复，已记入 ROADMAP.md，后续不要当作漏做项补回来。
- **更新地址仍缺位（前置条件未满足）**：原始任务要求建立 Vibe Board 自己的更新地址。本轮只删除了指向上游 cask 的错误路径，没有建立新地址——需要先有 updater 签名密钥与至少一个已发布 Release，否则用户只会拿到"检查更新失败"。详见 RELEASING.md 第 4 节。
- **未验证/未做**：未安装或启动应用做桌面级验收；`RELEASING.md` 第 4 节列出的签名、覆盖升级承接、macOS 设备级安装均仍未验证；`skillStoreV2.runtimeEnvironmentId` 的 40 处恒真守卫按上述理由保留；未提交、未推送、未安装，未改动真实用户配置与 hook；`releases/` 下安装包保持原样。

### 2026-09-17 身份迁移中断安全收尾：完整副本 + 单次原子发布

- 迁移语义（`data_dir::migrate_sqlite`，Skill DB 与 control_tower `tasks.db` 共用）：不再「先改名主库再搬 sidecar」。新实现用 SQLite 自身的 `VACUUM INTO` 把源库（含已提交 WAL）复制到目标同目录的 staging 文件 `*.vibeboard-staging`，只有副本完整后才用一次 `std::fs::rename` 原子发布为目标库。目标要么不存在、要么是完整库，不再存在「主库已发布但 WAL 还留在源目录」的中间态。
- 源保留（source retention）：源库及其 `-wal`/`-shm`/`-journal` 整体保留、不会被搬走或删除；复制用只读连接，不写入源库与源 WAL（SQLite 可能在缺失时重建源 `-shm`）。迁移成功后旧数据根仍留一份可回退的完整副本，后续启动看到目标已存在即直接使用，不重复复制。若源库带热 journal 而只读连接无法恢复，迁移显式失败且不动源文件。
- 中断重试：进程在复制中途退出只会留下源库 + 不完整的 staging（可能带 `-journal`），下次调用先清理 staging 再重建；在发布后退出则留下完整目标 + 原样源库，再次调用直接返回「无事可做」。新增 `migrate_sqlite_retries_after_an_interrupted_attempt` 覆盖这两种状态；新增「源不是数据库」「源被占用（Windows 拒共享）」失败用例，失败时不发布目标、不留 staging、源保持可读。
- 陌生库不再自动重置：`skills::v2::db::Db::open` 对无法识别的库（规范路径与自定义路径一致）一律返回显式错误，文件连同真实 WAL 原地不动；删除此前的 `quarantine_database`/`move_database_files`/`incompatible_backup_path` 多文件改名隔离与 `data_dir::move_failure` 回滚机制——隔离本身也是多文件改名，存在同类中断窗口，按任务要求宁可显式失败，也不引入额外恢复机制。该情况下 Skill 功能报错并保持文件原样，应用其余部分不受影响，用户可自行移走或改名该库。
- 实际保证边界：不会自动修复更早的重命名实现可能已留下的半成品状态（例如目标主库已存在、源 `-wal` 滞留），这类源 sidecar 不会再被迁移或删除；只有「主库缺失但 sidecar 存在」时由 `ensure_no_orphan_sqlite_sidecars` 显式拒绝新建库。发布使用同目录改名，不会跨卷；若目标在检查后被其他进程抢建，Windows 下改名失败并清理 staging，不会覆盖已有库。
- 验证：`cargo fmt --check`、`cargo check --all-targets`、`cargo clippy --all-targets`（通过，仍有既有告警；本次新代码无新增告警）通过；`cargo test --lib data_dir::tests` 16/16 通过、`cargo test --lib skills::v2::db::tests` 8/8 通过；`cargo test --lib` 为 547 通过 / 32 失败 / 3 忽略，失败数与上一轮一致且全部为既有 Windows 路径/真实 HOME/符号链接类失败，不涉及本次修改模块（测试净减 2 项来自删除多文件移动与隔离用例）。未安装、未启动应用，未改动真实用户数据与配置。
- 本节取代上一节身份迁移中关于 `migrate_sqlite` 移动 + 回滚与陌生库隔离备份的描述；sidecar 命名规则、孤儿 journal 拒绝、规范路径 gating、WebView 存储承接、自定义 Hook root 等其余行为保持不变。

### 2026-09-17 下线表面收尾：Pet 生态 / 旧 Skill 市场 / 网络抓包 Inspector 清理

- 收尾范围（承接前几个未提交工作包，不重启 remote/switch 与身份迁移）：完成删除 Pet 生态（Rust `src-tauri/src/pets/**`、`src/PetApp.tsx`、仅被 Pet 使用的 notch/overlay 组件、`petStore`/`petVitalsDebugStore`、`types/pet.ts`、`usePetSummon`、`src/pets/**` 资源与对应测试、config 中的 `islandSurfaceMode`/`islandPetScale`/`islandPetWindow*`/`islandActivePetId`/`islandAgentPetMap`）、旧 Skill 市场（Rust `skills/marketplace.rs` 及注册命令、`OfficialSourcesPanel`/`MarketplaceInstallTaskDock`/`marketInstallState`/`data/officialSources.ts`/`skillStoreV2` 市场切片/`skillApiV2` 市场函数）、网络抓包 Inspector（`network_monitor.rs`、`get_monitor_session_detail`/`get_monitor_timeline`/`get_network_monitor_*`/Claude wrapper 命令、`monitorApi`/`tauriApi` 包装与请求明细类型）。remote/switch 包与身份迁移保持原样。
- 保留并验证的真实工作流：屏幕边缘任务看板与 Agent/task 监控（`get_monitor_sessions`、任务 trace、会话 token 汇总）、quota 报告、Codex 真实 token 用量（本地 rollout 聚合）、岛外观与拖拽（`SpriteCanvas` 主题角色、`theme/scanner.rs` 的 codex-pet 主题发现、`$HOME/.codex/pets/**` asset scope）、Skill 安装页三个入口（Agent 同步 / 本地导入 / Git 安装）及 GitHub 更新检查与同步（`check_github_skill_update`、`sync_github_skill`、`preview_github_repo_import`、`import_github_repo_skills` 均已注册）；市场 tab 的旧持久化值会回退到 Git tab。
- Token 用量边界（未降级为 quota-only）：删除网络抓包派生的按请求/按维度 token 聚合与 Breakdown；`UnifiedUsageSection` 改为聚合仍存在的 Hook 会话真实 token（`get_agent_statuses` 的 `AgentStatusSnapshot.tokens`）并按 Provider 展示——**注意：本节原先写的"跨会话累计"是错的，该字段是每个 Agent 最近一次会话的覆盖式快照，已由 2026-09-18 一节更正**，同时保留 CodexUsageSection 的 rollout token 桶。具体冲突：网络 monitor 的用量采集与已下线的代理/抓包 inspector、switch 子系统的启用与持久化绑定，且其唯一入口（监控设置里的网络面板）已随 inspector 退役；在不重启 switch 包、不重新引入代理的前提下无法保留该路径，因此选择保留 Hook 会话与 Codex rollout 两条真实 token 路径，而不是恢复代理。
- 前端清理补完：`spriteCanvas.test.tsx` 改用主题角色（`ThemeConfig.character`）而非已删除的 `PetOption`；删除 `notchPanel.test.tsx` 的 pet 模式用例与 `settingsIslandMenu.test.tsx` 中已移除的 store 字段；五语言同步删除 `welcomeSurface*`/`surfaceIsland`/`islandSurfaceMode*`/`islandPetScale` 死键并把 `islandResetDefaults*` 文案改为纯灵动岛；删除 `NotchPanel.css` 中无引用的 `data-island-state="pet"` 规则；更新指向已删除 pet 窗口的过期注释。
- Rust 遗留修复：`agents::toml_hooks::tests::parse_handles_file_with_only_marker_no_hooks` 仍以旧 `AgentBro managed integration` 文本做夹具却断言新 `MARKER_PREFIX`（身份迁移遗留），已改为使用当前 marker；`cargo fmt` 修正了 `lib.rs`/`skills/registry.rs` 两处既有格式差异。
- 验证：`pnpm lint`、`pnpm test:run`（46 文件 522 项全部通过）、`pnpm build`、`pnpm release:check`、`cargo check --all-targets`、`cargo fmt --check`、`git diff --check` 通过。`cargo test --lib` 为 549 通过 / 32 失败 / 3 忽略；32 项与既有记录一致，均为 Windows 路径分隔符 / 真实 HOME 泄漏 / 符号链接权限类失败（`toml_hooks` 修复后由 33 降至 32），另有 `control_tower::agentctl::tests::fake_child_updates_run_lifecycle` 的 `done` vs `completed` 断言失败发生在未修改文件，未确认与本次清理相关。
- 未验证/未做：未安装或启动应用做桌面级验收（Skill 安装/更新、任务看板、Usage 页均只到单元/构建级验证）；网络 monitor 用量路径按上述冲突有意不恢复，历史 `~/.vibeboard/network/monitor-state.json` 等残留状态文件不再读写；`sm2__market-*` 等旧命名 CSS 仍与保留面板共用，未做逐类删除；未提交、未推送、未安装，未改动真实用户配置与 hook；`releases/` 下用户安装包保持原样。
- 顺带发现（未处理、非本包范围）：前端 `skillApiV2.browseRemoteSkillSources` 调用的 `browse_remote_skill_sources` 命令已随 remote 包移除且未注册，只有浏览器预览用 `RemoteSourcePicker`（`useRuntimeEnvironmentView` 的非 Tauri 分支）会走到，Tauri 运行时不可达；因属于已完成的 remote 包且当前入口被钳制为本地，本包未删除该预览胶水。

### 2026-09-17 身份迁移加固与正确性修复：Skill DB / Hook / UI 偏好安全承接

- 二轮修复（在上一轮承接逻辑上）：sidecar 一律按 SQLite 完整文件名追加规则处理，目标已有 sidecar 时拒绝迁移；迁移/隔离失败必须显式向上失败，回滚失败要在错误中说明；新建库前拒绝孤儿 journal；用真实 SQLite WAL（非同名文本文件）验证迁移与隔离；UI 偏好承接改为 staging 复制 + 完成标记重试，目标已存在时显式报错。上一轮「承接只执行一次、若新 identifier 已运行过则永久跳过」与「隔离失败仍可能新建空库」的行为已按本轮描述修正。

- Skill DB 迁移加门控：`skills::v2::db::Db::open` 只在打开规范路径（`~/.vibeboard/skill-manager/skill-manager.db`）时才从 `.agent-island`/`.agentbro` 旧根迁移数据库；任意临时路径或用户在设置里指定的自定义 sqlite 路径不再移动任何旧文件，避免测试/自定义路径触碰真实用户数据。
- 不再丢弃陌生数据库：旧逻辑在 `SELECT skill_type FROM skills` 探测失败时直接删除文件，现在先识别库形态（空库 / 数据库缺失 `skill_type` / 无 `skills` 表都视为陌生）。规范路径上的陌生库改名为 `*.incompatible-<UTC>.bak`（同名 WAL/SHM/journal sidecar 一起改名，可手动恢复），随后新建 Vibe Board 库；非规范路径上的陌生库直接返回错误且完全不修改文件。隔离迁移改为 all-or-nothing：先移动 sidecar 再移动主库，任一步失败都会回滚已移动文件；回滚也失败时会在错误中说明，`Db::open` 随之失败，不会再出现「隔离移动失败仍新建空库」。无法打开（被占用等）也显式报错，不再误删。
- `data_dir::migrate_sqlite` 改为整体迁移：sidecar 路径按 SQLite 规则在完整文件名后追加 `-wal`/`-shm`/`-journal`（任意 `.sqlite`/无扩展名路径都正确，不再用 `with_extension` 改写扩展名）；目标 sidecar 已存在时显式拒绝迁移，绝不把无关 journal 接到迁入库上；sidecar 迁移失败会把已移动文件回滚并返回错误，回滚失败同样在错误中给出，源数据保持完整。Skill DB 与 control_tower DB 两个新建库入口都会在「主库缺失但仍有孤儿 sidecar」时直接失败，不再对着遗留 journal 新建空库。`migrate_file`/`migrate_dir` 现在返回 `Result`，Skill DB 与 control_tower DB 的迁移失败会显式向上抛错，其余兼容读取调用点保留原有回退语义。
- 主页解析统一：`data_dir::home_dir()` 依次读取 `VIBEBOARD_HOME` → `$HOME` → 平台 profile，`fsutil::home()` 复用它；Windows 上 `dirs::home_dir()` 不读环境变量，此前迁移代码在测试里会落到真实用户 profile，现在隔离目录生效。
- UI 偏好跨越 identifier：Windows 下在创建任何窗口之前，把旧 identifier（优先 `com.agentisland.desktop`，其次 `com.agentbro.desktop`）的 `EBWebView\Default\Local Storage` 复制到新 identifier（`com.vibeboard.desktop`）目录。复制先写入同目录 staging 再整体改名，失败不会留下半成品目标；成功后写入 `vibeboard-webview-storage.migrated` 标记，未写标记则每次启动重试（源被旧 WebView 占用或源不存在都不会误记成功）。旧目录始终只读保留；若新命名空间已存在 live Local Storage，由于 LevelDB 不能安全合并，函数显式报错并在启动日志中说明，把新 Local Storage 移开后下次启动即可完成承接。前端 `App.tsx` 已有的 `agent-island-config`/`agentbro-config` 旧 key 回退因此可以取到 `sideIslandSize` 等仅存 localStorage 的 UI 偏好，theme/主题旧 key 同理。
- 自定义 Hook 安装根目录：`profiles::legacy_managed_paths`/`remove_legacy_managed_paths` 从实际安装路径推导 `agentbro`/`agentbro.json`/`agentbro.js` 旧文件，在自定义 root 安装或卸载不再删除默认 home root 下的托管 Hook；默认路径行为不变，`resolve_home_path` 也改用可覆盖的主目录解析。Hook 事件选择文件增加旧根读取回退，迁移失败不会丢选择。
- 本轮明确未动：进行中的 remote/switch 删除、插件改名、前端收窄等身份/清理编辑保持原样；未安装、未启动应用，未改动真实用户配置与 hooks，未提交/推送。
- 验证：`cargo check --all-targets`、`cargo fmt --check` 通过；`git diff --check` 仅有既有 LF/CRLF 提示。`cargo test --lib` 为 568 通过 / 33 失败 / 5 忽略，本轮新增 14 项迁移/隔离测试全部通过；33 项失败与基线数量一致（失败名单逐项比对相同），均为既有 Windows 路径分隔符/HOME/符号链接权限类失败，无新增失败。本轮未改动前端，`pnpm lint`/`pnpm test:run`/`pnpm build` 沿用上一轮通过结论。
- 新增测试（全部使用临时 home/config/data 目录，不触碰真实用户目录）：规范路径迁移 `.agent-island`/`.agentbro` 旧库、任意路径不动旧库、陌生库隔离备份、sidecar 命名按 SQLite 追加规则（含 `.sqlite` 文件名）、目标遗留 sidecar 时拒绝迁移且不动源、sidecar 移动失败回滚、回滚失败显式上报、孤儿 sidecar 阻止新建库（含非规范路径 `Db::open`）、迁移后真实 SQLite WAL（`SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE` 保留未 checkpoint 数据）仍能读到行、隔离后真实 WAL 备份仍能读到行、WebView Local Storage staging 复制且不覆盖新数据、目标已存在时显式报错且移开后重试成功、源被占用时保留源且不留半成品、旧 `config.json` 承接、自定义 Hook root 不删除默认 root 的 kiro/hermes 托管文件。
- 未验证/剩余边界：WebView 存储承接仅覆盖 Windows（Tauri 在 Windows/Linux 强制 per-identifier 数据目录，本机只验证 Windows；macOS/Linux 的 UI-only 偏好仍会回落默认值）；若用户已先运行过新 identifier 构建并产生了 live Local Storage，LevelDB 无法安全合并，需要用户手动把新 `Local Storage` 目录移开后重试（启动日志会给出该提示）；承接成功后写入 `vibeboard-webview-storage.migrated` 标记，标记本身丢失会被当作未完成并再次承接（目标已存在时会显式报错，不会覆盖新数据）；被隔离的陌生库需要用户手动把 `.incompatible-*.bak` 改名回 `.db`（连同名 `-wal`/`-shm`/`-journal`）才能恢复；迁移/隔离失败但回滚也失败时，文件可能停在人工可恢复但非自动修复的位置，错误消息会指出具体文件；真实安装包覆盖升级、首次启动与旧 identifier 数据承接未做桌面级验收。

### 2026-09-17 后端清理：移除已下线的 Remote SSH 与 Agent Switch/CCSwitch 子系统

- 删除 Rust `src-tauri/src/remote/**`（SSH 隧道/自动重连、远程 attach、远程 Hook 安装、远程 Skill Manager 与代理脚本、ssh config、远程终端）与 `src-tauri/src/switch/**`（provider/prompt/usage/pricing/health/migration/live_writer/presets/schema/deeplink/db）。
- 注册与启动面：删除 `lib.rs` 中全部 remote/switch 命令实现与注册、`AppState.remote_manager`/`switch_db`、`start_remote_codex_state_sync` 后台任务、RemoteManager 启动与持久化 hosts 注入、SwitchDatabase 打开逻辑；`commands/mod.rs` 删除远程 Codex 线程同步、远程会话分支与诊断导出中的 `remoteHosts` 脱敏。
- 兼容读取：删除 `AppConfig.remote_hosts` 与 `SessionState.remote_host_id/remote_host_name` 字段；旧 `config.json`/会话快照中的同名字段被 serde 忽略，`~/.vibeboard/switch/switch.db` 原样留在磁盘但不再读写。
- Hook 链路：移除 `_remote_host_id`/`_remote_host_name` 远程事件处理（远程隧道已不存在，事件无法到达），本地 pid/tty、通知抑制、空闲路由与任务完成逻辑保持原行为。保留 `remote_session_chat_history`：它是 OpenCode 等无 transcript Agent 的 raw hook 事件回退，名称是历史命名，与远程主机无关。
- 依赖与生成物：移除 `tauri-plugin-deep-link` 依赖、插件初始化、`tauri.conf.json` 的 deep-link scheme（`vibeboard`/`agentisland`/`ccswitch`）配置与启动时 `switch-deep-link` 事件处理；重新生成 `src-tauri/gen/schemas` 并同步移除 macOS schema 中的 deep-link 权限项。
- 工具链与文档：`scripts/check-release-readiness.mjs` 的 SQLite schema bootstrap 校验从已删除的 `switch/schema.rs` 改指 `control_tower/db.rs`；`docs/privacy-policy.md` 删除 Remote SSH 章节。
- 明确未动的部分：当前未提交的身份迁移与前端清理保持原样；`AGENTBRO_HOOK_*`、旧 socket、`agentisland:`/`agentbro:`/`ccswitch:` URL 识别、历史 `docs/plans`、根目录 QA 脚本，以及 Pet/旧市场/网络抓包清理不在本工作包内。
- 验证：`cargo check --all-targets`、`cargo fmt --check`、`pnpm lint`、`pnpm build`、`pnpm release:check`、`git diff --check` 通过；`cargo test --lib` 为 539 通过 / 33 失败 / 5 忽略，失败项全部属于既有 Windows 路径/HOME 类问题（测试总数减少来自被删子系统测试，失败数由 35 降至 33，无新增失败）；`pnpm test:run` 46 文件 523 项通过（首轮 1 项 `skillManagerV2View` 并发超时，单测与全量重跑均通过）。
- 未验证：未安装或启动应用做真实桌面验收；未在 macOS 上重新生成 macOS schema；`vibeboard:`/`ccswitch:` 等外部深链不再由应用注册。

### 2026-09-17 产品身份迁移：统一 Vibe Board 命名并保留兼容读取

- 构建与安装身份：Cargo package/default-run 改为 `vibe-board`，库名 `vibe_board_lib`，桥接 binary 改为 `vibe-board-bridge`；Tauri identifier 改为 `com.vibeboard.desktop`；bridge 资源占位目录、打包脚本、CI 工件名、`build.sh` BUNDLE_ID、NSIS/updater 校验同步；新增 `vibeboard:` 深链 scheme，同时继续解析 `agentisland:`、`agentbro:`、`ccswitch:`（该深链 scheme 注册与解析已在 2026-09-17 后端清理中随 switch 子系统移除）。
- 插件身份：`plugins/agent-island-host` 重命名为 `plugins/vibe-board-host`，Claude/Codex 插件名、共享 Skill 名、`.agents/plugins/marketplace.json`、SetupWizard、插件 README 与 `docs/product-setup.md` 同步。
- 数据根目录：新增 `~/.vibeboard`（Windows 配置为 `%APPDATA%\vibeboard`）为唯一写入根，`~/.agent-island`、`~/.agentbro` 仅做一次性迁移或兼容读取。覆盖 bridge bin、usage-host、executable marker、hook invocations、agent-status、install_id、logs、sounds、themes（`~/.config/vibeboard/themes`）、telemetry 状态、Skill 中心标记/DB/settings/snapshot、skill metadata、control_tower DB、switch DB、pets 扫描（新增 `.vibeboard` 来源）。
- Hook 集成：环境变量改为 `VIBEBOARD_HOOK_SOCKET`/`VIBEBOARD_HOOK_PORT`/`VIBEBOARD_ENGINE_LABEL`/`VIBEBOARD_CONFIG_ROOT`，块标记改为 `# [VIBEBOARD-START]`；Antigravity/Cursor/Kiro 配置键改为 `vibeboard`/`vibeBoardHooks`/`_vibeboard`；Kiro/Hermes/OpenCode 托管文件分别写入 `vibe-board.json`/`vibe-board`/`vibeboard.js`，安装后清理同名 legacy 文件；桥接进程优先连接新 socket，失败后再尝试 `agent-island`/`agentbro` 旧 socket；可执行 marker 读取回退旧文件。
- 发布与文档：`.github/workflows/*`、`scripts/check-release-readiness.mjs`、`src-tauri/tauri.conf.json` 资源名与 asset scope、`AGENTS.md`、`.claude/CLAUDE.md`、CONTRIBUTING 桥接名、`docs/product-setup.md`、`docs/telemetry.md`（新环境变量 + 旧名回退）同步；README 中的 GitHub clone/releases 地址是真实仓库地址，保持不变。
- 明确保留的兼容面：`AGENTBRO_HOOK_*` 环境变量、`.agent-island`/`.agentbro` 读取与迁移、旧 socket 路径、`agentisland:`/`ccswitch:` 深链、`disabledByAgentbro` IPC 字段、`agentbro://builtin-marketplace` 来源标识、Homebrew cask `agent-island` 检测与升级命令、monitor 的旧安装路径、历史 `docs/plans`、`docs/superpowers` 与根目录 `test-agent-island-*` 手工 QA 脚本。（其中 Rust remote/switch 模块、已注册命令与 `ccswitch:` 深链启动处理已在 2026-09-17 后端清理中移除，见上一节。）
- 验证：`cargo check --all-targets`、`pnpm lint`、`pnpm build`、`pnpm release:check`、`cargo fmt --check`、`git diff --check` 通过；`pnpm test:run` 46 文件 523 项通过（首次 1 项并发超时，重跑通过）；`pnpm build:bridge` 已构建 debug 桥接。`cargo test --lib` 为 568 通过 / 35 失败 / 5 忽略，已用 detached worktree 对比 HEAD 基线（566 通过 / 35 失败 / 5 忽略）：失败项逐项一致（Windows 路径分隔符、HOME/USERPROFILE、linux 候选等既有失败），无新增失败。
- 未完成/未验证：未安装或启动应用做真实桌面验收；identifier 变更意味着新安装包与旧 `com.agentisland.desktop` 安装并存，旧数据依赖首次启动的迁移读取；macOS launch-agent 迁移、Homebrew 路径与真实拖拽/窗口交互未在真机验证。

### 2026-09-17 产品收窄：移除已下线的 AgentBro 遗留界面

- 保留的可见工作流：屏幕边缘任务看板、实时任务/会话同步、审批与问题、使用额度、Skill 管理、Agent 管理/连接、外观设置、通用设置。
- 删除的不可达前端表面及死代码：
  - 远程服务器：`RemoteServersSection`、`RuntimeEnvironmentSwitcher`、`remoteServerStore` 及其 `tauriApi` 包装；运行环境选择器在持久化重水合时钳制为本地。
  - Agent Switch：`SwitchSection`、`sections/switch/*`、`switchStore`、`switchApi` 及 `SettingsApp`/侧栏入口。
  - 旧版监控/抓包：`AgentMonitorSection` 裁剪为任务视图；会话详情、网络抓包、接入设置等分支与 `monitorApi`/`tauriApi` 中的对应包装一并移除。
  - Pet：删除 `PetApp`、`PetSurface` 及仅被它引用的组件（ChatView/HoverList/ApprovalBar/Confetti 等）、`petStore`、`petVitalsDebugStore` 与相关测试。Rust 侧保留 `discover_pets`、pet 窗口与拖拽命令作为兼容 IPC；新增启动迁移，把持久化的 `island_surface_mode == "pet"` 归一为 `"island"`，避免旧安装进入空白窗口。
  - 市场：删除 `MarketPanel`、`OfficialSourcesPanel`、`MarketplaceInstallTaskDock`、`marketInstallState`、`skillStoreV2` 市场切片与 `skillApiV2` 市场函数；`InstallView` 只保留 Agent 同步、本地导入、Git 三个真实入口。
  - 死样式与文案：`settings.css` 的 runtime-environment/remote-server 区块、无人引用的 `SkillsSection.css`、五语言中的 remote/switch/pet/market 文案键。
- 明确保留的兼容路径：Rust `pets`/`skills::marketplace` 模块与已注册命令、数据目录与 Tauri identifier、`agentbro-*` 持久化键。它们属于升级兼容面。原先保留的 Rust `remote`/`switch` 模块与命令、`ccswitch:` 深链、远程技能代理脚本已于 2026-09-17 后端清理中移除。
- 验证：`pnpm lint`、`pnpm test:run`（46 文件 523 项）、`pnpm build`、`cargo check --all-targets`、`cargo fmt --check` 通过；`cargo test --lib` 仍有既有 4 项 Windows 路径分隔符失败（与本轮无关）。未安装或启动应用做真实桌面验收。

### 2026-09-16 侧边尺寸档位与拖拽修复

- 当前功能检查点为 `7457315 docs: refresh GitHub project presentation`；此前 `ba90a36` 保存侧边尺寸档位与拖拽修复，`7afb9e2` 保存 hook 修复和设置页，`43b1e69` 保存上一版安装包及交接记录。
- 侧边尺寸档位已完成在代码中：`sideIslandSize` 三档 `narrow / standard / wide`，实际壳尺寸分别为 64×132、72×148、80×168 逻辑像素（默认窄档，原版为 72×148）；设置页 Display 下拉即时预览并持久化；档位同时驱动收起竖条尺寸、圆角和悬停命中框；五套 i18n 已同步；单测覆盖档位顺序、默认值、顶部不受影响和设置页预览。
- 拖拽缺陷根因已复现并修复（Windows 侧边拖回顶部“空气墙/停滞/跳变”）：
  1. 原生拖拽的边界和落点判定此前使用整块透明宿主窗口，而不是可见岛壳。侧边常态宿主是 658×612 的稳定画布，收起竖条只有 64×132 且垂直居中（偏移 240px），所以可见竖条最多升到距顶 240px 就被宿主边界卡住；落点又要求“看不见的宿主顶”贴到屏幕上缘，随后释放才跳到顶部并收起。
  2. Windows 的 `GetCursorPos` 返回物理像素，而拖拽窗口位置是逻辑像素，未做 DPI 换算时指针位移会按缩放倍率放大。
  - 修复链路：前端在 `startNotchDrag` 时经 `getIslandDragAnchor` 上报可见岛壳的宽高及它在宿主内的偏移；Rust 用该可见矩形计算 `min/max` 钳制与 `notch_drop_position_mode` 落点，宿主允许挂到屏幕外；拖拽期间光标位移按目标显示器 scale 归一化后再叠加；落点判定给新边缘 16px 触达区，当前停靠边只有在严格更近时才保留，保证“右侧竖条上拖到顶部”能真正落到顶部。
- 回归证据：`src/test/notchPanel.test.tsx` 两条拖拽用例在修复前失败（`startNotchDrag` 只收到 658×612 宿主尺寸，没有可见矩形），修复后通过，并断言可见矩形与偏移（侧边 658×320 @ y140，顶部 658×320 @ x14）；Rust 新增 4 条纯函数测试覆盖可见矩形边界、旧宿主行为兼容、落点脱离停靠边和 Windows 光标单位，`cargo test --manifest-path src-tauri/Cargo.toml pet_window_tests` 11/11 通过。
- 本轮验证：`pnpm test:run` 56 文件 634 项通过；`pnpm lint`、`pnpm build` 通过；`cargo check --all-targets`、`cargo fmt --check` 通过；`cargo test --lib` 为 566 通过 / 35 失败 / 5 忽略，35 项与既有记录一致，无新增失败；`cargo clippy --all-targets -- -D warnings` 仍有既有报错（38 项编译错误来自其他模块的 `field_reassign_with_default` 等；`lib.rs` 另有 410 行 `unneeded return`、4532 行参数数量两项既有告警），本轮新增代码未引入告警。
- 未进行真实桌面验收的边界：本轮没有安装或启动应用，没有用真实鼠标做侧边↔顶部拖拽、HiDPI（150%/200%）缩放、多显示器或落点手感验证；主审已抽帧检查用户录屏，OpenCode 未直接读取视频。修复验证来自单元/组件级回归与代码链路推演。真实验收至少需要覆盖：右侧窄档上拖到顶、150% 缩放下 1:1 跟随、顶部左右拖动切换挂靠、释放前距离边缘 10–20px 的落点。
- 主审独立验收：前端 56 文件 634 项通过，Rust `pet_window_tests::notch` 6 项通过，lint、前端 build、`git diff --check` 通过。完整 Rust 35 项既有失败及 clippy 边界来自 OpenCode 本轮验证，不宣称全仓库检查全部通过。
- 当前安装包为 `releases/Vibe Board-test-2026-09-16-side-size-drag-setup.exe`（15,620,460 字节，2026-09-16 16:56:45），`Vibe Board-latest-setup.exe` 已同步，两个副本均与构建产物逐字节一致。旧 hooks-agent-appearance 测试包已删除，其同内容 latest 可从 `43b1e69` 恢复。应用未安装或启动。
- GitHub `hyNous/agent-island` 的 `main` 已推送至 `74573155989fbaf03f04e8161dfead9ee57c98f4`；预发布 `v3.1.1-preview.20260916` 已上传同一份 EXE，地址为 `https://github.com/hyNous/agent-island/releases/tag/v3.1.1-preview.20260916`。
- 打包：组合 nsis/msi 命令在 MSI 的 WiX `light.exe` 阶段失败；随后仅构建 NSIS（复用已完成的 Bridge 和前端构建）成功，退出码 0，交付仅 EXE，不交付旧 MSI。本轮临时任务 JSON、状态文件和抽帧图片已清理，原始用户录屏和配置备份保留。
- OpenCode 启动阻塞已解除，本轮通过工具的 Windows 用户进程模式使用 DeepSeek V4.1 Flash max 完成两个任务。最初合并任务触发 Runner 10MB 输出保护，检查确认无代码修改后，拆分尺寸/拖拽并复用会话完成；未降低输出安全限制。

## 1. 当前基线

- 仓库：`D:\Projects\code island\control-tower`
- 分支：`local/control-tower-dev`
- 产品名：`Vibe Board`
- 当前版本：`3.1.1`
- 当前阶段：Windows 产品化与悬浮看板体验完善
- 功能检查点提交：`c66cd17 feat: simplify Vibe Board task panel`
- 开始新任务前请先执行 `git status --short` 和 `git log -3 --oneline`，不要重做已经提交的功能。

当前 Rust package、Tauri identifier（`com.vibeboard.desktop`）、本地数据目录（`~/.vibeboard`）、插件目录和深链均已使用 Vibe Board 命名；`~/.agent-island`、`~/.agentbro`、`AGENTBRO_HOOK_*`、旧 socket、`agentisland:`/`ccswitch:` 深链等只作为一次性迁移与既有 Hook 兼容读取保留，不能机械删除。

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
- SHA-256：`D6FCAD97EF6A9C262159CDC18EEBB42B823E22CC162C3E379A5F06F091BB89FC`

本轮未安装这个新包，也未覆盖用户机器上当前已安装的版本。

## 6. 本轮验证

- `pnpm test:run`：54 个测试文件、611 项测试全部通过。
- `pnpm build`：通过，873 个模块。
- `cargo check --manifest-path src-tauri/Cargo.toml --all-targets`：通过；只有仓库既有 dead-code 警告。
- `git diff --check`：通过；仅有既有的 LF/CRLF 提示。
- 中英文 README 链接/图片审查、Hero SVG XML 解析和 `git diff --check`：通过。
- `cargo tauri build --bundles nsis --ci --config '{"bundle":{"createUpdaterArtifacts":false}}'`：通过。

## 7. 已知边界与下一步

优先级最高：

1. 使用真实 Codex Desktop 活跃任务做端到端验收，记录 app-server、rollout 和看板状态，继续提高漏检场景的同步可靠性。
2. 安装本轮最新 NSIS，手动验收顶部/左右挂靠、悬停展开收回、任务滚动和点击唤回 Desktop Agent。
3. 发布与版本策略见 [`RELEASING.md`](RELEASING.md)，后续计划见 [`ROADMAP.md`](ROADMAP.md)。

当前边界：

- Codex 正在执行任务时，看板仍不能保证 100% 同步。
- Windows 是当前交付平台；macOS 尚未做设备级安装与交互验收。
- Windows 安装包尚未签名，SmartScreen 可能提示。

待用户确认后再处理：

- `docs/plans/` 和 `docs/superpowers/` 的历史设计/实施文档。

这些文件不参与运行和安装，但仍可能用于历史追溯，因此没有擅自删除。根目录的三个旧名手工 QA 脚本已于 2026-09-18 删除（无引用、Unix socket、Windows 上不可运行），见最新进度一节。

## 8. 新任务注意事项

- 不要为了“去除旧名称”删除兼容路径、旧配置读取、Tauri identifier 或既有插件入口。
- 不要把 Agent 进程在线状态当作正在执行任务。
- 不要恢复会话正文、模型回复或工具详情到任务看板。
- 普通任务点击只负责唤回 Desktop Agent；CLI-only Agent 只提示手动查看。
- 修改动画前先复现并核对原生窗口尺寸、位置和 WebView 内容动画，不要重新引入二次 resize 或自动展开计时器。
