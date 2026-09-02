import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePetSummon } from '../components/notch/usePetSummon'
import type { OverlayItem, SessionState } from '../types/agent'

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: 's1',
    agentType: 'claude-code',
    project: '',
    terminal: '',
    phase: 'processing',
    startedAt: Date.now(),
    duration: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    chatHistory: [],
    subagents: [],
    activeTools: [],
    ...overrides,
  } as SessionState
}

function makeOverlay(type: OverlayItem['type'], id = 'o1'): OverlayItem {
  return { id, sessionId: 's1', type, data: {}, createdAt: Date.now() }
}

describe('usePetSummon', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns inactive state when no overlay and no error', () => {
    const { result } = renderHook(() =>
      usePetSummon({ activeOverlay: null, topSession: makeSession() }),
    )
    expect(result.current.summonKind).toBeNull()
    expect(result.current.summonAnimationOverride).toBeNull()
    expect(result.current.summonEmote).toBeNull()
  })

  it('triggers summon for permission overlay', () => {
    const overlay = makeOverlay('permission')
    const { result } = renderHook(() =>
      usePetSummon({ activeOverlay: overlay, topSession: makeSession() }),
    )

    expect(result.current.summonKind).toBe('permission')
    expect(result.current.summonEmote).toBe('❓')
    expect(result.current.summonAnimationOverride).toBe('jumping')
  })

  it('clears emote after 500ms and animation after 700ms', async () => {
    const overlay = makeOverlay('plan')
    const { result } = renderHook(() =>
      usePetSummon({ activeOverlay: overlay, topSession: makeSession() }),
    )
    expect(result.current.summonEmote).toBe('💭')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(550)
    })
    expect(result.current.summonEmote).toBeNull()
    expect(result.current.summonAnimationOverride).toBe('jumping')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(result.current.summonAnimationOverride).toBeNull()
  })

  it('does not re-trigger for the same overlay', async () => {
    const overlay = makeOverlay('question')
    const { result, rerender } = renderHook(
      ({ overlay }) => usePetSummon({ activeOverlay: overlay, topSession: makeSession() }),
      { initialProps: { overlay } },
    )
    const initialNonce = result.current.summonNonce

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800)
    })
    rerender({ overlay })
    expect(result.current.summonNonce).toBe(initialNonce)
  })

  it('triggers a fresh summon when overlay id changes', async () => {
    const first = makeOverlay('permission', 'o1')
    const { result, rerender } = renderHook(
      ({ overlay }) => usePetSummon({ activeOverlay: overlay, topSession: makeSession() }),
      { initialProps: { overlay: first } },
    )
    const firstNonce = result.current.summonNonce

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800)
    })
    const second = makeOverlay('permission', 'o2')
    rerender({ overlay: second })

    expect(result.current.summonNonce).toBeGreaterThan(firstNonce)
  })

  it('triggers error summon when session phase is error', () => {
    const session = makeSession({ phase: 'error' })
    const { result } = renderHook(() =>
      usePetSummon({ activeOverlay: null, topSession: session }),
    )
    expect(result.current.summonKind).toBe('error')
    expect(result.current.summonEmote).toBe('💥')
  })
})
