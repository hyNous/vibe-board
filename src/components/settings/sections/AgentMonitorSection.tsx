import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { MonitorSessionSummary } from '../../../services/monitorApi'
import { jumpToTerminal } from '../../../services/tauriApi'
import { selectSessionList, selectUsageSnapshots, useSessionStore } from '../../../stores/sessionStore'
import { useSettingsToast } from '../../../stores/settingsToastStore'
import { useSettingsLive } from '../../../stores/settingsLiveStore'
import type { RateLimitInfo, SessionState, TokenUsage, UsageRateWindow } from '../../../types/agent'
import { getSessionTaskDurationSeconds } from '../../../utils/sessionDisplay'
import { rateLimitWindows } from '../../../utils/rateLimitDisplay'
import { formatTokens } from '../../../utils/tokens'
import { SettingDetails } from '../SettingDetails'
import './AgentMonitorSection.css'

// 额度低于这个百分比时，在车道下方提醒一行。
const LOW_QUOTA_PERCENT = 25

// 拆分大小写拼不出来的产品名。
const AGENT_NAMES: Record<string, string> = {
  'claude-code': 'Claude',
  'gemini-cli': 'Gemini',
  'cursor-cli': 'Cursor CLI',
  opencode: 'OpenCode',
  codebuddy: 'CodeBuddy',
  codebuddycn: 'CodeBuddy',
  workbuddy: 'WorkBuddy',
  deepseek: 'DeepSeek',
}

function agentLabel(agentType: string, engineLabel?: string | null) {
  if (engineLabel && agentType === 'claude-code' && engineLabel !== 'Claude Code') return engineLabel
  if (AGENT_NAMES[agentType]) return AGENT_NAMES[agentType]
  return agentType
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

type Translate = (key: string, options?: { defaultValue?: string; count?: number }) => string

function phaseLabel(t: Translate, phase?: string) {
  switch (phase) {
    case 'starting':
    case 'running':
    case 'processing': return t('settings.tasksPage.phaseWorking', { defaultValue: '正在执行' })
    case 'waiting_input': return t('settings.tasksPage.phaseWaiting', { defaultValue: '等待你输入' })
    case 'blocked': return t('settings.tasksPage.phasePaused', { defaultValue: '已暂停' })
    case 'compacting': return t('settings.tasksPage.phaseCompacting', { defaultValue: '整理上下文' })
    case 'done':
    case 'completed': return t('settings.tasksPage.phaseDone', { defaultValue: '已完成' })
    case 'error':
    case 'failed':
    case 'failure': return t('settings.tasksPage.phaseError', { defaultValue: '出错了' })
    case 'interrupted': return t('settings.tasksPage.phaseStopped', { defaultValue: '已中断' })
    case 'cancelled': return t('settings.tasksPage.phaseCancelled', { defaultValue: '已取消' })
    case 'rate_limited': return t('settings.tasksPage.phaseRateLimited', { defaultValue: '额度用尽，等待恢复' })
    case 'unknown': return t('settings.tasksPage.phaseUnknown', { defaultValue: '状态未知' })
    case 'idle':
    default: return t('settings.tasksPage.phaseIdle', { defaultValue: '空闲' })
  }
}

function totalTokens(tokens: TokenUsage | undefined) {
  if (!tokens) return 0
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreate
}

// 车道中间的活动用等宽时钟显示已运行多久：3:47、12:08、1:02:03。
function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`
}

// 车道比 IPC 的会话摘要多带两条前端加工出来的信息：等待输入时的问题、
// 最近几步工具活动。它们都从已有的会话数据里读，不新增后端字段。
interface TaskLaneSession extends MonitorSessionSummary {
  question: string | null
  activity: string[]
}

function toolLine(name: string | null | undefined, target: string | null | undefined): string | null {
  const tool = name?.trim()
  if (!tool) return null
  const where = target?.trim()
  return where ? `${tool}: ${where}` : tool
}

function activityFromSession(session: SessionState): string[] {
  const lines: string[] = []
  const push = (line: string | null) => {
    if (line && !lines.includes(line)) lines.push(line)
  }
  session.activeTools
    .slice()
    .sort((a, b) => b.startedAt - a.startedAt)
    // 正在跑的工具就是最近一次工具时，只留带目标的那一行。
    .filter((tool) => tool.toolName !== session.lastToolName)
    .forEach((tool) => push(toolLine(tool.toolName, null)))
  push(toolLine(session.lastToolName, session.lastToolTarget))
  return lines.slice(0, 3)
}

// 等你输入时，Agent 提的问题记在 runState.currentAction；没有问题事件时这个字段
// 装的是最后一次工具调用，那种情况不能当成问题显示。
function questionFromSession(session: SessionState): string | null {
  if (session.phase !== 'waiting_input') return null
  const action = session.runState?.currentAction?.trim()
  const tool = toolLine(session.lastToolName, session.lastToolTarget)
  const text = action && action !== tool ? action : session.description?.trim()
  return text && text !== tool ? text : null
}

function summaryFromSession(session: SessionState): TaskLaneSession {
  return {
    id: session.id,
    agentType: session.agentType,
    engineLabel: session.engineLabel ?? null,
    project: session.project,
    cwd: session.cwd ?? '',
    terminal: session.terminal,
    phase: session.phase,
    startedAt: session.startedAt,
    duration: getSessionTaskDurationSeconds(session),
    tokenTotal: totalTokens(session.tokens),
    lastToolName: session.lastToolName ?? null,
    lastToolTarget: session.lastToolTarget ?? null,
    lastToolStatus: session.lastToolStatus ?? null,
    subagentCount: session.subagents.length,
    activeToolCount: session.activeTools.filter((tool) => tool.status === 'running').length,
    title: session.sessionTitle ?? null,
    question: questionFromSession(session),
    activity: activityFromSession(session),
  }
}

function remoteLaneSession(session: MonitorSessionSummary): TaskLaneSession {
  const line = toolLine(session.lastToolName, session.lastToolTarget)
  return { ...session, question: null, activity: line ? [line] : [] }
}

function windowRemainingPercent(window: UsageRateWindow): number | undefined {
  const raw = typeof window.remainingPercent === 'number' && Number.isFinite(window.remainingPercent)
    ? window.remainingPercent
    : typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent)
      ? 100 - window.usedPercent
      : undefined
  if (raw === undefined) return undefined
  return Math.max(0, Math.min(100, raw))
}

interface LowQuota { name: string; remaining: number; resetsAt: string | null }

function findLowQuota(snapshots: Record<string, RateLimitInfo>): LowQuota | null {
  let worst: LowQuota | null = null
  for (const [key, info] of Object.entries(snapshots)) {
    const name = info.providerLabel ?? info.provider ?? key
    for (const window of rateLimitWindows(info)) {
      const remaining = windowRemainingPercent(window)
      if (remaining === undefined || remaining >= LOW_QUOTA_PERCENT) continue
      if (!worst || remaining < worst.remaining) {
        worst = { name, remaining, resetsAt: window.resetsAt ?? null }
      }
    }
  }
  return worst
}

function formatResetAt(resetsAt: string | null): string {
  if (!resetsAt) return ''
  const date = new Date(resetsAt)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const LIVE_TASK_PHASES = new Set(['processing', 'compacting', 'waiting_input'])

interface AgentMonitorSectionProps {
  onOpenUsage?: () => void
}

export function AgentMonitorSection({ onOpenUsage }: AgentMonitorSectionProps) {
  const { t } = useTranslation()
  const showToast = useSettingsToast((state) => state.show)
  const liveSessions = useSessionStore(selectSessionList)
  const usageSnapshots = useSessionStore(selectUsageSnapshots)
  // 后台会话由设置窗口持续刷新（settingsLiveStore）；本窗口实时收到的会话在显示时直接合并，
  // 不用等下一次刷新。
  const remoteSessions = useSettingsLive((state) => state.monitorSessions)
  const monitorLoaded = useSettingsLive((state) => state.monitorLoaded)
  const monitorLoading = useSettingsLive((state) => state.monitorLoading)
  const error = useSettingsLive((state) => state.monitorError)
  const refreshMonitor = useSettingsLive((state) => state.refreshMonitor)
  const loading = monitorLoading || !monitorLoaded
  // 先显示已有结果，同时补一次刷新。
  useEffect(() => { void refreshMonitor() }, [refreshMonitor])
  const sessions = useMemo<TaskLaneSession[]>(() => Array.from(new Map(
    [...remoteSessions.map(remoteLaneSession), ...liveSessions.map(summaryFromSession)]
      .map((session) => [session.id, session] as const),
  ).values()), [remoteSessions, liveSessions])

  // 等你的那条排在最前面，其余按开始时间从新到旧。
  const liveTaskSessions = useMemo(() => sessions
    .filter((session) => LIVE_TASK_PHASES.has(session.phase))
    .sort((a, b) => {
      const aWait = a.phase === 'waiting_input' ? 1 : 0
      const bWait = b.phase === 'waiting_input' ? 1 : 0
      if (aWait !== bWait) return bWait - aWait
      return b.startedAt - a.startedAt
    }), [sessions])

  const waitingSession = liveTaskSessions.find((session) => session.phase === 'waiting_input')
  const lowQuota = useMemo(() => findLowQuota(usageSnapshots), [usageSnapshots])

  const recallTerminal = async (session: TaskLaneSession) => {
    const name = agentLabel(session.agentType, session.engineLabel)
    try {
      await jumpToTerminal(session.id)
      showToast(t('settings.tasksPage.recalled', { defaultValue: '已切到 {{name}} 所在的终端', name }))
    } catch (err) {
      console.warn('[settings] jumpToTerminal:', err)
      showToast(t('notch.activateAgentFailed', { defaultValue: '无法唤起 Agent，请手动查看执行进度' }))
    }
  }

  const refreshLabel = loading
    ? t('settings.refreshing', { defaultValue: '正在刷新…' })
    : t('settings.refresh', { defaultValue: '刷新' })

  return (
    <section className="agent-monitor">
      <header className="agent-monitor__head">
        <div>
          <h1>
            {liveTaskSessions.length > 0
              ? t('settings.tasksPage.headRunning', {
                defaultValue: '{{count}} 个 Agent 在干活',
                count: liveTaskSessions.length,
              }).replace('{{count}}', String(liveTaskSessions.length))
              : t('settings.tasksPage.headIdle', { defaultValue: '现在没有任务在跑' })}
          </h1>
          <p>
            {waitingSession ? (
              <>
                <b>
                  {t('settings.tasksPage.headWaiting', {
                    defaultValue: '{{name}} 在等你回答。',
                    name: agentLabel(waitingSession.agentType, waitingSession.engineLabel),
                  })}
                </b>
                {t('settings.tasksPage.headHint', { defaultValue: '点一条回到它的终端。' })}
              </>
            ) : t('settings.tasksPage.headEmpty', {
              defaultValue: 'Agent 一开新会话，它会出现在这里，也会出现在灵动岛上。',
            })}
          </p>
        </div>
        <div className="agent-monitor__acts">
          <button
            type="button"
            className="vb-btn"
            disabled={loading}
            onClick={() => {
              void refreshMonitor({ showLoading: true })
            }}
          >
            {refreshLabel}
          </button>
        </div>
      </header>

      {error && (
        <div className="agent-monitor__alert" role="alert">
          <span className="agent-monitor__alert-dot" aria-hidden="true" />
          <span>
            <b>{t('settings.tasksPage.staleBold', { defaultValue: '会话没能读取成功' })}</b>
            {t('settings.tasksPage.staleHint', { defaultValue: '，先显示本机缓存，可能落后几秒。' })}
          </span>
          <SettingDetails testId="tasks-error-details">{error}</SettingDetails>
          <button type="button" className="vb-btn" onClick={() => { void refreshMonitor({ showLoading: true }) }}>
            {t('settings.tasksPage.retry', { defaultValue: '重试' })}
          </button>
        </div>
      )}

      {liveTaskSessions.length > 0 ? (
        <section
          className="agent-monitor__lanes"
          data-testid="live-task-list"
          aria-label={t('settings.tasksPage.title', { defaultValue: '任务看板' })}
        >
          {liveTaskSessions.map((session) => {
            const waiting = session.phase === 'waiting_input'
            const name = agentLabel(session.agentType, session.engineLabel)
            return (
              <button
                type="button"
                key={session.id}
                data-testid={`live-task-${session.id}`}
                className={`agent-monitor__lane${waiting ? ' agent-monitor__lane--wait' : ''}`}
                onClick={() => { void recallTerminal(session) }}
              >
                <span className="agent-monitor__lane-who">
                  <span className="agent-monitor__lane-agent">{name}</span>
                  <span className="agent-monitor__lane-project">
                    {session.project || t('settings.tasksPage.untitled', { defaultValue: '未命名任务' })}
                  </span>
                </span>
                <span className="agent-monitor__lane-state">
                  <i
                    className={waiting
                      ? 'agent-monitor__dot agent-monitor__dot--wait'
                      : session.phase === 'compacting'
                        ? 'agent-monitor__dot agent-monitor__dot--ring'
                        : 'agent-monitor__dot'}
                  />
                  <span>{phaseLabel(t, session.phase)}</span>
                </span>
                {session.question && <span className="agent-monitor__lane-ask">{session.question}</span>}
                {session.activity.length > 0 && (
                  <span className="agent-monitor__lane-log">
                    {session.activity.map((line) => (
                      <span className="agent-monitor__lane-log-line" key={line}>{line}</span>
                    ))}
                  </span>
                )}
                <span className="agent-monitor__lane-clock-label">
                  {t('settings.tasksPage.runningFor', { defaultValue: '已运行' })}
                </span>
                <span className="agent-monitor__lane-clock">{formatClock(session.duration)}</span>
                <span className="agent-monitor__lane-task">
                  {session.title || session.project || t('settings.tasksPage.untitled', { defaultValue: '未命名任务' })}
                </span>
                <span className="agent-monitor__lane-meta">
                  <span className="agent-monitor__lane-token">
                    <b>{formatTokens(session.tokenTotal)}</b>
                    {' '}
                    {t('settings.tasksPage.tokenUnit', { defaultValue: 'token' })}
                  </span>
                  <span className="agent-monitor__lane-note">
                    {session.subagentCount > 0
                      ? t('settings.tasksPage.subagentCountValue', {
                        defaultValue: '{{count}} 个子任务',
                        count: session.subagentCount,
                      }).replace('{{count}}', String(session.subagentCount))
                      : t('settings.tasksPage.backToTerminal', { defaultValue: '回到终端' })}
                  </span>
                </span>
              </button>
            )
          })}
        </section>
      ) : (
        <div className="agent-monitor__empty-lane">
          <span className="agent-monitor__empty-pill">
            <img src="/vibe-board-app-icon.png" alt="" />
          </span>
          <b>
            {loading
              ? t('settings.tasksPage.loading', { defaultValue: '正在读取各 Agent 的会话…' })
              : t('settings.tasksPage.emptyTitle', { defaultValue: '灵动岛正在待命' })}
          </b>
        </div>
      )}

      {lowQuota && (
        <div className="agent-monitor__low-note">
          <span>
            {t('settings.tasksPage.lowQuotaLead', {
              defaultValue: '{{name}} 额度只剩',
              name: lowQuota.name,
            })}
          </span>
          <b>{`${Math.round(lowQuota.remaining)}%`}</b>
          {formatResetAt(lowQuota.resetsAt) && (
            <span>
              {t('settings.tasksPage.lowQuotaReset', {
                defaultValue: '{{time}} 恢复',
                time: formatResetAt(lowQuota.resetsAt),
              })}
            </span>
          )}
          {onOpenUsage && (
            <button type="button" className="vb-btn" onClick={onOpenUsage}>
              {t('settings.tasksPage.viewQuota', { defaultValue: '看额度' })}
            </button>
          )}
        </div>
      )}
    </section>
  )
}
