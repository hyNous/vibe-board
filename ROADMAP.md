# Vibe Board 路线图

这是 Vibe Board 自己的路线图，不跟随 [AgentBro](UPSTREAM.md) 上游的计划。这里只
写**当前仓库实际打算做的事**，不写上游已有但 Vibe Board 不做的功能。

已经明确**不在**范围内的（相关代码已经删除，不会回来）：远程 SSH 服务器管理、
Agent Switch / CCSwitch、宠物生态、旧版 Skill 市场、网络抓包 Inspector。

**深链（URL scheme）也不恢复。** 早期的 `agentisland:` / `ccswitch:` 深链只服务于
Agent Switch，随该子系统一并删除，应用现在不注册任何 `xxx://` scheme。原始验收
条件里写的是"深链使用 Vibe Board 命名"，维护者已在 2026-09-18 确认改为不恢复。
看到这条差异时不要把深链插件加回来。

更新时间：2026-09-18

---

## 现在的位置

Windows x64、未签名 NSIS 安装包，通过本仓库 GitHub Releases 手动分发。核心能力：
屏幕边缘任务看板、实时任务/会话同步、审批与提问、用量与 quota、Agent 管理与 Hook
安装、Skill 中心库与分发、外观设置。发布流程见 [RELEASING.md](RELEASING.md)。

## 近期（下一个版本）

1. **桌面级验收**。目前几乎所有改动只验证到单元测试和构建级别。至少要覆盖：
   真实 Codex Desktop 活跃任务的端到端同步、安装包覆盖升级、首次启动向导、
   顶部/左右挂靠拖拽与 HiDPI 缩放。
2. **旧 identifier 数据承接的真机验证**。`com.agentisland.desktop` →
   `com.vibeboard.desktop` 的 WebView 存储承接、`.agent-island`/`.agentbro` 数据根
   的 SQLite 迁移，都只有隔离目录下的单元测试，没有真实升级路径验收。
3. **修 Windows 上的单元测试**。一批 Rust 测试假设 POSIX 路径分隔符、可写 `$HOME`
   和符号链接权限，在 Windows 上失败。修完之后 CI 的 Windows job 才能从
   fmt/clippy/check 升级到跑完整测试（见 [RELEASING.md](RELEASING.md#6-ci)）。

## 中期

4. **任务同步可靠性**。各 Agent 没有统一稳定的任务生命周期接口，Codex 执行中仍
   不能保证 100% 捕获。方向是补齐漏检场景，而不是承诺全覆盖。
5. **安装包签名**。现在 SmartScreen 会拦。需要证书，以及决定谁持有签名密钥。
6. **自动更新**。签名之后才有意义：生成 Vibe Board 自己的 updater 密钥对、配置
   endpoint、验证增量升级不会破坏已安装用户的数据。

## 待定

- **macOS 交付**。代码能编译，但没有做过设备级安装与交互验收，也没有分发渠道。
  要不要做取决于是否有真实需求。
- **清理旧兼容读取**。`.agent-island` / `.agentbro` 数据根、旧 socket、
  `AGENTBRO_HOOK_*` 环境变量目前只用于老用户迁移。等到确认没有老安装还在用，才
  能删；在那之前不要因为"去除旧名称"而删掉它们。

## 怎么参与

- 提 Issue 走 [.github/ISSUE_TEMPLATE](.github/ISSUE_TEMPLATE) 的模板，空白 Issue 已禁用。
- 提 PR 前读 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 想做路线图上的事，先在 Issue 里对齐方案再动工。
