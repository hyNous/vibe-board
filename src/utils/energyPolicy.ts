import type { SessionState } from '../types/agent'

export type AppEnergyMode = 'active' | 'idle-visible' | 'quiet-background'

type SessionEnergyInput = Pick<SessionState, 'phase'> & Partial<Pick<SessionState, 'activeTools' | 'subagents' | 'tasks'>>

const ACTIVE_PHASES = new Set(['processing', 'compacting', 'waiting_input'])
const TERMINAL_PHASES = new Set(['done', 'interrupted'])

export function getAppEnergyMode(sessions: Array<SessionEnergyInput>): AppEnergyMode {
  if (sessions.some(isActiveEnergySession)) return 'active'
  if (sessions.some((session) => !TERMINAL_PHASES.has(session.phase))) return 'idle-visible'
  return 'quiet-background'
}

export function energyIntervalMs(
  mode: AppEnergyMode,
  intervals: { activeMs: number; idleVisibleMs: number; quietMs: number },
): number {
  switch (mode) {
    case 'active':
      return intervals.activeMs
    case 'idle-visible':
      return Math.max(intervals.activeMs, intervals.idleVisibleMs)
    case 'quiet-background':
      return Math.max(intervals.idleVisibleMs, intervals.quietMs)
  }
}

export function energyAnimationFpsScale(mode: AppEnergyMode): number {
  switch (mode) {
    case 'active':
      return 1
    case 'idle-visible':
      return 0.75
    case 'quiet-background':
      return 0.45
  }
}

export function shouldSilenceAfterWake(
  previousTimestampMs: number,
  currentTimestampMs: number,
  thresholdMs = 45_000,
): boolean {
  return currentTimestampMs - previousTimestampMs > thresholdMs
}

export function isSessionBlockingBackgroundWork(session: SessionEnergyInput): boolean {
  return isActiveEnergySession(session)
    || Boolean(session.activeTools?.some((tool) => tool.status === 'running'))
    || Boolean(session.subagents?.some((subagent) => subagent.status === 'running'))
    || Boolean(session.tasks?.some((task) => task.status === 'in_progress'))
}

export function blockingBackgroundSessionCount(sessions: Array<SessionEnergyInput>): number {
  return sessions.reduce((count, session) => (
    isSessionBlockingBackgroundWork(session) ? count + 1 : count
  ), 0)
}

function isActiveEnergySession(session: SessionEnergyInput): boolean {
  return ACTIVE_PHASES.has(session.phase)
}
