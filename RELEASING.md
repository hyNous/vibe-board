# 发布与版本策略

本文件说明 Vibe Board 自己的发布流程。Vibe Board 是基于 [AgentBro](UPSTREAM.md)
的独立衍生项目，**不跟随上游的发版节奏、版本号或分发渠道**。上游发布新版本不会
自动进入 Vibe Board，也不需要 Vibe Board 同步跟版。

> English readers: this file is currently Chinese-only. The release workflow it
> describes is encoded in `scripts/check-release-readiness.mjs` and
> `.github/workflows/`, which are both English.

---

## 1. 谁来发版

- 版本号、打 tag、上传安装包由本仓库的 maintainer 决定并执行。
- 贡献者**不要**在 PR 里改版本号（见 [CONTRIBUTING.md](CONTRIBUTING.md#版本号)）。
- 发布内容不需要上游批准，也不代表上游的官方发行版。

## 2. 版本号

采用 `MAJOR.MINOR.PATCH`，预发布用 `-preview.<日期>` 后缀（例如
`3.1.1-preview.20260916`）。版本号必须在四处保持一致：

| 文件 | 字段 |
| --- | --- |
| `package.json` | `version` |
| `src-tauri/tauri.conf.json` | `version` |
| `src-tauri/Cargo.toml` | `package.version` |
| `src-tauri/Cargo.lock` | `vibe-board` 包的 `version` |

`pnpm release:check` 会校验这四处一致，并校验 tag 名（`GITHUB_REF_NAME`）与
版本号匹配。不一致时 CI 会失败。

## 3. 分发渠道

**当前唯一的分发渠道是本仓库的 GitHub Releases，手动下载安装。**

- 平台：Windows x64，NSIS 安装包（`.exe`）。
- 安装包**未签名**，SmartScreen 会提示，需要用户手动确认。
- macOS 可以编译，但不是完整分发：CI 里的 macOS 构建用的是一个空 bridge 占位
  文件，只验证能不能编过，产物不作为发行版分发。
- **没有 Homebrew cask、没有 winget、没有其他包管理器渠道。** 早期代码里指向
  上游 `brew upgrade --cask agent-island` 的更新路径已经删除，因为那会把 Vibe Board
  用户引去安装上游产品。

## 4. 自动更新的现状

应用内的更新检查目前**默认不生效**：

- `src-tauri/tauri.conf.json` 里 `plugins.updater.endpoints` 为空、`pubkey` 为空，
  所以 Tauri 原生 updater 没有可用的更新源。
- 前端 `src/hooks/useUpdater.ts` 有一条 GitHub Releases 兜底查询，但它依赖构建期
  环境变量 `VITE_VIBEBOARD_RELEASE_API_URL`（以及可选的
  `VITE_VIBEBOARD_LATEST_WINDOWS_SETUP_URL`）。不配置这些变量时，更新检查会静默
  返回"无更新"，不会去连任何上游地址。
- 要启用签名自动更新，需要先生成 Vibe Board 自己的 updater 密钥对，把公钥写进
  `tauri.conf.json`，并在发布环境里提供 `TAURI_SIGNING_PRIVATE_KEY`。在此之前
  `pnpm release:check` 会给出 pubkey 为空的警告；`CI_RELEASE=1` 时它会升级为错误。

**尚未验证的边界**：安装包签名、Windows 覆盖升级后旧 identifier
（`com.agentisland.desktop`）数据的实际承接、macOS 的设备级安装，都还没有做过真机
验收。不要在发布说明里把这些写成已验证。

## 5. 发布步骤

1. 确认默认分支绿：`pnpm lint`、`pnpm test:run`、`pnpm build`、
   `cargo check --manifest-path src-tauri/Cargo.toml`。
2. 同步更新第 2 节那四个文件里的版本号。
3. `pnpm release:check` 通过（预发布允许 unsigned 警告）。
4. `pnpm tauri:build:windows` 产出 NSIS 安装包。
5. 打 tag `v<版本号>` 并推送；`.github/workflows/build.yml` 会跑构建并上传工件。
6. 在 GitHub Releases 创建 release，附上安装包，并在说明里写明：未签名、
   Windows x64、基于 AgentBro 的独立衍生版本。
7. 更新 `HANDOFF.md` 的发布记录，写清楚**实际验证过**和**未验证**的部分。

## 6. CI

| 工作流 | 触发 | 内容 |
| --- | --- | --- |
| `.github/workflows/ci.yml` | PR / push | 前端 lint + test + build；Windows 后端 fmt + clippy + check；macOS 后端 fmt + clippy + test；release readiness |
| `.github/workflows/build.yml` | push / 手动 | Windows NSIS + MSI 安装包；macOS 编译验证 |

Windows 后端**不跑单元测试**：有一批测试仍然假设 POSIX 路径分隔符、可写的 `$HOME`
和符号链接权限，在 Windows runner 上会因为与被测代码无关的原因失败。所以 Windows
只做编译门禁，测试回归由 macOS 把关。修这批测试见 [ROADMAP.md](ROADMAP.md)。

CI 只跑本仓库的检查，不依赖上游的任何流水线。

## 7. 上游归属

发布物必须保留 [LICENSE](LICENSE)、[NOTICE](NOTICE)、[TRADEMARKS.md](TRADEMARKS.md)
和 [UPSTREAM.md](UPSTREAM.md)。Release 说明里要写清楚这是基于 AgentBro 的独立
衍生项目，不是上游官方发行版。
