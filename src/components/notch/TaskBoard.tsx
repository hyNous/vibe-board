import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { activateSessionHost } from '../../services/tauriApi'
import type { AgentRunStatus, AgentStatusSnapshot, RateLimitInfo, SessionState } from '../../types/agent'
import { computePriority } from '../../types/priority'
import { statusFromSession } from '../../utils/agentRunState'
import { getAgentDisplayName, getSessionConversationTitle } from '../../utils/sessionDisplay'
import { AgentPresenceStrip } from './AgentPresenceStrip'

const VISIBLE_TASK_STATUSES = new Set<AgentRunStatus>([
  'starting',
  'running',
  'waiting_input',
  'waiting_permission',
  'blocked',
  'rate_limited',
  'error',
  'completed',
  'cancelled',
])

function taskStatus(session: SessionState): AgentRunStatus {
  return session.runState?.status ?? statusFromSession(session)
}

export function TaskBoard({
  sessions,
  statuses,
  usageSnapshots,
}: {
  sessions: SessionState[]
  statuses: Record<string, AgentStatusSnapshot>
  usageSnapshots: Record<string, RateLimitInfo>
}) {
  const { t } = useTranslation()
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const tasks = useMemo(
    () => sessions
      .filter((session) => VISIBLE_TASK_STATUSES.has(taskStatus(session)))
      .sort((a, b) => computePriority(b) - computePriority(a)),
    [sessions],
  )

  useEffect(() => () => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
  }, [])

  const showNotice = (message: string) => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    setNotice(message)
    noticeTimerRef.current = setTimeout(() => setNotice(null), 2400)
  }

  const activateHost = async (sessionId: string) => {
    try {
      if (!await activateSessionHost(sessionId)) {
        showNotice(t('notch.manualOpenCli'))
      }
    } catch (error) {
      console.warn('[notch] activateSessionHost:', error)
      showNotice(t('notch.activateAgentFailed'))
    }
  }

  const statusLabel = (status: AgentRunStatus) => {
    switch (status) {
      case 'starting':
      case 'running':
        return t('notch.working')
      case 'waiting_input':
        return t('notch.waitingInput')
      case 'waiting_permission':
        return t('notch.needsApproval')
      case 'blocked':
        return t('notch.blocked')
      case 'rate_limited':
        return t('notch.rateLimited')
      case 'error':
        return t('notch.error')
      case 'completed':
        return t('notch.taskComplete')
      case 'cancelled':
        return t('notch.interrupted')
      default:
        return t('notch.ready')
    }
  }

  return (
    <div className="task-board">
      <section className="task-board__tasks" aria-label={t('notch.activeTasks')}>
        {tasks.length > 0 ? tasks.map((session) => {
          const status = taskStatus(session)
          return (
            <button
              type="button"
              className="task-board__task"
              key={session.id}
              onClick={() => void activateHost(session.id)}
            >
              <span className={`task-board__status-dot task-board__status-dot--${status}`} aria-hidden />
              <span className="task-board__agent">{getAgentDisplayName(session)}</span>
              <span className="task-board__title">{getSessionConversationTitle(session)}</span>
              <span className="task-board__state">{statusLabel(status)}</span>
            </button>
          )
        }) : (
          <div className="task-board__empty">{t('notch.noActiveTasks')}</div>
        )}
      </section>

      <AgentPresenceStrip statuses={statuses} usageSnapshots={usageSnapshots} />

      <div className="task-board__brand" aria-label={t('notch.slogan')}>
        <span className="task-board__brand-logo-stack" aria-hidden>
          <img className="task-board__brand-logo task-board__brand-logo--light" src="/vibe-board-logo.png" alt="" />
          <img className="task-board__brand-logo task-board__brand-logo--dark" src="/vibe-board-logo-dark.png" alt="" />
        </span>
        <span className="task-board__brand-slogan">{t('notch.slogan')}</span>
      </div>

      {notice && <div className="task-board__notice" role="status" aria-live="polite">{notice}</div>}
    </div>
  )
}
