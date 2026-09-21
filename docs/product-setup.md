# Vibe Board 产品安装与首次设置说明

本文对应 Windows 首版安装包。正常用户不需要手动编辑 JSON、安装 Node.js，或执行插件注册命令。

## 安装后的标准流程

1. 运行安装包并启动 Vibe Board。
2. 首次启动进入“首次设置”向导。向导只读取本机 Agent 的可执行文件和常见配置目录，用于判断哪些 Agent 可连接。
3. 勾选要接入的 Agent（可多选）。Vibe Board 会为选中的 Agent 安装本地 Hook。
4. 按需逐个打开「会话开始时拉起看板」开关。开关默认关闭，由用户自己打开；桌面版 Agent 可能不触发「会话开始」事件，对它们打开此开关可能不生效。
5. 确认登录启动选项，点击“批准并完成设置”。
6. 向导安装已选择的 Hook，保存配置，并重新读取 Hook 状态进行校验。校验失败时会留在向导中显示错误，不会把失败状态标记为完成。

首次设置完成后，接入的 Agent 新会话会连接看板；只有用户为某个 Agent 打开拉起开关后，该 Agent 的会话开始才会尝试启动 Vibe Board。后续在 **Settings → General → Agent connection** 可以重新选择要接入的 Agent 或重新执行安装校验。

## 用户需要批准什么

批准后，应用可能会：

- 写入所选 Agent 的本地 Hook 配置；
- 写入 Vibe Board 自己的配置文件和桥接程序目录；
- 如果勾选登录启动，写入当前 Windows 用户的启动项。

不会上传凭据、提示词、项目文件或 Hook 原始输入。取消向导不会修改 Agent 配置；选择“稍后设置”后可以从托盘再次打开设置。

## 配置和迁移

- 应用配置：`%APPDATA%\vibeboard\config.json`（旧安装会从 `%APPDATA%\agent-island\config.json` 一次性迁移）
- Bridge：`%USERPROFILE%\.vibeboard\bin\vibe-board-bridge.exe`
- 运行数据：`%USERPROFILE%\.vibeboard\`，旧数据从 `%USERPROFILE%\.agent-island\` 和 `%USERPROFILE%\.agentbro\` 兼容读取或迁移
- Skill 中心：`%USERPROFILE%\.agents\skills\`

把安装包复制到另一台 Windows 电脑后，首次启动会在新电脑重新扫描和配置，不会依赖原电脑的绝对路径。用户需要在新电脑上重新批准 Agent Hook；已有账号凭据仍由对应 Agent 自己管理。

## 平台范围

当前产品化闭环按 Windows 首版验收。macOS 仍保留部分原生实现，但在没有真实 Mac 设备完成安装、权限、窗口和登录启动测试前，不应把 macOS 宣称为同等验收级别。
