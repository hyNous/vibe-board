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
import { SettingDetails } from './SettingDetails'

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
  const [warningDetails, setWarningDetails] = useState<string[]>([])
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
    setWarningDetails([])
    setCompletedConfig(null)
    try {
      const backend = await getConfig()
      const setupWarnings: string[] = []
      const setupWarningDetails: string[] = []
      let effectiveLaunchAtLogin = launchAtLogin
      if (launchAtLogin !== backend.launchAtLogin) {
        try {
          await persistLaunchAtLogin(launchAtLogin)
        } catch (reason) {
          effectiveLaunchAtLogin = backend.launchAtLogin
          setupWarnings.push(text(
            '开机启动没能设置成功，可以稍后在设置里再打开。',
            'Startup at login could not be set. You can turn it on later in Settings.',
          ))
          setupWarningDetails.push(`Could not update startup at login: ${readableError(reason)}`)
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
              `旧 Agent ${agent} 的连接没能清理干净。`,
              `Could not fully remove the old connection for ${agent}.`,
            ))
            setupWarningDetails.push(`Could not remove the old ${agent} hook: ${readableError(reason)}`)
          }
        }
        for (const agent of selectedAgents) {
          try {
            await installAgentHook(agent)
          } catch (reason) {
            setupWarnings.push(text(
              `${agent} 暂时没能接入，可以稍后在设置里重试。`,
              `${agent} could not be connected yet; try again later in Settings.`,
            ))
            setupWarningDetails.push(`The ${agent} hook was not installed: ${readableError(reason)}`)
          }
        }
        try {
          const statuses = selectedAgents.length > 0 ? await getAllHookStatus() : []
          const notInstalled = selectedAgents.filter((agent) => {
            return !isHookInstalled(hookStatusFor(statuses, agent))
          })
          if (notInstalled.length > 0) {
            setupWarnings.push(text(
              `这些 Agent 还需要再处理一次：${notInstalled.join('、')}`,
              `These Agents still need attention: ${notInstalled.join(', ')}`,
            ))
          }
        } catch (reason) {
          setupWarnings.push(text(
            '暂时无法确认接入结果，请重启 Vibe Board 后再看一次。',
            'Could not verify the connection yet. Restart Vibe Board and check again.',
          ))
          setupWarningDetails.push(`Hook status could not be checked yet: ${readableError(reason)}`)
        }
      }

      setWarnings(setupWarnings)
      setWarningDetails(setupWarningDetails)
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
    if (status === 'Installed') return text('有配置，但没有命令行程序', 'Config found, command-line program missing')
    if (status === 'Available') return text('可用', 'Available')
    return text('未找到', 'Not found')
  }

  return (
    <div className="setup-wizard" role="dialog" aria-labelledby="setup-wizard-title">
      <div className="setup-wizard__panel">
        <button className="setup-wizard__close" type="button" onClick={() => void finishWithoutSetup()} aria-label={text('关闭', 'Close')}>×</button>
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
            <h1 id="setup-wizard-title">{text('让 Vibe Board 跟着你的 Agent 一起工作', 'Connect Vibe Board to your Agents')}</h1>
            <p className="setup-wizard__lead">
              {text(
                '向导会找出这台电脑上已安装的 Agent。你选好要接入哪些，它们就会把任务状态同步到桌面看板。',
                'This wizard finds the Agents installed on this computer. Pick the ones to connect, and they will report their task status to the board.',
              )}
            </p>
            <div className="setup-wizard__trust-list">
              <div><strong>✓</strong>{text('只修改你确认的 Agent 配置', 'Only Agent configurations you approve are changed')}</div>
              <div><strong>✓</strong>{text('你的登录信息、提示词和项目文件都不会被上传', 'Credentials, prompts, and project files stay on this computer')}</div>
              <div><strong>✓</strong>{text('随时可以在设置里改接入哪些 Agent', 'You can change which Agents are connected at any time in Settings')}</div>
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
                '四张卡片，讲的都是看板真实会做的事。完整教程还包含 Skill 与使用额度两节。',
                'Four cards, all things the board really does. The full tutorial also covers Skills and usage.',
              )}
            </p>
            <div className="setup-wizard__topics">
              <article className="setup-wizard__topic">
                <TopicFigure kind="island" />
                <div>
                  <strong>{text('岛怎么用', 'Using the island')}</strong>
                  <p>{text('默认停在屏幕顶部：鼠标移上去或点一下就会展开，移开自动收起，按 Esc 逐级收回。快捷键和停靠位置都能在设置里改。', 'It sits at the top of the screen: hover or click to expand, move away to collapse, Esc steps back. Shortcuts and docking are configurable.')}</p>
                </div>
              </article>
              <article className="setup-wizard__topic">
                <TopicFigure kind="board" />
                <div>
                  <strong>{text('看板在显示什么', 'What the board shows')}</strong>
                  <p>{text('每张任务卡显示 Agent 名称、会话标题和当前状态；只有连接检查发现问题时，右上角才会出现警示图标。', 'Each card shows the Agent name, session title, and current state. A warning icon appears only when the connection check finds a problem.')}</p>
                </div>
              </article>
              <article className="setup-wizard__topic">
                <TopicFigure kind="click" />
                <div>
                  <strong>{text('点任务会发生什么', 'What a task click does')}</strong>
                  <p>{text('桌面版 Agent 的窗口会被调到前台；纯命令行的会话没有窗口可唤回，会提示你去终端查看。看板不会替你回复或批准。', 'Desktop Agent windows are brought to the front; CLI-only sessions have no window to raise, so it asks you to check the terminal. The board never replies or approves for you.')}</p>
                </div>
              </article>
              <article className="setup-wizard__topic">
                <TopicFigure kind="agents" />
                <div>
                  <strong>{text('Agent 接入', 'Connecting Agents')}</strong>
                  <p>{text('下一步会检测这台电脑上的 Agent，并让它们把任务状态同步过来；「会话开始时打开看板」默认关闭，桌面版 Agent 可能不会触发。', 'The next step detects the Agents on this computer and lets them report their task status. The “open the board on session start” switch is off by default, and desktop Agents may not trigger it.')}</p>
                </div>
              </article>
            </div>
            {error && (
              <div className="setup-wizard__error" role="alert">
                <div>{text('这一步没能完成，请稍后重试。', 'This step could not be completed. Please try again.')}</div>
                <SettingDetails testId="wizard-step-error-details">{error}</SettingDetails>
              </div>
            )}
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
              {text('勾选要接入的 Agent，它们就会把任务状态同步到看板。每个 Agent 还可以单独设置：会话开始时是否自动打开看板。', 'Pick the Agents to connect, and they will report their task status to the board. Each Agent can also start Vibe Board when its session begins.')}
            </p>
            {loadingTools ? (
              <div className="setup-wizard__loading">{text('正在读取本机 Agent…', 'Scanning local Agents…')}</div>
            ) : (
              <>
                {missingCliTools.length > 0 && (
                  <div className="setup-wizard__warning" role="status">
                    <strong>{text('找到了配置，但没有找到对应的命令行程序', 'Configuration found, but the command-line program is missing')}</strong>
                    <p>{text('这些 Agent 暂时不能接入。请先安装对应的命令行程序，完全退出并重新打开 Vibe Board，再回到这里重新检测。', 'These Agents cannot connect yet. Install the command-line program, fully quit and reopen Vibe Board, then run detection again.')}</p>
                    <ul>
                      {missingCliTools.map((tool) => (
                        <li key={tool.name}>
                          <strong>{tool.displayName}</strong>{'：'}
                          {tool.name === 'antigravity'
                            ? text('安装 Antigravity CLI；Windows 可运行 irm https://antigravity.google/cli/install.ps1 | iex，启动命令是 agy', 'Install the Antigravity CLI; on Windows run irm https://antigravity.google/cli/install.ps1 | iex, then launch it with agy')
                            : tool.name === 'gemini'
                              ? text('运行 npm install -g @google/gemini-cli', 'Run npm install -g @google/gemini-cli')
                              : text('请安装对应的命令行程序', 'Install the corresponding command-line program')}
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
                          <span>{text('会话开始时自动打开看板', 'Open the board when a session starts')}</span>
                        </label>
                      </div>
                    )
                  })}
                </div>
                {availableTools.length === 0 && (
                  <div className="setup-wizard__empty">
                    {text('没有发现可接入的 Agent。之后装好了，可以在设置里重新运行向导。', 'No connectable Agent was found. Install one later and rerun this wizard from Settings.')}
                  </div>
                )}
                <p className="setup-wizard__note">
                  {text('注意：桌面版 Agent 可能不会发出「会话开始」信号，为它们打开这个开关可能没有效果。', 'Note: desktop Agents may not emit session-start events, so this switch may have no effect for them.')}
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
            <h1>{text('确认后开始接入', 'Confirm and connect')}</h1>
            <p className="setup-wizard__lead">
              {text('点「开始接入」后，选中的 Agent 就会开始把任务状态同步到看板，Vibe Board 会立刻检查是否成功。', 'After you confirm, the selected Agents start reporting task status to the board, and Vibe Board checks right away whether it worked.')}
            </p>
            <div className="setup-wizard__options">
              <label className="setup-wizard__option">
                <input type="checkbox" checked={launchAtLogin} onChange={(event) => setLaunchAtLogin(event.target.checked)} />
                <span><strong>{text('登录电脑时自动打开 Vibe Board', 'Open Vibe Board when you log in')}</strong><small>{text('适合希望它一直在后台待命、随时接收任务状态的情况。', 'Useful when you want it ready in the background to receive task status at any time.')}</small></span>
              </label>
            </div>
            {error && (
              <div className="setup-wizard__error" role="alert">
                <div>{text('设置没能保存成功，请稍后重试。', 'Your setup could not be saved. Please try again.')}</div>
                <SettingDetails testId="wizard-save-error-details">{error}</SettingDetails>
              </div>
            )}
            <div className="setup-wizard__actions">
              <GlassButton variant="ghost" onClick={() => setStep('agents')}>{text('返回', 'Back')}</GlassButton>
              <GlassButton variant="primary" onClick={applySetup}>{text('开始接入', 'Connect')} <span aria-hidden="true">✓</span></GlassButton>
            </div>
          </div>
        )}

        {step === 'applying' && (
          <div className="setup-wizard__content setup-wizard__content--centered">
            <div className="setup-wizard__spinner" aria-hidden="true" />
            <h1>{text('正在接入…', 'Connecting…')}</h1>
            <p className="setup-wizard__lead">{text('正在保存设置并让 Agent 开始同步，请稍候。', 'Saving your setup and connecting the Agents.')}</p>
          </div>
        )}

        {step === 'done' && (
          <div className="setup-wizard__content setup-wizard__content--centered">
            <div className="setup-wizard__success">✓</div>
            <p className="setup-wizard__eyebrow">READY</p>
            <h1>{text('配置完成', 'You are ready')}</h1>
            <p className="setup-wizard__lead">{text('接入的 Agent 现在会把任务状态同步到看板。以后想改，可以在「设置 → 通用 → 选择要接入的 Agent」里调整。', 'Connected Agents now report their task status to the board. To change them later, open Settings → General → Choose Agents.')}</p>
            {error && (
              <div className="setup-wizard__error" role="alert">
                <div>{text('设置没能保存成功，请稍后重试。', 'Your setup could not be saved. Please try again.')}</div>
                <SettingDetails testId="wizard-error-details">{error}</SettingDetails>
              </div>
            )}
            {warnings.length > 0 && (
              <div className="setup-wizard__warning" role="status">
                <strong>{text('有几项需要稍后处理', 'A few things need attention')}</strong>
                <ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
                {warningDetails.length > 0 && (
                  <SettingDetails testId="wizard-warning-details">
                    <ul>{warningDetails.map((detail) => <li key={detail}>{detail}</li>)}</ul>
                  </SettingDetails>
                )}
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
