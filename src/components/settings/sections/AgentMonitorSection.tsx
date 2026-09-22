import { useCallback, useEffect, useMemo, useState } from 'react'
import { getMonitorSessions, type MonitorSessionSummary } from '../../../services/monitorApi'
import { selectSessionList, useSessionStore } from '../../../stores/sessionStore'
import { useConfigStore } from '../../../stores/configStore'
import type { SessionState, TokenUsage } from '../../../types/agent'
import { formatDurationShort } from '../../../utils/time'
import { getSessionTaskDurationSeconds } from '../../../utils/sessionDisplay'
import { formatTokens } from '../../../utils/tokens'
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

function phaseLabel(phase?: string) {
  switch (phase) {
    case 'starting':
    case 'running':
    case 'processing': return '运行中'
    case 'waiting_input': return '等输入'
    case 'blocked': return '已阻塞'
    case 'compacting': return '压缩上下文'
    case 'done':
    case 'completed': return '完成'
    case 'error': return '错误'
    case 'failed':
    case 'failure': return '失败'
    case 'interrupted': return '已中断'
    case 'cancelled': return '已取消'
    case 'rate_limited': return '限流'
    case 'unknown': return '未知'
    case 'idle':
    default: return '空闲'
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
          <h2>Tasks</h2>
          <p>当前实时任务来自各 Agent 的本地会话状态。Codex app-server：{codexAppServerLive ? '已连接' : '未连接'}。</p>
        </div>
        <div className="agent-monitor__header-actions">
          <button
            type="button"
            className="agent-monitor__refresh"
            onClick={() => {
              void loadSessions(true)
            }}
          >
            重新加载
          </button>
        </div>
      </header>

      {error && <div className="agent-monitor__notice">会话读取失败，已回退到前端 sessionStore：{error}</div>}

      <section className="agent-monitor__live-tasks" data-testid="live-task-list" aria-label="当前实时任务">
        <div className="agent-monitor__live-tasks-header">
          <div>
            <h3>当前实时任务 <em>{liveTaskSessions.length}</em></h3>
            <p>每个 Agent 的独立 session 都会显示；嵌套 subagent 计入所属会话的子任务数，不重复计数。</p>
          </div>
          <span>{codexAppServerLive ? 'Codex 已连接' : 'Codex 未连接'} · {sessions.length} 个已同步会话</span>
        </div>
        {loading && sessions.length === 0 ? (
          <div className="agent-monitor__empty">正在同步当前 Agent 会话...</div>
        ) : liveTaskSessions.length === 0 ? (
          <div className="agent-monitor__empty">
            {codexAppServerLive
              ? `当前没有正在运行或等待中的任务（已同步 ${sessions.length} 个会话）。`
              : '当前没有可用的 Codex 实时同步连接。若 Codex 正在处理，请先完成 Hook 配置（首次向导或灵动岛上的健康指示）并重启 Vibe Board。'}
          </div>
        ) : (
          <div className="agent-monitor__live-task-list">
            {liveTaskSessions.map((session) => (
              <article key={session.id} className="agent-monitor__live-task-row" data-testid={`live-task-${session.id}`}>
                <span className="agent-monitor__live-task-agent">{agentLabel(session.agentType, session.engineLabel)}</span>
                <div className="agent-monitor__live-task-main">
                  <strong>{session.title || session.project || 'Unknown'}</strong>
                  <code title={session.id}>{session.id}</code>
                </div>
                <span className="agent-monitor__live-task-state">{phaseLabel(session.phase)}</span>
                <span className="agent-monitor__live-task-meta">
                  {formatDurationShort(session.duration)} · {formatTokens(session.tokenTotal)} tok · {session.subagentCount} sub
                </span>
              </article>
            ))}
          </div>
        )}
      </section>
    </section>
  )
}
