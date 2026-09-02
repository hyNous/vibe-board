import { describe, it, expect, vi } from 'vitest'
import type { SessionState } from '../types/agent'
import { formatDuration, formatDurationShort } from '../utils/time'
import { getSessionTaskDurationSeconds } from '../utils/sessionDisplay'

describe('formatDuration', () => {
  it('formats seconds only', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000 * 30)
    expect(formatDuration(0)).toBe('30s')
    vi.restoreAllMocks()
  })

  it('formats minutes and seconds', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000 * 125)
    expect(formatDuration(0)).toBe('2:05')
    vi.restoreAllMocks()
  })

  it('formats hours, minutes, and seconds', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000 * 3661)
    expect(formatDuration(0)).toBe('1:01:01')
    vi.restoreAllMocks()
  })
})

describe('formatDurationShort', () => {
  it('formats sub-minute durations for the island', () => {
    expect(formatDurationShort(1)).toBe('<1m')
    expect(formatDurationShort(59)).toBe('<1m')
  })

  it('formats minutes and hours compactly', () => {
    expect(formatDurationShort(60)).toBe('1m')
    expect(formatDurationShort(125)).toBe('2m')
    expect(formatDurationShort(3900)).toBe('1h5m')
  })
})

describe('getSessionTaskDurationSeconds', () => {
  it('uses the latest user message instead of the session lifetime', () => {
    const now = 2_000_000_000_000
    const session = {
      id: 'codex-thread',
      agentType: 'codex',
      project: 'control-tower',
      terminal: 'Codex',
      phase: 'processing',
      startedAt: now - 48 * 60 * 60 * 1000,
      duration: 48 * 60 * 60,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
      chatHistory: [],
      subagents: [],
      activeTools: [],
      lastUserMessageAt: now - 5 * 60 * 1000,
    } as SessionState

    expect(getSessionTaskDurationSeconds(session, now)).toBe(5 * 60)
  })

  it('uses the latest observed activity when prompt metadata is not present', () => {
    const now = 2_000_000_000_000
    const session = {
      id: 'antigravity-session',
      agentType: 'antigravity',
      project: 'control-tower',
      terminal: 'Terminal',
      phase: 'processing',
      startedAt: now - 45 * 1000,
      duration: 45,
      lastActivityAt: now - 45 * 1000,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
      chatHistory: [],
      subagents: [],
      activeTools: [],
    } as SessionState

    expect(getSessionTaskDurationSeconds(session, now)).toBe(45)
  })

  it('measures active turn from prompt start rather than recent tool activity', () => {
    const now = 2_000_000_000_000
    const session = {
      id: 'claude-session',
      agentType: 'claude-code',
      project: 'control-tower',
      terminal: 'Terminal',
      phase: 'processing',
      startedAt: now - 120 * 1000,
      duration: 120,
      lastUserMessageAt: now - 120 * 1000,
      lastActivityAt: now - 3 * 1000,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
      chatHistory: [],
      subagents: [],
      activeTools: [{ toolUseId: 't1', toolName: 'Read', status: 'running', startedAt: now - 3 * 1000 }],
    } as SessionState

    expect(getSessionTaskDurationSeconds(session, now)).toBe(120)
  })

  it('measures completed trace duration to taskCompletedAt', () => {
    const now = 2_000_000_000_000
    const session = {
      id: 'opencode-session',
      agentType: 'opencode',
      project: 'control-tower',
      terminal: 'Terminal',
      phase: 'done',
      startedAt: now - 100 * 1000,
      duration: 80,
      lastUserMessageAt: now - 100 * 1000,
      taskCompletedAt: now - 20 * 1000,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
      chatHistory: [],
      subagents: [],
      activeTools: [],
    } as SessionState

    expect(getSessionTaskDurationSeconds(session, now)).toBe(80)
  })
})
