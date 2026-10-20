import type { SessionPhase, SessionState } from '../types/agent'

const PASSIVE_PHASES = new Set<SessionPhase>(['ready', 'idle', 'done', 'interrupted'])

export function getAgentDisplayName(session: SessionState): string {
  if (session.agentType === 'claude-code' && session.engineLabel && session.engineLabel !== 'Claude Code') {
    return session.engineLabel
  }
  switch (session.agentType) {
    case 'claude-code': return 'Claude'
    case 'gemini-cli': return 'Gemini'
    case 'opencode': return 'OpenCode'
    case 'workbuddy': return 'WorkBuddy'
    case 'zcode': return 'ZCode'
    case 'doubao': return 'Doubao'
    default: return session.agentType.charAt(0).toUpperCase() + session.agentType.slice(1)
  }
}

export function getSessionConversationTitle(session: SessionState): string {
  const title = isInternalCodexTitle(session.sessionTitle) ? '' : (session.sessionTitle || '').trim()
  return title || (session.project || '').trim() || 'Session'
}

function isInternalCodexTitle(title: string | undefined | null): boolean {
  const normalized = (title || '').trim().replace(/\s+/g, ' ').toLowerCase()
  return normalized.startsWith('<environment_context>')
    || normalized.startsWith('you are a helpful assistant. you will be presented with a user prompt')
    || normalized.startsWith('you are codex, a coding agent')
    || normalized.startsWith('you are an ai assistant accessed via an api')
}

export function isPassiveSession(session: SessionState): boolean {
  return PASSIVE_PHASES.has(session.phase)
    && !session.activeTools.some((tool) => tool.status === 'running')
    && !session.subagents.some((agent) => agent.status === 'running')
}

export function timestampToMs(timestamp: number | undefined): number | undefined {
  if (timestamp == null) return undefined
  return timestamp < 100_000_000_000 ? timestamp * 1000 : timestamp
}

export function getSessionExpiryAnchor(session: SessionState): number {
  return timestampToMs(session.taskCompletedAt)
    ?? timestampToMs(session.idleSince)
    ?? timestampToMs(session.lastActivityAt)
    ?? timestampToMs(session.startedAt)
    ?? Date.now()
}

/**
 * Duration of the current trace/task shown across Vibe Board task UI.
 *
 * Shows the elapsed time of the current trace since its latest prompt/task start,
 * never the lifetime of a long-lived session or Codex thread.
 */
export function getSessionTaskDurationSeconds(session: SessionState, now = Date.now()): number {
  const startedAt = timestampToMs(session.startedAt) ?? now
  const lastUserMessageAt = timestampToMs(session.lastUserMessageAt)
  const lastActivityAt = timestampToMs(session.lastActivityAt)
  const lastMainAgentAt = timestampToMs(session.lastMainAgentAt)
  const isActive = !isPassiveSession(session)
  const start = lastUserMessageAt
    ?? (isActive ? lastActivityAt : undefined)
    // Codex app-server snapshots use startedAt for the latest turn start.
    ?? (session.codexAppServerThreadId ? startedAt : undefined)
    ?? lastMainAgentAt
    // An active session without a trace timestamp has only just become
    // observable; never show its multi-day session age as a fake trace time.
    ?? (isActive ? now : startedAt)
    ?? now
  const end = isActive
    ? now
    : timestampToMs(session.taskCompletedAt)
      ?? timestampToMs(session.idleSince)
      ?? lastActivityAt
      ?? lastMainAgentAt
      ?? now

  return Math.max(0, (end - start) / 1000)
}

export function isSessionPastDisplayTimeout(session: SessionState, timeoutMinutes: number, now = Date.now()): boolean {
  if (timeoutMinutes <= 0 || !isPassiveSession(session)) return false
  return now - getSessionExpiryAnchor(session) > timeoutMinutes * 60 * 1000
}
