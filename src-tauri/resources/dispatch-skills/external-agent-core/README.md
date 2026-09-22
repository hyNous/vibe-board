# External Agent Core

这是命名外部 Agent Skill 共用的 CLI adapter runner，也是安装时必须与目标 Skill 一起部署的支持包。普通用户应使用 `external-agent-setup` 完成检测和配置，不要直接触发本包。

标准安装器按单个 `SKILL.md` 目录安装，因此不能只安装 provider Skill 而假定兄弟目录一定存在。发布时请同时安装支持包和目标 Skill：

```powershell
npx skills add <your-repository> --skill external-agent-core --skill opencode-agent
```

或者直接安装整个仓库，再由配置向导生成命名 Skill。

## Provider profile

复制 `profiles/provider.template.json`，为新的 CLI 建立一个 Skill 的 `providers.json`。常见配置只需要填写：

- `command` 或环境变量覆盖名 `command_env`；
- `env_allowlist` 和 `credential_env` 只允许声明需要传递的环境变量名，绝不写入密钥值；
- `args`、`permission_args`；
- `prompt_transport`：`argv_end`、`stdin_text` 或 `stdin_json`；
- `cwd_flag`、`model_flag`、`effort_flag`、`session_flag`；
- `output_parser`：`generic-jsonl`、`result-event`、`text` 或 `opencode-jsonl`。
- 可选 `quota_check` 只有在命令或 HTTPS JSON 端点被供应商明确保证为不消耗模型调用时才启用；无法明确判断时返回 `unknown`。额度探针默认 10 秒超时，最长 30 秒，超时只返回 `unknown`，不会卡住任务结果。HTTP 检查可用 `kind: "http_json"`、`url`、`credential_file_candidates` 和 `credential_keys`，凭据只在内存中使用，不写入日志。

运行器会额外透传标准代理环境变量：`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 及其小写形式。开源用户不需要把代理地址写入 profile；只需在启动主控 Agent/CLI 的进程环境中配置它们。CLI 专有的其他环境变量仍应通过 `env_allowlist` 或 `credential_env` 声明。

`command_candidates` 支持 `${APPDATA}`、`${LOCALAPPDATA}`、`${USERPROFILE}` 等环境变量，避免把个人绝对路径写入 Skill。

启动时如果首个候选路径在进程启动前因 `ENOENT`、`EINVAL`、`EACCES`、`EPERM`、`ENOTDIR`、`EISDIR` 或 `ENOEXEC` 失败，运行器会按配置顺序尝试后续存在的候选路径，并记录 `launch-retry`；一旦 provider 已启动、输出内容或返回任务/API 错误，就不会重复执行任务。

## Task packet

```json
{
  "goal": "完成一个可独立交付的结果",
  "cwd": "仓库绝对路径",
  "context_hint": {
    "summary": "父 Agent 已知的现象",
    "area": "可能涉及的业务区域",
    "conventions": ["已知的仓库约定"],
    "candidate_paths": ["可能的起点，必须自行验证"]
  },
  "model": "可选",
  "effort": "可选",
  "session_id": "可选的续接会话"
}
```

`context_hint` 只是导航信息，不能替代 Agent 自己探索，也不应包含密钥、`.env`、私人数据、强制文件清单或实现步骤。

如果新 CLI 采用上述常见传输和输出协议，新增 CLI 不需要复制 runner；如果它有特殊事件协议，只需增加一个小型 parser/adapter，不需要重写任务分包、上下文、进度和结果处理。

运行器默认只向子进程传递必要的基础环境变量和 profile 声明的变量；诊断会隐藏常见密钥格式，不输出完整 prompt 或 argv。长任务没有硬运行时上限，可选 `--status-file` 写入脱敏状态，并用 `--cancel-file` 由调用方明确请求取消。

Runner 返回的 `recovery` 字段包含 `phase`、`cause`、`action`、`retry_allowed`、`error_code`、已执行的 `automatic_actions` 和后续 `next_steps`。编排器应先执行安全的自动恢复，再把剩余流程返回给用户，不能只报告 `not found`。Windows 下若 CLI 位于用户目录，应由工具层使用受信任的 Windows 用户进程启动；Skill 本身不能自行提权。
