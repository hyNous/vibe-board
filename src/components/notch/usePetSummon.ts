import { useEffect, useRef, useState } from 'react'
import type { OverlayItem, SessionState } from '../../types/agent'
import type { EmoteKind } from './PetEmote'

export type SummonKind = 'permission' | 'question' | 'plan' | 'error' | null

interface SummonAction {
  kind: Exclude<SummonKind, null>
  emote: EmoteKind
}

const ACTION_BY_OVERLAY: Record<string, SummonAction> = {
  permission: { kind: 'permission', emote: '❓' },
  question: { kind: 'question', emote: '❓' },
  plan: { kind: 'plan', emote: '💭' },
}

const ERROR_ACTION: SummonAction = { kind: 'error', emote: '💥' }

const ANIM_OVERRIDE_MS = 700
const EMOTE_HOLD_MS = 500

interface UsePetSummonOptions {
  activeOverlay: OverlayItem | null
  topSession: SessionState | undefined
}

interface UsePetSummonResult {
  summonAnimationOverride: 'jumping' | null
  summonEmote: EmoteKind
  summonKind: SummonKind
  /** Bumped each time a summon fires, for callers that want to react. */
  summonNonce: number
}

/**
 * Drives the pet's "main aware me!" reaction: swaps animation to `jumping`
 * and surfaces an emote glyph above the pet. Fires once per
 * unique overlay/error transition and clears itself after the timers expire.
 */
export function usePetSummon({ activeOverlay, topSession }: UsePetSummonOptions): UsePetSummonResult {
  const [summonAnimationOverride, setAnim] = useState<'jumping' | null>(null)
  const [summonEmote, setEmote] = useState<EmoteKind>(null)
  const [summonKind, setKind] = useState<SummonKind>(null)
  const [summonNonce, setNonce] = useState(0)
  const lastTriggerRef = useRef<string | null>(null)
  const timersRef = useRef<number[]>([])

  // Cleanup pending timers on unmount. We intentionally do NOT clean up on
  // every effect re-run — dependency changes (e.g. new topSession reference
  // from re-render) must not cancel in-flight summon timers. New summons
  // explicitly clear old timers via the block below.
  useEffect(() => {
    return () => {
      timersRef.current.forEach((id) => window.clearTimeout(id))
      timersRef.current = []
    }
  }, [])

  useEffect(() => {
    const action = resolveAction({ activeOverlay, topSession })
    const triggerKey = action ? makeTriggerKey(action.kind, activeOverlay, topSession) : null

    if (!action || !triggerKey) {
      lastTriggerRef.current = null
      return
    }

    if (lastTriggerRef.current === triggerKey) return
    lastTriggerRef.current = triggerKey

    // Clear any timers from a previous summon so they don't override the new state.
    timersRef.current.forEach((id) => window.clearTimeout(id))
    timersRef.current = []

    // eslint-disable-next-line react-hooks/set-state-in-effect -- The summon state is the synchronous reaction to a newly observed overlay/error.
    setKind(action.kind)
    setAnim('jumping')
    setEmote(action.emote)
    setNonce((n) => n + 1)
    timersRef.current.push(window.setTimeout(() => setAnim(null), ANIM_OVERRIDE_MS))
    timersRef.current.push(window.setTimeout(() => setEmote(null), EMOTE_HOLD_MS))
    timersRef.current.push(
      window.setTimeout(() => {
        setKind(null)
        timersRef.current = []
      }, Math.max(ANIM_OVERRIDE_MS, EMOTE_HOLD_MS)),
    )
  }, [activeOverlay, topSession])

  return { summonAnimationOverride, summonEmote, summonKind, summonNonce }
}

function resolveAction({
  activeOverlay,
  topSession,
}: UsePetSummonOptions): SummonAction | null {
  if (activeOverlay && ACTION_BY_OVERLAY[activeOverlay.type]) {
    return ACTION_BY_OVERLAY[activeOverlay.type]
  }
  if (topSession?.phase === 'error') {
    return ERROR_ACTION
  }
  return null
}

function makeTriggerKey(
  kind: Exclude<SummonKind, null>,
  overlay: OverlayItem | null,
  session: SessionState | undefined,
): string {
  if (overlay && (kind === 'permission' || kind === 'question' || kind === 'plan')) {
    return `${kind}:${overlay.id}`
  }
  if (kind === 'error' && session) {
    return `error:${session.id}`
  }
  return ''
}
