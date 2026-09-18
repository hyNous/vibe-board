import { create } from 'zustand'

// Runtime-only signal that a newer version was detected by the background
// updater. Lives in the notch window's process and is read by surfaces (gear
// dot, notch banner). Intentionally NOT persisted — availability and the
// per-run dismissal must be re-discovered each run.
interface UpdateStore {
  availableVersion: string | null
  // Version the user dismissed from the proactive banner this run. The gear
  // dot keeps showing (reads availableVersion); only the banner respects this.
  dismissedVersion: string | null
  setAvailableVersion: (version: string | null) => void
  dismissVersion: (version: string) => void
}

export const useUpdateStore = create<UpdateStore>((set) => ({
  availableVersion: null,
  dismissedVersion: null,
  setAvailableVersion: (version) => set({ availableVersion: version }),
  dismissVersion: (version) => set({ dismissedVersion: version }),
}))
