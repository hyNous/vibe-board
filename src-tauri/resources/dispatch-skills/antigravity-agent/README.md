# Antigravity Agent Skill

把一个有明确结果的开发工作包交给本地 Google Antigravity CLI，让它自行探索、实现和验证；主控 Agent 负责目标理解、最终 diff 审查与关键验证。

## 安装

安装本 Skill 时，同时安装同级的 `external-agent-core` 目录；它提供共享 runner。新用户也可以先调用 `external-agent-setup` 生成命名 Skill。使用 Skill 安装器时：

```powershell
npx skills add <your-repository> --skill external-agent-core --skill antigravity-agent
```

使用复制目录时，保持这两个目录的相对位置：

```text
<skills-root>/external-agent-core/
<skills-root>/antigravity-agent/
```

## 使用

由主控 Agent 生成包含 `goal`、`cwd` 和可选 `context_hint` 的任务包，然后执行：

```powershell
node <antigravity-agent-skill>/scripts/run-antigravity.mjs --packet <absolute-packet.json>
node <antigravity-agent-skill>/scripts/run-antigravity.mjs --check-quota
```

`context_hint` 只是少量导航信息，Antigravity 必须自行核验，不能把它当成预选文件清单、实现步骤或固定验收表。

## 配置

`providers.json` 是唯一的 Antigravity provider profile。可用 `AGY_BIN` 覆盖命令，也可用 `${LOCALAPPDATA}`、`${USERPROFILE}` 配置跨机器候选路径。当前 profile 保留官方 stream-json 输入/输出和受用户授权的 CLI 权限模式。

## 兼容性与依赖

需要 Node.js、已登录并可由当前主控 Agent 进程发现的 Antigravity CLI。新 CLI 若采用相同的 argv/stdin 与 JSON/JSONL 约定，可以复制本目录并只替换 profile，特殊协议则需增加 parser/adapter。未声明安全额度检查时，`--check-quota` 返回 `unknown`，不会用真实任务探测额度。

## 边界、数据与权限

只把当前工作区中完成任务所需的内容交给 CLI；不要把 API key、凭据、`.env`、私人数据或工作区外路径放入任务包。runner 不绕过主控 Agent 的审批、sandbox 或 provider 数据边界，也不设置硬运行时超时。
