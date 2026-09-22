import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConfigStore } from '../../stores/configStore'
import {
  detectTools,
  getAllHookStatus,
  getConfig,
  installAgentHook,
  isTauri,
  openTutorialWindow,
  setLaunchAtLogin as persistLaunchAtLogin,
  uninstallAgentHook,
  updateConfig as updateBackendConfig,
} from '../../services/tauriApi'
import type { BackendConfig, DetectedTool, HookStatus } from '../../services/tauriApi'
import { GlassButton } from '../shared'
import { PlatformIcon } from '../platform/PlatformIcon'

type WizardStep = 'welcome' | 'tutorial' | 'agents' | 'options' | 'applying' | 'done'

const WIZARD_PROGRESS_STEPS = ['welcome', 'tutorial', 'agents', 'options', 'done'] as const

function progressIndex(step: WizardStep): number {
  if (step === 'applying') return WIZARD_PROGRESS_STEPS.indexOf('options')
  return WIZARD_PROGRESS_STEPS.indexOf(step)
}

/** Small animated figures for the four tutorial themes shown inside the wizard. */
function TopicFigure({ kind }: { kind: 'island' | 'board' | 'click' | 'agents' }) {
  if (kind === 'island') {
    return (
      <svg className="setup-wizard__topic-svg" viewBox="0 0 48 48" aria-hidden="true">
        <rect className="wz-island-shell" x="10" y="10" width="28" height="11" rx="5.5" />
        <circle className="wz-island-dot" cx="16" cy="15.5" r="2" />
        <rect className="wz-island-card" x="12" y="28" width="24" height="6" rx="3" />
        <rect className="wz-island-card wz-island-card--late" x="12" y="37" width="24" height="6" rx="3" />
      </svg>
    )
  }
  if (kind === 'board') {
    return (
      <svg className="setup-wizard__topic-svg" viewBox="0 0 48 48" aria-hidden="true">
        <rect className="wz-board-row" x="8" y="9" width="32" height="9" rx="4.5" />
        <circle className="wz-board-dot wz-board-dot--wait" cx="14" cy="13.5" r="2" />
        <rect className="wz-board-line" x="20" y="11.5" width="16" height="4" rx="2" />
        <rect className="wz-board-row" x="8" y="20" width="32" height="9" rx="4.5" />
        <circle className="wz-board-dot wz-board-dot--run" cx="14" cy="24.5" r="2" />
        <rect className="wz-board-line" x="20" y="22.5" width="16" height="4" rx="2" />
        <rect className="wz-board-row" x="8" y="31" width="32" height="9" rx="4.5" />
        <circle className="wz-board-dot wz-board-dot--done" cx="14" cy="35.5" r="2" />
        <rect className="wz-board-line" x="20" y="33.5" width="16" height="4" rx="2" />
      </svg>
    )
  }
  if (kind === 'click') {
    return (
      <svg className="setup-wizard__topic-svg" viewBox="0 0 48 48" aria-hidden="true">
        <rect className="wz-click-card" x="6" y="16" width="17" height="14" rx="4" />
        <path className="wz-click-arrow" d="M26 23 H38" />
        <path className="wz-click-arrow-head" d="M36 19 L41 23 L36 27" />
        <rect className="wz-click-window" x="28" y="8" width="16" height="30" rx="4" />
        <path className="wz-click-window-bar" d="M28 14 H44" />
      </svg>
    )
  }
  return (
    <svg className="setup-wizard__topic-svg" viewBox="0 0 48 48" aria-hidden="true">
      <circle className="wz-agents-agent" cx="11" cy="15" r="5" />
      <circle className="wz-agents-agent wz-agents-agent--late" cx="11" cy="33" r="5" />
      <circle className="wz-agents-island" cx="37" cy="24" r="6.5" />
      <path className="wz-agents-line" d="M16 15 C27 15 27 24 31 24" />
      <path className="wz-agents-line wz-agents-line--late" d="M16 33 C27 33 27 24 31 24" />
    </svg>
  )
}

function readableError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message)
  }
  return String(error)
}

function hookStatusFor(statuses: HookStatus[], agent: string): HookStatus | undefined {
  return statuses.find((status) =>
    status.toolId === agent || status.adapterId === agent || status.name === agent,
  )
}

function isHookInstalled(status: HookStatus | undefined): boolean {
  return Boolean(status && (status.installed || status.installStatus === 'installed'))
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
  const [selectedAgents, setSelectedAgents] = useState<string[]>([])
  const [launchAgents, setLaunchAgents] = useState<string[]>(config.autoLaunchAgents)
  const [launchAtLogin, setLaunchAtLogin] = useState(config.launchAtLogin)
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [completedConfig, setCompletedConfig] = useState<BackendConfig | null>(null)
  const [openingTutorial, setOpeningTutorial] = useState(false)

  useEffect(() => {
    let cancelled = false
    detectTools()
      .then(async (detected) => {
        if (cancelled) return
        setTools(detected)
        const availableIds = new Set(
          detected.filter((tool) => tool.status === 'Available').map((tool) => tool.name),
        )
        let statuses: HookStatus[] = []
        try {
          statuses = await getAllHookStatus()
        } catch {
          statuses = []
        }
        if (cancelled) return
        setSelectedAgents((current) => {
          const kept = current.filter((agent) => availableIds.has(agent))
          if (kept.length > 0) return kept
          return detected
            .filter((tool) => availableIds.has(tool.name))
            .filter((tool) => isHookInstalled(hookStatusFor(statuses, tool.name)))
            .map((tool) => tool.name)
        })
        setLaunchAgents((current) => current.filter((agent) => availableIds.has(agent)))
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

  const toggleAgent = (agent: string) => {
    if (selectedAgents.includes(agent)) {
      setSelectedAgents((current) => current.filter((candidate) => candidate !== agent))
      setLaunchAgents((current) => current.filter((candidate) => candidate !== agent))
      return
    }
    setSelectedAgents((current) => [...current, agent])
  }

  const toggleLaunch = (agent: string) => {
    setLaunchAgents((current) => current.includes(agent)
      ? current.filter((candidate) => candidate !== agent)
      : [...current, agent])
  }

  const openFullTutorial = async () => {
    setError(null)
    setOpeningTutorial(true)
    try {
      await openTutorialWindow()
    } catch (reason) {
      setError(readableError(reason))
    } finally {
      setOpeningTutorial(false)
    }
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
        autoLaunchAgents: launchAgents.filter((agent) => selectedAgents.includes(agent)),
        launchAtLogin: effectiveLaunchAtLogin,
      }

      await updateBackendConfig(nextConfig)

      if (isTauri()) {
        let previousStatuses: HookStatus[] = []
        try {
          previousStatuses = await getAllHookStatus()
        } catch {
          previousStatuses = []
        }
        const previouslyInstalled = tools
          .filter((tool) => isHookInstalled(hookStatusFor(previousStatuses, tool.name)))
          .map((tool) => tool.name)
        for (const agent of previouslyInstalled.filter((agent) => !selectedAgents.includes(agent))) {
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
            return !isHookInstalled(hookStatusFor(statuses, agent))
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
      config.updateConfig('autoLaunchAgents', nextConfig.autoLaunchAgents)
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
          {WIZARD_PROGRESS_STEPS.map((item, index) => (
            <span key={item} className={index === progressIndex(step) ? 'is-active' : index < progressIndex(step) ? 'is-complete' : ''} />
          ))}
        </div>

        {step === 'welcome' && (
          <div className="setup-wizard__content">
            <div className="setup-wizard__hero-icon">✦</div>
            <p className="setup-wizard__eyebrow">{text('首次设置', 'FIRST-TIME SETUP')}</p>
            <h1 id="setup-wizard-title">{text('让 Vibe Board 跟着你的 Agent 工作', 'Connect Vibe Board to your Agents')}</h1>
            <p className="setup-wizard__lead">
              {text(
                '向导会读取本机已安装的 Agent，帮助你选择要接入的 Agent 并安装本地 Hook，让任务状态能自动同步到桌面。',
                'This wizard finds Agents installed on this computer, lets you choose which ones to connect, then installs local hooks so task state can reach the desktop automatically.',
              )}
            </p>
            <div className="setup-wizard__trust-list">
              <div><strong>✓</strong>{text('只修改你确认的 Agent 配置', 'Only Agent configurations you approve are changed')}</div>
              <div><strong>✓</strong>{text('不上传凭据、提示词或项目文件', 'Credentials, prompts, and project files stay local')}</div>
              <div><strong>✓</strong>{text('随时可在设置中重新配置或卸载 Hook', 'You can reconfigure or remove hooks from Settings')}</div>
            </div>
            <div className="setup-wizard__actions">
              <GlassButton variant="ghost" onClick={finishWithoutSetup}>{text('稍后设置', 'Set up later')}</GlassButton>
              <GlassButton variant="primary" onClick={() => setStep('tutorial')}>{text('继续', 'Continue')} <span aria-hidden="true">→</span></GlassButton>
            </div>
          </div>
        )}

        {step === 'tutorial' && (
          <div className="setup-wizard__content">
            <p className="setup-wizard__eyebrow">01 / 03</p>
            <h1>{text('先花一分钟看懂看板', 'Take a minute to read the board')}</h1>
            <p className="setup-wizard__lead">
              {text(
                '四个主题，都是看板真实会做的事。完整教程还包含 Skill 管理与使用额度两节。',
                'Four themes, all things the board really does. The full tutorial also covers Skill management and usage.',
              )}
            </p>
            <div className="setup-wizard__topics">
              <article className="setup-wizard__topic">
                <TopicFigure kind="island" />
                <div>
                  <strong>{text('岛怎么用', 'Using the island')}</strong>
                  <p>{text('默认停在屏幕顶部：悬停或点击展开，移开自动收起，Esc 逐级收回；快捷键与挂靠位置都能在设置里改。', 'It sits at the top of the screen: hover or click to expand, move away to collapse, Esc steps back. Shortcuts and docking are configurable.')}</p>
                </div>
              </article>
              <article className="setup-wizard__topic">
                <TopicFigure kind="board" />
                <div>
                  <strong>{text('看板在显示什么', 'What the board shows')}</strong>
                  <p>{text('当前会话按优先级排序，每张任务卡有状态点、Agent 名称、会话标题和状态；Hook 自检有问题时右上角才出现健康指示。', 'Current sessions sorted by priority; each card shows a status dot, Agent name, session title, and state. The hook health indicator appears only when a self-check fails.')}</p>
                </div>
              </article>
              <article className="setup-wizard__topic">
                <TopicFigure kind="click" />
                <div>
                  <strong>{text('点任务会发生什么', 'What a task click does')}</strong>
                  <p>{text('桌面版 Agent 会被唤回前台；纯命令行会话没有可唤起的窗口，只提示手动打开 CLI。看板不会替你回复或批准。', 'Desktop Agents are brought back to the front; CLI-only sessions have no window to raise, so it just asks you to open the CLI. The board never replies or approves for you.')}</p>
                </div>
              </article>
              <article className="setup-wizard__topic">
                <TopicFigure kind="agents" />
                <div>
                  <strong>{text('Agent 接入', 'Connecting Agents')}</strong>
                  <p>{text('下一步会检测本机 Agent 并安装本地 Hook；「会话开始时拉起看板」开关默认关闭，桌面版 Agent 可能不触发。', 'The next step detects local Agents and installs their hooks. The “start the board on session start” switch is off by default, and desktop Agents may not trigger it.')}</p>
                </div>
              </article>
            </div>
            {error && <div className="setup-wizard__error" role="alert">{error}</div>}
            <div className="setup-wizard__actions">
              <GlassButton variant="ghost" onClick={() => setStep('welcome')}>{text('返回', 'Back')}</GlassButton>
              <div className="setup-wizard__actions-right">
                <GlassButton variant="secondary" onClick={() => void openFullTutorial()} disabled={openingTutorial}>
                  {openingTutorial ? text('正在打开…', 'Opening…') : text('打开完整教程', 'Open full tutorial')}
                </GlassButton>
                <GlassButton variant="primary" onClick={() => setStep('agents')}>{text('开始检测', 'Start detection')} <span aria-hidden="true">→</span></GlassButton>
              </div>
            </div>
          </div>
        )}

        {step === 'agents' && (
          <div className="setup-wizard__content">
            <p className="setup-wizard__eyebrow">02 / 03</p>
            <h1>{text('选择要接入的 Agent', 'Choose the Agents to connect')}</h1>
            <p className="setup-wizard__lead">
              {text('勾选要接入的 Agent，Vibe Board 会为它们安装本地 Hook。每个 Agent 可以单独决定是否在会话开始时拉起看板。', 'Pick the Agents to connect; Vibe Board installs their local hooks. Each Agent can separately start Vibe Board when its session begins.')}
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
                <div className="setup-wizard__section-label">{text('要接入的 Agent（可多选）', 'Agents to connect (multi-select)')}</div>
                <div className="setup-wizard__agent-list">
                  {availableTools.map((tool) => {
                    const selected = selectedAgents.includes(tool.name)
                    const launch = launchAgents.includes(tool.name)
                    return (
                      <div className={`setup-wizard__agent-card ${selected ? 'is-selected' : ''}`} key={tool.name}>
                        <label className="setup-wizard__agent-select">
                          <input type="checkbox" checked={selected} onChange={() => toggleAgent(tool.name)} />
                          <PlatformIcon agentId={tool.name} displayName={tool.displayName} size={30} />
                          <span className="setup-wizard__agent-copy"><strong>{tool.displayName}</strong><small>{statusLabel(tool.status)}</small></span>
                        </label>
                        <label className={`setup-wizard__agent-launch ${selected ? '' : 'is-disabled'}`}>
                          <input type="checkbox" checked={launch} disabled={!selected} onChange={() => toggleLaunch(tool.name)} />
                          <span>{text('会话开始时拉起看板', 'Start Vibe Board on session start')}</span>
                        </label>
                      </div>
                    )
                  })}
                </div>
                {availableTools.length === 0 && (
                  <div className="setup-wizard__empty">
                    {text('没有发现可接入的 Agent。你可以稍后安装 Agent，再从设置重新运行向导。', 'No connectable Agent was found. Install one later and rerun this wizard from Settings.')}
                  </div>
                )}
                <p className="setup-wizard__note">
                  {text('注意：桌面版 Agent 可能不触发「会话开始」事件，为它们打开此开关可能不生效。', 'Note: desktop Agents may not emit session-start events, so this switch may have no effect for them.')}
                </p>
              </>
            )}
            <div className="setup-wizard__actions">
              <GlassButton variant="ghost" onClick={() => setStep('welcome')}>{text('返回', 'Back')}</GlassButton>
              <GlassButton variant="primary" disabled={loadingTools} onClick={() => setStep('options')}>{text('下一步', 'Continue')} <span aria-hidden="true">→</span></GlassButton>
            </div>
          </div>
        )}

        {step === 'options' && (
          <div className="setup-wizard__content">
            <p className="setup-wizard__eyebrow">03 / 03</p>
            <h1>{text('确认自动化方式', 'Confirm automation')}</h1>
            <p className="setup-wizard__lead">
              {text('确认后，Vibe Board 会安装选中的 Hook，并立即重新读取状态验证配置。', 'After you confirm, Vibe Board installs the selected hooks and immediately rereads their status to verify the setup.')}
            </p>
            <div className="setup-wizard__options">
              <label className="setup-wizard__option">
                <input type="checkbox" checked={launchAtLogin} onChange={(event) => setLaunchAtLogin(event.target.checked)} />
                <span><strong>{text('登录 Windows 时启动 Vibe Board', 'Start Vibe Board at Windows login')}</strong><small>{text('适合希望组件常驻托盘、等待会话的情况。', 'Useful when you want the component ready in the tray before a session starts.')}</small></span>
              </label>
            </div>
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
            <p className="setup-wizard__lead">{text('正在安装 Hook 并保存设置，请稍候。', 'Installing hooks and saving your setup.')}</p>
          </div>
        )}

        {step === 'done' && (
          <div className="setup-wizard__content setup-wizard__content--centered">
            <div className="setup-wizard__success">✓</div>
            <p className="setup-wizard__eyebrow">READY</p>
            <h1>{text('配置完成', 'You are ready')}</h1>
            <p className="setup-wizard__lead">{text('接入的 Agent 会把任务状态同步到看板。你仍可以在设置 → 通用中重新配置要接入的 Agent。', 'Connected Agents now report task state to the board. You can change them later in Settings → General.')}</p>
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
