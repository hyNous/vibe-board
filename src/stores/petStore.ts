import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { convertFileSrc } from '@tauri-apps/api/core'
import type { PetOption, PetMetadata } from '../types/pet'
import type { AgentType, SessionState } from '../types/agent'
import { discoverPets, setActivePetId as setActivePetIdRemote } from '../services/tauriApi'
import { useConfigStore } from './configStore'

interface PetStore {
  registry: PetOption[]
  activePetId: string | null            // null = auto
  loading: boolean
  error: string | null
  warnings: string[]
  loadRegistry: () => Promise<void>
  setActivePet: (petId: string | null) => Promise<void>
  hydrateFromConfig: (configActivePetId: string | null) => void
}

function decoratePet(meta: PetMetadata): PetOption {
  // Convert the backend filesystem path into an `asset://` URL the WebView
  // can stream. We compute this once on load instead of in every render so
  // the resulting string is reference-stable for React deps.
  return { ...meta, spritesheetUrl: convertFileSrc(meta.spritesheetPath) }
}

export const usePetStore = create<PetStore>()(
  persist(
    (set, get) => ({
      registry: [],
      activePetId: null,
      loading: false,
      error: null,
      warnings: [],

      loadRegistry: async () => {
        if (get().loading) return
        set({ loading: true, error: null, warnings: [] })
        try {
          const result = await discoverPets()
          set({
            registry: result.pets.map(decoratePet),
            loading: false,
            warnings: result.warnings,
          })
          if (result.warnings.length > 0) {
            console.warn('[petStore] discovery warnings:', result.warnings)
          }
        } catch (err) {
          set({
            loading: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      },

      setActivePet: async (petId) => {
        const next = petId && petId.length > 0 ? petId : null
        if (get().activePetId === next) return
        set({ activePetId: next })
        useConfigStore.getState().updateConfig('islandActivePetId', next)
        try {
          await setActivePetIdRemote(next)
        } catch (err) {
          console.warn('[petStore] setActivePetId failed:', err)
        }
      },

      hydrateFromConfig: (configActivePetId) => {
        const normalized = configActivePetId ?? null
        if (get().activePetId === normalized) return
        set({ activePetId: normalized })
      },
    }),
    {
      name: 'agent-island-pet',
      version: 1,
      partialize: (state) => ({ activePetId: state.activePetId }),
    },
  ),
)

// ── Selectors ────────────────────────────────────────────────────────────────

/**
 * Resolve the pet that should currently render. Pure function — pass in the
 * registry, the user's selection, the relevant session list, and the user's
 * agent → pet map (set in 「设置 → 集成」for AUTO mode).
 *
 * - When `activePetId` is set and present in the registry, returns it (locked mode).
 * - When `null` (auto mode), looks at the highest-priority active session's
 *   agentType and resolves in this order:
 *     1. `agentPetMap[agentType]` — user-configured default for that agent
 *     2. A pet whose own `agentTypes` metadata claims this agent
 *     3. `registry[0]`
 * - Falls back to the first registered pet, or `null` if the registry is empty.
 */
export function selectActivePet(
  registry: PetOption[],
  activePetId: string | null,
  sessions: SessionState[],
  agentPetMap: Record<string, string> = {},
): PetOption | null {
  if (registry.length === 0) return null

  if (activePetId) {
    const locked = registry.find((p) => p.id === activePetId)
    if (locked) return locked
  }

  const top = pickTopActiveSession(sessions)
  if (top) {
    const userMapped = agentPetMap[top.agentType]
    if (userMapped) {
      const pet = registry.find((p) => p.id === userMapped)
      if (pet) return pet
    }
    const matchByAgent = registry.find((p) => p.agentTypes?.includes(top.agentType))
    if (matchByAgent) return matchByAgent
  }

  return registry[0] ?? null
}

function pickTopActiveSession(sessions: SessionState[]): SessionState | null {
  if (sessions.length === 0) return null
  const active = sessions.find((s) => s.phase !== 'done' && s.phase !== 'idle')
  return active ?? sessions[0]
}

// Backwards compat for tests / non-store callers.
export type { AgentType }
