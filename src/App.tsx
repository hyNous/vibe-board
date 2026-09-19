/* Vibe Board — Main App */
import { lazy, Suspense, useEffect, useState } from 'react'
import { COLOR_THEMES, useThemeStore } from './stores/themeStore'
import { useConfigStore } from './stores/configStore'
import { BackgroundUpdater } from './components/BackgroundUpdater'
import { useTauriInit } from './hooks/useTauri'
import { useAutoHide } from './hooks/useAutoHide'
import { isTauri } from './services/tauriApi'
import { primaryModifierPressed } from './utils/platform'
import './styles/globals.css'

const ClaudeHookUiLab = lazy(() => import('./components/dev/ClaudeHookUiLab').then((module) => ({ default: module.ClaudeHookUiLab })))
const NotchPanel = lazy(() => import('./components/notch/NotchPanel').then((module) => ({ default: module.NotchPanel })))
const SettingsApp = lazy(() => import('./components/settings/SettingsApp').then((module) => ({ default: module.SettingsApp })))

// Fields whose source of truth lives in the Rust backend and is broadcast via
// the `config-changed` event. We must NOT replay stale values from another
// window's `storage` snapshot, or a notch window writing localStorage during an
// `island-layout-preview` race can clobber the settings window's just-changed
// value.
const BACKEND_MANAGED_CONFIG_KEYS = new Set<keyof ReturnType<typeof useConfigStore.getState>>([
  'soundEnabled', 'volume', 'launchAtLogin', 'autoHide', 'smartSuppression',
  'showUsageQuota', 'usageQueryEnabled', 'language', 'autoHideNoSessions', 'displayMonitor',
  'codexAppServerSyncEnabled', 'codexAppServerSyncIntervalSeconds', 'sessionRefreshIntervalSeconds', 'windowCloseBehavior',
  'hostVisibilityMode', 'notchPositionMode', 'notchVerticalOffset', 'panelHorizontalOffset',
  'globalShortcut',
  'shortcutApprove', 'shortcutApproveEnabled',
  'shortcutDeny', 'shortcutDenyEnabled',
  'shortcutSkip', 'shortcutSkipEnabled',
  'soundEvents', 'soundRules', 'customSounds', 'soundPack',
  'probeSessionFilter',
  'excludedHookCwdSubstrings', 'sessionSilenceRules',
  'tipsEnabled', 'pixelCursorEnabled', 'confettiEnabled',
  'analyticsEnabled', 'analyticsConsentPromptCompleted',
  'followFocus', 'quietHours', 'idleTimeoutMinutes',
  'idleInteractionRoutingEnabled', 'idleInteractionRoutingMinutes',
  'setupWizardCompleted', 'hostAgent', 'childAgents', 'autoStartOnHostSession',
])

const CONFIG_STORAGE_KEY = 'vibeboard-config'
const LEGACY_CONFIG_STORAGE_KEYS = ['agent-island-config', 'agentbro-config'] as const
const THEME_STORAGE_KEY = 'vibeboard-theme'
const LEGACY_THEME_STORAGE_KEYS = ['agent-island-theme', 'agentbro-theme'] as const

function readPersistedValue(keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = window.localStorage.getItem(key)
    if (value) return value
  }
  return null
}

function applyPersistedConfig(raw: string | null) {
  if (!raw) return
  try {
    const persisted = JSON.parse(raw) as { state?: Partial<ReturnType<typeof useConfigStore.getState>> }
    if (!persisted.state) return
    const filtered: Partial<ReturnType<typeof useConfigStore.getState>> = {}
    for (const key of Object.keys(persisted.state) as Array<keyof ReturnType<typeof useConfigStore.getState>>) {
      if (BACKEND_MANAGED_CONFIG_KEYS.has(key)) continue
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(filtered as any)[key] = (persisted.state as any)[key]
    }
    useConfigStore.setState(filtered)
  } catch {
    // Ignore malformed persisted config payloads.
  }
}

// ── Detect which Tauri window we're in ────────────────────────

async function detectWindowLabel(): Promise<string> {
  // Check URL hash first (works in both Tauri and browser)
  if (window.location.hash === '#settings') return 'settings'
  if (window.location.hash === '#skill-pack-picker') return 'skill-pack-picker'

  // In Tauri, use the real window label
  if (isTauri()) {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      return getCurrentWindow().label
    } catch {
      // fallback
    }
  }

  // Browser dev mode defaults to notch
  return 'notch'
}

// ── App ────────────────────────────────────────────────────────

function App() {
  const [windowLabel, setWindowLabel] = useState<string | null>(null)

  useTauriInit(windowLabel)
  useAutoHide()

  // Apply color theme to DOM
  const colorTheme = useThemeStore((s) => s.colorTheme)
  useEffect(() => {
    const normalizedTheme = COLOR_THEMES.some((theme) => theme.id === colorTheme) ? colorTheme : 'midnight'
    document.documentElement.setAttribute('data-island-color-theme', normalizedTheme)
  }, [colorTheme])

  useEffect(() => {
    const applyPersistedTheme = (raw: string | null) => {
      if (!raw) return
      try {
        const persisted = JSON.parse(raw) as { state?: { colorTheme?: string } }
        const nextTheme = persisted.state?.colorTheme
        if (nextTheme && COLOR_THEMES.some((theme) => theme.id === nextTheme)) {
          document.documentElement.setAttribute('data-island-color-theme', nextTheme)
          if (useThemeStore.getState().colorTheme !== nextTheme) {
            useThemeStore.setState({ colorTheme: nextTheme })
          }
        }
      } catch {
        // Ignore malformed persisted theme payloads.
      }
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== null && (event.key === THEME_STORAGE_KEY || LEGACY_THEME_STORAGE_KEYS.includes(event.key as typeof LEGACY_THEME_STORAGE_KEYS[number]))) applyPersistedTheme(event.newValue)
    }
    const handleFocus = () => applyPersistedTheme(
      readPersistedValue([THEME_STORAGE_KEY, ...LEGACY_THEME_STORAGE_KEYS]),
    )

    handleFocus()
    window.addEventListener('storage', handleStorage)
    window.addEventListener('focus', handleFocus)
    return () => {
      window.removeEventListener('storage', handleStorage)
      window.removeEventListener('focus', handleFocus)
    }
  }, [])

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== null && (event.key === CONFIG_STORAGE_KEY || LEGACY_CONFIG_STORAGE_KEYS.includes(event.key as typeof LEGACY_CONFIG_STORAGE_KEYS[number]))) applyPersistedConfig(event.newValue)
    }
    const handleFocus = () => applyPersistedConfig(
      readPersistedValue([CONFIG_STORAGE_KEY, ...LEGACY_CONFIG_STORAGE_KEYS]),
    )

    handleFocus()
    window.addEventListener('storage', handleStorage)
    window.addEventListener('focus', handleFocus)
    return () => {
      window.removeEventListener('storage', handleStorage)
      window.removeEventListener('focus', handleFocus)
    }
  }, [])

  // Detect window on mount
  useEffect(() => {
    detectWindowLabel().then(setWindowLabel)
  }, [])

  // Browser dev mode: primary modifier + , toggles settings view in same page
  useEffect(() => {
    if (isTauri()) return
    const handler = (e: KeyboardEvent) => {
      if (primaryModifierPressed(e) && e.key === ',') {
        e.preventDefault()
        setWindowLabel((v) => (v === 'settings' ? 'notch' : 'settings'))
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Wait for detection
  if (windowLabel === null) return null

  // The tray skill pack picker window is kept as a compatibility surface but
  // is not rendered.
  if (windowLabel === 'skill-pack-picker') return null

  // Settings window
  if (windowLabel === 'settings') {
    const handleClose = async () => {
      if (isTauri()) {
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window')
          const { invoke } = await import('@tauri-apps/api/core')
          await invoke('set_dock_visible', { visible: false })
          // Route the in-app close action through the same native close handler
          // as the title-bar X, so the user's tray/exit preference applies to
          // both ways of closing Settings.
          await getCurrentWindow().close()
        } catch {
          // fallback: do nothing
        }
      } else {
        // Browser dev mode: switch back to notch
        setWindowLabel('notch')
      }
    }

    return (
      <div style={{ width: '100vw', height: '100vh', background: 'var(--settings-bg)' }}>
        <Suspense fallback={null}><SettingsApp onClose={handleClose} /></Suspense>
      </div>
    )
  }

  const notchWindow = (
    <div style={{
      width: '100vw',
      height: '100vh',
      background: 'transparent',
      position: 'relative',
    }}>
      <BackgroundUpdater />
      <Suspense fallback={null}><NotchPanel /></Suspense>
    </div>
  )

  if (!isTauri() && windowLabel === 'notch') {
    return <Suspense fallback={notchWindow}><ClaudeHookUiLab>{notchWindow}</ClaudeHookUiLab></Suspense>
  }

  // Notch window (default)
  return notchWindow
}

export default App
