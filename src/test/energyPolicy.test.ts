import { describe, expect, it } from 'vitest'
import {
  blockingBackgroundSessionCount,
  energyIntervalMs,
  getAppEnergyMode,
  shouldSilenceAfterWake,
} from '../utils/energyPolicy'
import type { SessionState } from '../types/agent'

function session(phase: SessionState['phase'], extras: Partial<SessionState> = {}) {
  return {
    phase,
    activeTools: [],
    subagents: [],
    tasks: [],
    ...extras,
  } as SessionState
}

describe('energyPolicy', () => {
  it('uses active mode for running or attention sessions', () => {
    expect(getAppEnergyMode([session('waiting_input')])).toBe('active')
    expect(getAppEnergyMode([session('processing')])).toBe('active')
  })

  it('keeps idle sessions visible before going quiet', () => {
    expect(getAppEnergyMode([session('idle')])).toBe('idle-visible')
    expect(getAppEnergyMode([session('done'), session('interrupted')])).toBe('quiet-background')
  })

  it('slows intervals by energy mode', () => {
    const intervals = { activeMs: 1000, idleVisibleMs: 3000, quietMs: 8000 }

    expect(energyIntervalMs('active', intervals)).toBe(1000)
    expect(energyIntervalMs('idle-visible', intervals)).toBe(3000)
    expect(energyIntervalMs('quiet-background', intervals)).toBe(8000)
  })

  it('counts sessions with running child work as background blockers', () => {
    expect(blockingBackgroundSessionCount([
      session('done'),
      session('idle', { activeTools: [{ toolUseId: 't1', toolName: 'Read', status: 'running', startedAt: Date.now() }] }),
      session('idle', { tasks: [{ id: 'task-1', name: 'Build', status: 'in_progress' }] }),
    ])).toBe(2)
  })

  it('detects likely wake gaps from clock jumps', () => {
    expect(shouldSilenceAfterWake(1_000, 20_000)).toBe(false)
    expect(shouldSilenceAfterWake(1_000, 60_001)).toBe(true)
  })
})
