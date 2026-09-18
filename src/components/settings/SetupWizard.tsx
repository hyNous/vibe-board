import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConfigStore } from '../../stores/configStore'
import {
  detectTools,
  getAllHookStatus,
  getConfig,
  installAgentHook,
  isTauri,
  setLaunchAtLogin as persistLaunchAtLogin,
  uninstallAgentHook,
  updateConfig as updateBackendConfig,
} from '../../services/tauriApi'
import type { BackendConfig, DetectedTool, HookStatus } from '../../services/tauriApi'
import { GlassButton } from '../shared'
import { PlatformIcon } from '../platform/PlatformIcon'

type WizardStep = 'welcome' | 'agents' | 'options' | 'applying' | 'done'

const HOST_AGENT_IDS = new Set(['codex', 'claude-code', 'opencode', 'antigravity'])

function readableError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message)
  }
  return String(error)
}

function defaultHost(tools: DetectedTool[]): string | null {
  return tools.find((tool) => HOST_AGENT_IDS.has(tool.name) && tool.status === 'Available')?.name ?? null
}

function hookStatusFor(statuses: HookStatus[], agent: string): HookStatus | undefined {
  return statuses.find((status) =>
    status.toolId === agent || status.adapterId === agent || status.name === agent,
  )
}

interface SetupWizardProps {
  onClose: () => void
}

export function SetupWizard({ onClose }: SetupWizardProps) {
  const { i18n } = useTranslation()
  const config = useConfigStore()
  const zh = i18n.language.startsWith('zh')
  const text = (zhText: string, enText: string) => (zh ? zhText : enText)
  const [step, setStep] = useState<WizardStep>('welcome')
  const [tools, setTools] = useState<DetectedTool[]>([])
  const [loadingTools, setLoadingTools] = useState(true)
  const [hostAgent, setHostAgent] = useState<string | null>(config.hostAgent)
  const [childAgents, setChildAgents] = useState<string[]>(config.childAgents)
  const [autoStartOnHostSession, setAutoStartOnHostSession] = useState(config.autoStartOnHostSession)
  const [launchAtLogin, setLaunchAtLogin] = useState(config.launchAtLogin)
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [completedConfig, setCompletedConfig] = useState<BackendConfig | null>(null)

  useEffect(() => {
    let cancelled = false
    detectTools()
      .then((detected) => {
        if (cancelled) return
        setTools(detected)
        const availableIds = new Set(
          detected.filter((tool) => tool.status === 'Available').map((tool) => tool.name),
        )
        setHostAgent((current) => availableIds.has(current ?? '') ? current : defaultHost(detected))
        setChildAgents((current) => current.filter((agent) => availableIds.has(agent)))
      })
      .catch((reason) => {
        if (!cancelled) setError(readableError(reason))
      })
      .finally(() => {
        if (!cancelled) setLoadingTools(false)
      })
    return () => { cancelled = true }
  }, [])

  const availableTools = useMemo(
    () => tools.filter((tool) => tool.status === 'Available'),
    [tools],
  )
  const missingCliTools = useMemo(
    () => tools.filter((tool) => tool.status === 'Installed'),
    [tools],
  )
  const hostTools = useMemo(
    () => availableTools.filter((tool) => HOST_AGENT_IDS.has(tool.name)),
    [availableTools],
  )
  const childToolOptions = useMemo(
    () => availableTools.filter((tool) => tool.name !== hostAgent),
    [availableTools, hostAgent],
  )

  const toggleChild = (agent: string) => {
    setChildAgents((current) => current.includes(agent)
      ? current.filter((candidate) => candidate !== agent)
      : [...current, agent])
  }

  const finishWithoutSetup = async () => {
    setError(null)
    try {
      if (isTauri()) {
        const backend = await getConfig()
        await updateBackendConfig({ ...backend, setupWizardCompleted: true })
      }
      config.updateConfig('setupWizardCompleted', true)
      onClose()
    } catch (reason) {
      setError(readableError(reason))
    }
  }

  const applySetup = async () => {
    setStep('applying')
    setError(null)
    setWarnings([])
    setCompletedConfig(null)
    try {
      const selectedChildren = childAgents.filter((agent) => agent !== hostAgent)
      const selectedAgents = [hostAgent, ...selectedChildren].filter(
        (agent): agent is string => Boolean(agent),
      )
      const backend = await getConfig()
      const setupWarnings: string[] = []
      let effectiveLaunchAtLogin = launchAtLogin
      if (launchAtLogin !== backend.launchAtLogin) {
        try {
          await persistLaunchAtLogin(launchAtLogin)
        } catch (reason) {
          effectiveLaunchAtLogin = backend.launchAtLogin
          setupWarnings.push(text(
            `Windows 登录启动设置失败：${readableError(reason)}`,
            `Could not update Windows startup: ${readableError(reason)}`,
          ))
        }
      }
      const nextConfig = {
        ...backend,
        setupWizardCompleted: false,
        hostAgent,
        childAgents: selectedChildren,
        autoStartOnHostSession,
        launchAtLogin: effectiveLaunchAtLogin,
      }

      await updateBackendConfig(nextConfig)

      if (isTauri()) {
        const previousAgents = [backend.hostAgent, ...(backend.childAgents ?? [])].filter(
          (agent): agent is string => Boolean(agent),
        )
        for (const agent of previousAgents.filter((agent) => !selectedAgents.includes(agent))) {
          try {
            await uninstallAgentHook(agent)
          } catch (reason) {
            setupWarnings.push(text(
              `旧 Agent ${agent} 的 Hook 清理失败：${readableError(reason)}`,
              `Could not remove the old ${agent} hook: ${readableError(reason)}`,
            ))
          }
        }
        for (const agent of selectedAgents) {
          try {
            await installAgentHook(agent)
          } catch (reason) {
            setupWarnings.push(text(
              `${agent} 的 Hook 暂未安装：${readableError(reason)}`,
              `The ${agent} hook was not installed: ${readableError(reason)}`,
            ))
          }
        }
        try {
          const statuses = selectedAgents.length > 0 ? await getAllHookStatus() : []
          const notInstalled = selectedAgents.filter((agent) => {
            const status = hookStatusFor(statuses, agent)
            return !status || (!status.installed && status.installStatus !== 'installed')
          })
          if (notInstalled.length > 0) {
            setupWarnings.push(text(
              `以下 Agent 的 Hook 需要稍后处理：${notInstalled.join('、')}`,
              `Hooks still need attention for: ${notInstalled.join(', ')}`,
            ))
          }
        } catch (reason) {
          setupWarnings.push(text(
            `Hook 状态暂时无法读取：${readableError(reason)}`,
            `Hook status could not be checked yet: ${readableError(reason)}`,
          ))
        }
      }

      setWarnings(setupWarnings)
      setCompletedConfig({ ...nextConfig, setupWizardCompleted: true })
      config.updateConfig('hostAgent', hostAgent)
      config.updateConfig('childAgents', selectedChildren)
      config.updateConfig('autoStartOnHostSession', autoStartOnHostSession)
      config.updateConfig('launchAtLogin', effectiveLaunchAtLogin)
      setStep('done')
    } catch (reason) {
      setError(readableError(reason))
      setStep('options')
    }
  }

  const finishSetup = async () => {
    setError(null)
    try {
      if (completedConfig) await updateBackendConfig(completedConfig)
      config.updateConfig('setupWizardCompleted', true)
      onClose()
    } catch (reason) {
      setError(readableError(reason))
    }
  }

  const statusLabel = (status: DetectedTool['status']) => {
    if (status === 'Active') return text('运行中', 'Running')
    if (status === 'Installed') return text('发现配置，但缺少 CLI', 'Config found, CLI missing')
    if (status === 'Available') return text('可用', 'Available')
    return text('未找到', 'Not found')
  }

  return (
    <div className="setup-wizard" role="dialog" aria-labelledby="setup-wizard-title">
      <div className="setup-wizard__panel">
        <button className="setup-wizard__close" type="button" onClick={onClose} aria-label={text('关闭', 'Close')}>×</button>
        <div className="setup-wizard__brand">
          <span className="setup-wizard__brand-mark">AI</span>
          <span>Vibe Board</span>
        </div>
        <div className="setup-wizard__progress" aria-label={text('设置进度', 'Setup progress')}>
          {(['welcome', 'agents', 'options', 'done'] as const).map((item, index) => (
            <span key={item} className={step === item || (step === 'applying' && item === 'options') ? 'is-active' : index < ['welcome', 'agents', 'options', 'done'].indexOf(step) ? 'is-complete' : ''} />
          ))}
        </div>

        {step === 'welcome' && (
          <div className="setup-wizard__content">
            <div className="setup-wizard__hero-icon">✦</div>
            <p className="setup-wizard__eyebrow">{text('首次设置', 'FIRST-TIME SETUP')}</p>
            <h1 id="setup-wizard-title">{text('让 Vibe Board 跟着你的 Agent 工作', 'Connect Vibe Board to your Agents')}</h1>
            <p className="setup-wizard__lead">
              {text(
                '向导会读取本机已安装的 Agent，帮助你选择一个宿主 Agent 和可选的子 Agent，然后安装本地 Hook，让任务状态能自动同步到桌面。',
                'This wizard finds Agents installed on this computer, lets you choose a host and optional child Agents, then installs local hooks so task state can reach the desktop automatically.',
              )}
            </p>
            <div className="setup-wizard__trust-list">
              <div><strong>✓</strong>{text('只修改你确认的 Agent 配置', 'Only Agent configurations you approve are changed')}</div>
              <div><strong>✓</strong>{text('不上传凭据、提示词或项目文件', 'Credentials, prompts, and project files stay local')}</div>
              <div><strong>✓</strong>{text('随时可在设置中重新配置或卸载 Hook', 'You can reconfigure or remove hooks from Settings')}</div>
            </div>
            <div className="setup-wizard__actions">
              <GlassButton variant="ghost" onClick={finishWithoutSetup}>{text('稍后设置', 'Set up later')}</GlassButton>
              <GlassButton variant="primary" onClick={() => setStep('agents')}>{text('开始检测', 'Start detection')} <span aria-hidden="true">→</span></GlassButton>
            </div>
          </div>
        )}

        {step === 'agents' && (
          <div className="setup-wizard__content">
            <p className="setup-wizard__eyebrow">01 / 02</p>
            <h1>{text('选择宿主与子 Agent', 'Choose a host and child Agents')}</h1>
            <p className="setup-wizard__lead">
              {text('宿主 Agent 的 SessionStart 会唤醒 Vibe Board；子 Agent 只同步任务状态，不会负责启动组件。', 'The host Agent wakes Vibe Board on SessionStart. Child Agents are monitored but do not start the component.')}
            </p>
            {loadingTools ? (
              <div className="setup-wizard__loading">{text('正在读取本机 Agent…', 'Scanning local Agents…')}</div>
            ) : (
              <>
                {missingCliTools.length > 0 && (
                  <div className="setup-wizard__warning" role="status">
                    <strong>{text('发现配置目录，但没有找到可执行 CLI', 'Configuration found, but the CLI is missing')}</strong>
                    <p>{text('这些 Agent 暂时不能安装 Hook。请先安装对应 CLI，完全退出并重新打开 Vibe Board，再回到这里重新检测。', 'These Agents cannot receive hooks yet. Install the CLI, fully quit and reopen Vibe Board, then run detection again.')}</p>
                    <ul>
                      {missingCliTools.map((tool) => (
                        <li key={tool.name}>
                          <strong>{tool.displayName}</strong>{'：'}
                          {tool.name === 'antigravity'
                            ? text('安装 Antigravity CLI；Windows 可运行 irm https://antigravity.google/cli/install.ps1 | iex，启动命令是 agy', 'Install the Antigravity CLI; on Windows run irm https://antigravity.google/cli/install.ps1 | iex, then launch it with agy')
                            : tool.name === 'gemini'
                              ? text('运行 npm install -g @google/gemini-cli', 'Run npm install -g @google/gemini-cli')
                              : text('请安装对应的 CLI', 'Install the corresponding CLI')}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="setup-wizard__section-label">{text('宿主 Agent（单选）', 'Host Agent (choose one)')}</div>
                <div className="setup-wizard__agent-list">
                  {hostTools.map((tool) => (
                    <label className={`setup-wizard__agent-card ${hostAgent === tool.name ? 'is-selected' : ''}`} key={tool.name}>
                      <input
                        type="radio"
                        name="vibe-board-host"
                        value={tool.name}
                        checked={hostAgent === tool.name}
                        onChange={() => {
                          setHostAgent(tool.name)
                          setChildAgents((current) => current.filter((agent) => agent !== tool.name))
                        }}
                      />
                      <PlatformIcon agentId={tool.name} displayName={tool.displayName} size={30} />
                      <span className="setup-wizard__agent-copy"><strong>{tool.displayName}</strong><small>{statusLabel(tool.status)}</small></span>
                    </label>
                  ))}
                </div>
                {hostTools.length === 0 && (
                  <div className="setup-wizard__empty">
                    {text('没有发现可作为宿主的 Codex、Claude Code、OpenCode 或 Antigravity。你可以稍后安装 Agent，再从设置重新运行向导。', 'No supported host Agent (Codex, Claude Code, OpenCode, or Antigravity) was found. Install one later and rerun this wizard from Settings.')}
                  </div>
                )}
                {childToolOptions.length > 0 && (
                  <>
                    <div className="setup-wizard__section-label">{text('子 Agent（可多选）', 'Child Agents (optional)')}</div>
                    <div className="setup-wizard__agent-list setup-wizard__agent-list--children">
                      {childToolOptions.map((tool) => (
                        <label className={`setup-wizard__agent-card ${childAgents.includes(tool.name) ? 'is-selected' : ''}`} key={tool.name}>
                          <input type="checkbox" checked={childAgents.includes(tool.name)} onChange={() => toggleChild(tool.name)} />
                          <PlatformIcon agentId={tool.name} displayName={tool.displayName} size={30} />
                          <span className="setup-wizard__agent-copy"><strong>{tool.displayName}</strong><small>{statusLabel(tool.status)}</small></span>
                        </label>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
            <div className="setup-wizard__actions">
              <GlassButton variant="ghost" onClick={() => setStep('welcome')}>{text('返回', 'Back')}</GlassButton>
              <GlassButton variant="primary" disabled={loadingTools || (hostTools.length > 0 && !hostAgent)} onClick={() => setStep('options')}>{text('下一步', 'Continue')} <span aria-hidden="true">→</span></GlassButton>
            </div>
          </div>
        )}

        {step === 'options' && (
          <div className="setup-wizard__content">
            <p className="setup-wizard__eyebrow">02 / 02</p>
            <h1>{text('确认自动化方式', 'Confirm automation')}</h1>
            <p className="setup-wizard__lead">
              {text('确认后，Vibe Board 会安装选中的 Hook，并立即重新读取状态验证配置。', 'After you confirm, Vibe Board installs the selected hooks and immediately rereads their status to verify the setup.')}
            </p>
            <div className="setup-wizard__options">
              <label className="setup-wizard__option">
                <input type="checkbox" checked={autoStartOnHostSession} onChange={(event) => setAutoStartOnHostSession(event.target.checked)} />
                <span><strong>{text('宿主启动时自动打开 Vibe Board', 'Start Vibe Board with the host')}</strong><small>{text('宿主 Agent 新建会话时自动唤醒桌面组件。', 'Wake the desktop component when the host starts a new session.')}</small></span>
              </label>
              <label className="setup-wizard__option">
                <input type="checkbox" checked={launchAtLogin} onChange={(event) => setLaunchAtLogin(event.target.checked)} />
                <span><strong>{text('登录 Windows 时启动 Vibe Board', 'Start Vibe Board at Windows login')}</strong><small>{text('适合希望组件常驻托盘、等待宿主会话的情况。', 'Useful when you want the component ready in the tray before a host session starts.')}</small></span>
              </label>
            </div>
            {hostAgent && <div className="setup-wizard__selection-summary"><span>{text('宿主', 'Host')}</span><strong>{tools.find((tool) => tool.name === hostAgent)?.displayName ?? hostAgent}</strong><span>{text('子 Agent', 'Children')}</span><strong>{childAgents.length || text('未选择', 'None')}</strong></div>}
            {error && <div className="setup-wizard__error" role="alert">{error}</div>}
            <div className="setup-wizard__actions">
              <GlassButton variant="ghost" onClick={() => setStep('agents')}>{text('返回', 'Back')}</GlassButton>
              <GlassButton variant="primary" onClick={applySetup}>{text('批准并完成设置', 'Approve & finish')} <span aria-hidden="true">✓</span></GlassButton>
            </div>
          </div>
        )}

        {step === 'applying' && (
          <div className="setup-wizard__content setup-wizard__content--centered">
            <div className="setup-wizard__spinner" aria-hidden="true" />
            <h1>{text('正在完成配置…', 'Applying setup…')}</h1>
            <p className="setup-wizard__lead">{text('正在安装 Hook、保存宿主选择并校验连接，请稍候。', 'Installing hooks, saving your host choice, and checking the connection.')}</p>
          </div>
        )}

        {step === 'done' && (
          <div className="setup-wizard__content setup-wizard__content--centered">
            <div className="setup-wizard__success">✓</div>
            <p className="setup-wizard__eyebrow">READY</p>
            <h1>{text('配置完成', 'You are ready')}</h1>
            <p className="setup-wizard__lead">{text('以后打开宿主 Agent 的新会话时，Vibe Board 会自动连接。你仍可以在设置 → 通用中重新配置宿主和子 Agent。', 'New sessions from the host Agent will now connect automatically. You can change the host and child Agents later in Settings → General.')}</p>
            {error && <div className="setup-wizard__error" role="alert">{error}</div>}
            {warnings.length > 0 && (
              <div className="setup-wizard__warning" role="status">
                <strong>{text('部分连接需要稍后处理', 'Some connections need attention')}</strong>
                <ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
              </div>
            )}
            <div className="setup-wizard__actions setup-wizard__actions--centered">
              <GlassButton variant="primary" onClick={finishSetup}>{text('进入设置', 'Open Settings')} <span aria-hidden="true">→</span></GlassButton>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
