import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getMonitorSessions, type MonitorSessionSummary } from '../../../services/monitorApi'
import { selectSessionList, useSessionStore } from '../../../stores/sessionStore'
import { useConfigStore } from '../../../stores/configStore'
import type { SessionState, TokenUsage } from '../../../types/agent'
import { formatDurationShort } from '../../../utils/time'
import { getSessionTaskDurationSeconds } from '../../../utils/sessionDisplay'
import { formatTokens } from '../../../utils/tokens'
import { SettingDetails } from '../SettingDetails'
import './AgentMonitorSection.css'

function agentLabel(agentType: string, engineLabel?: string | null) {
  if (engineLabel && agentType === 'claude-code' && engineLabel !== 'Claude Code') return engineLabel
  if (agentType === 'claude-code') return 'Claude'
  if (agentType === 'gemini-cli') return 'Gemini'
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

function summaryFromSession(session: SessionState): MonitorSessionSummary {
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
  }
}

const LIVE_TASK_PHASES = new Set(['processing', 'compacting', 'waiting_input'])

export function AgentMonitorSection() {
  const { t } = useTranslation()
  const liveSessions = useSessionStore(selectSessionList)
  const codexAppServerLive = useSessionStore((state) => state.codexAppServerLive)
  const sessionRefreshIntervalSeconds = useConfigStore((state) => state.sessionRefreshIntervalSeconds)
  const [sessions, setSessions] = useState<MonitorSessionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const configuredRefreshMs = Math.max(1, Math.min(30, sessionRefreshIntervalSeconds)) * 1000

  const liveTaskSessions = useMemo(() => sessions
    .filter((session) => LIVE_TASK_PHASES.has(session.phase))
    .sort((a, b) => b.startedAt - a.startedAt), [sessions])

  const loadSessions = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true)
    setError('')
    try {
      const remoteSessions = await getMonitorSessions()
      const nextSessions = Array.from(new Map(
        [...remoteSessions, ...liveSessions.map(summaryFromSession)]
          .map((session) => [session.id, session] as const),
      ).values())
      setSessions(nextSessions)
    } catch (err) {
      setError(String(err))
      setSessions(liveSessions.map(summaryFromSession))
    } finally {
      setLoading(false)
    }
  }, [liveSessions])

  useEffect(() => {
    void loadSessions(true)
  }, [loadSessions])

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadSessions(false)
    }, configuredRefreshMs)
    return () => window.clearInterval(timer)
  }, [configuredRefreshMs, loadSessions])

  return (
    <section className="agent-monitor">
      <header className="agent-monitor__header">
        <div>
          <h2>{t('settings.tasksPage.title', { defaultValue: '任务看板' })}</h2>
          <p>{t('settings.tasksPage.desc', { defaultValue: '这里显示各个 Agent 正在做什么。点一条任务，可以把它所在的窗口调到前台。' })}</p>
        </div>
        <div className="agent-monitor__header-actions">
          <button
            type="button"
            className="agent-monitor__refresh"
            onClick={() => {
              void loadSessions(true)
            }}
          >
            {loading
              ? t('settings.refreshing', { defaultValue: '正在刷新…' })
              : t('settings.refresh', { defaultValue: '刷新' })}
          </button>
        </div>
      </header>

      <section className="agent-monitor__live-tasks" data-testid="live-task-list" aria-label={t('settings.tasksPage.title', { defaultValue: '任务看板' })}>
        <div className="agent-monitor__live-tasks-header">
          <div>
            <h3>{t('settings.tasksPage.liveTitle', { defaultValue: '正在进行的任务' })} <em>{liveTaskSessions.length}</em></h3>
            <p>{t('settings.tasksPage.liveDesc', { defaultValue: '每个 Agent 的会话单独显示；一个会话里的子任务不会重复计数。' })}</p>
          </div>
          <SettingDetails testId="tasks-status-details">
            <div className="setting-details__row">
              <span>{t('settings.tasksPage.liveConnection', { defaultValue: '实时连接' })}</span>
              <strong>
                {codexAppServerLive
                  ? t('settings.tasksPage.connected', { defaultValue: '已连接' })
                  : t('settings.tasksPage.disconnected', { defaultValue: '未连接' })}
              </strong>
            </div>
            <div className="setting-details__row">
              <span>{t('settings.tasksPage.syncedSessions', { defaultValue: '已同步会话' })}</span>
              <strong>{sessions.length}</strong>
            </div>
          </SettingDetails>
        </div>
        {loading && sessions.length === 0 ? (
          <div className="agent-monitor__empty">
            {t('settings.tasksPage.loading', { defaultValue: '正在读取各 Agent 的会话…' })}
          </div>
        ) : liveTaskSessions.length === 0 ? (
          <div className="agent-monitor__empty">
            {t('settings.tasksPage.empty', { defaultValue: '现在没有正在进行的任务。Agent 一有动静，这里就会出现。' })}
          </div>
        ) : (
          <div className="agent-monitor__live-task-list">
            {liveTaskSessions.map((session) => (
              <article key={session.id} className="agent-monitor__live-task-row" data-testid={`live-task-${session.id}`}>
                <span className="agent-monitor__live-task-agent">{agentLabel(session.agentType, session.engineLabel)}</span>
                <div className="agent-monitor__live-task-main">
                  <strong>{session.title || session.project || t('settings.tasksPage.untitled', { defaultValue: '未命名任务' })}</strong>
                  <SettingDetails testId={`live-task-details-${session.id}`} className="agent-monitor__live-task-details">
                    <div className="setting-details__row">
                      <span>{t('settings.tasksPage.sessionId', { defaultValue: '会话标识' })}</span>
                      <code>{session.id}</code>
                    </div>
                    <div className="setting-details__row">
                      <span>{t('settings.tasksPage.tokenTotal', { defaultValue: '已用 token' })}</span>
                      <strong>{formatTokens(session.tokenTotal)}</strong>
                    </div>
                    <div className="setting-details__row">
                      <span>{t('settings.tasksPage.subagentCount', { defaultValue: '子任务' })}</span>
                      <strong>{session.subagentCount}</strong>
                    </div>
                  </SettingDetails>
                </div>
                <span className="agent-monitor__live-task-state">{phaseLabel(t, session.phase)}</span>
                <span className="agent-monitor__live-task-meta">{formatDurationShort(session.duration)}</span>
              </article>
            ))}
          </div>
        )}
      </section>

      {error && (
        <div className="agent-monitor__notice" role="alert">
          <div>{t('settings.tasksPage.loadFailed', { defaultValue: '会话没能读取成功，已改用本机缓存显示。' })}</div>
          <SettingDetails testId="tasks-error-details">{error}</SettingDetails>
        </div>
      )}
    </section>
  )
}
