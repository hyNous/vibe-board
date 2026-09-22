# External Agent Setup

这是外部 CLI Agent 的产品化安装入口。它让用户的主 Agent 通过交互完成检测、选择、预览、确认和命名 Skill 生成；不会自动安装 CLI、读取或写入 API key，也不会修改全局 `AGENTS.md`。

## 普通安装

```powershell
npx skills add <your-repository> --skill external-agent-core --skill external-agent-setup
```

在同一个 skills 根目录安装 `external-agent-core`，然后调用 `$external-agent-setup`。配置完成后，向导会生成可直接调用的命名 Skill，例如 `$my-kimi-agent`。

## CLI

```powershell
node scripts/setup-agent.mjs --detect
node scripts/setup-agent.mjs --plan --provider opencode --skill-name opencode-agent
node scripts/setup-agent.mjs --apply --confirm --provider opencode --skill-name opencode-agent
node scripts/setup-agent.mjs --plan --provider my-cli --skill-name my-cli-agent --profile-file C:\path\provider.json
```

`--plan` 只读；`--apply` 必须同时带 `--confirm`。目标目录已存在时默认拒绝覆盖；只有用户明确要求时才使用 `--force`，且只更新向导生成的已知文件，不删除其他文件。

## 适配新 CLI

复制 `profiles/provider.template.json`，只填写非敏感的 CLI 协议信息。若 CLI 的传输和结果格式属于通用类型，无需编写新的 runner；只有特殊事件协议才需要增加 parser。安装器会生成 `providers.json`、`SKILL.md`、`README.md`、`agents/openai.yaml` 和 runner wrapper。

安装器不会替用户决定模型、权限、数据边界或是否执行真实任务。它只负责把已确认的协议配置写成命名 Skill。

标准 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 环境变量会由检测和执行 runner 继承，不需要写入 profile 或 Skill 文件；没有配置代理的环境不受影响。
