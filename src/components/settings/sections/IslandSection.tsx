import { useState, useEffect, useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'
import { open as openDialog, ask as askDialog } from '@tauri-apps/plugin-dialog'
import { useConfigStore } from '../../../stores/configStore'
import { useThemeStore, COLOR_THEMES } from '../../../stores/themeStore'
import type { ThemeConfig } from '../../../types/theme'
import { SpriteCanvas } from '../../notch/SpriteCanvas'
import { PRIORITY } from '../../../types/priority'
import { CUSTOM_NOTCH_HEIGHT_MAX, CUSTOM_NOTCH_HEIGHT_MIN } from '../../../utils/islandLayout'
import {
  formatShortcutKeyEvent,
  isRecordableShortcutEvent,
  shortcutDisplayParts,
} from '../../../utils/keyboardShortcuts'
import {
  listDisplays, isTauri,
  setDisplayId, repositionNotch,
  previewIslandLayout, clearIslandLayoutPreview,
  registerGlobalShortcut, setGlobalActionShortcuts, setIslandFeatureFlags,
  setActiveBackendTheme,
  runHookDoctor, uninstallAllHooks,
  getConfig, updateConfig as updateBackendConfig, listUsageProviders, authorizeUsageProvider,
} from '../../../services/tauriApi'
import type { BackendDisplayInfo, HookDoctorCheck, HookDoctorReport, HookEventStatus, UsageProviderStatus } from '../../../services/tauriApi'
import type { IslandLayoutPreviewMode, IslandLayoutPreviewOptions } from '../../../services/tauriApi'
import { SettingSection } from '../SettingSection'
import { SettingGroup } from '../SettingGroup'
import { SettingRow } from '../SettingRow'
import { Toggle } from '../Toggle'
import { Dropdown } from '../Dropdown'
import { Slider } from '../Slider'
import { GlassButton, GlassInput } from '../../shared'
import { PlatformIcon } from '../../platform/PlatformIcon'
import { HookEventConfigDialog } from '../HookEventConfigDialog'
import type { IslandSettingsView } from '../../../types/capability'

function displayMatchesConfiguredValue(display: BackendDisplayInfo, value: string): boolean {
  return display.id === value || display.name === value || display.label === value
}

function normalizeDisplayMonitorValue(value: string, displays: BackendDisplayInfo[]): string {
  const normalizedValue = value.trim()
  if (normalizedValue === 'primary' || normalizedValue === 'auto' || !normalizedValue) return normalizedValue
  const display = displays.find((d) => displayMatchesConfiguredValue(d, normalizedValue))
  if (!display) {
    return displays.some((d) => d.isPrimary) && displays.every((d) => d.isPrimary) ? 'primary' : normalizedValue
  }
  return display.isPrimary ? 'primary' : display.id
}

type IslandFeatureFlag = 'tipsEnabled' | 'pixelCursorEnabled' | 'confettiEnabled' | 'followFocus'
const USAGE_PROVIDER_REFRESH_TIMEOUT_MS = 10_000
const ACCOUNT_USAGE_PROVIDER_ORDER = [
  'codex',
  'claude-code',
  'z-ai',
  'kimi',
  'gemini-cli',
  'copilot',
  'cursor',
  'cursor-cli',
  'deepseek',
  'opencode',
  'droid',
  'stepfun',
  'antigravity',
  'kiro',
]
const ACCOUNT_USAGE_PROVIDER_RANK = new Map(
  ACCOUNT_USAGE_PROVIDER_ORDER.map((provider, index) => [provider, index]),
)

function readableError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message)
  }
  return String(error)
}

const QUIET_ASSISTANT_PRESET = {
  interactionMode: 'minimal' as const,
  smartSuppression: true,
  autoHideNoSessions: true,
  idleCompactDwellSeconds: 8,
  noSessionsHideDelay: 10,
}
const PERSISTENT_MONITOR_PRESET = {
  interactionMode: 'persistent' as const,
  smartSuppression: true,
  autoHideNoSessions: false,
  idleCompactDwellSeconds: 8,
  noSessionsHideDelay: 10,
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof window.setTimeout> | undefined
  const timeout = new Promise<T>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([
    promise.finally(() => {
      if (timer) window.clearTimeout(timer)
    }),
    timeout,
  ])
}

function persistIslandFeatureFlags(next: Partial<Record<IslandFeatureFlag, boolean>>) {
  const state = useConfigStore.getState()
  setIslandFeatureFlags({
    tipsEnabled: next.tipsEnabled ?? state.tipsEnabled,
    pixelCursorEnabled: next.pixelCursorEnabled ?? state.pixelCursorEnabled,
    confettiEnabled: next.confettiEnabled ?? state.confettiEnabled,
    followFocus: next.followFocus ?? state.followFocus,
  }).catch((err) => console.error('Failed to persist island feature flags:', err))
}

function persistUsageQuerySettings(next: Partial<{ usageQueryEnabled: boolean; showUsageQuota: boolean }>) {
  const state = useConfigStore.getState()
  getConfig()
    .then((backendConfig) => updateBackendConfig({
      ...backendConfig,
      usageQueryEnabled: next.usageQueryEnabled ?? state.usageQueryEnabled,
      showTokenUsage: next.showUsageQuota ?? state.showUsageQuota,
    }))
    .catch((err) => console.error('Failed to persist usage query settings:', err))
}

function persistIdleInteractionRouting(next: Partial<{ enabled: boolean; minutes: number }>) {
  const state = useConfigStore.getState()
  getConfig()
    .then((backendConfig) => updateBackendConfig({
      ...backendConfig,
      idleInteractionRoutingEnabled: next.enabled ?? state.idleInteractionRoutingEnabled,
      idleInteractionRoutingMinutes: next.minutes ?? state.idleInteractionRoutingMinutes,
    }))
    .catch((err) => console.error('Failed to persist idle interaction routing:', err))
}

function persistSessionRefreshInterval(seconds: number) {
  const value = Math.max(1, Math.min(30, Math.round(seconds)))
  getConfig()
    .then((backendConfig) => updateBackendConfig({ ...backendConfig, sessionRefreshIntervalSeconds: value }))
    .catch((err) => console.error('Failed to persist session refresh interval:', err))
}

function persistWindowCloseBehavior(value: 'tray' | 'exit') {
  getConfig()
    .then((backendConfig) => updateBackendConfig({ ...backendConfig, windowCloseBehavior: value }))
    .catch((err) => console.error('Failed to persist window close behavior:', err))
}

const PRIMARY_SHORTCUT_ACTIONS = new Set(['toggle-panel', 'collapse-panel', 'open-settings'])

function ShortcutRow({ action, label, keys }: { action: string; label: string; keys: string }) {
  const { t } = useTranslation()
  const [recording, setRecording] = useState(false)
  const [conflict, setConflict] = useState<string | null>(null)
  const updateShortcut = useConfigStore((s) => s.updateShortcut)
  const allShortcuts = useConfigStore((s) => s.shortcuts)

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!recording) return
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        setRecording(false)
        setConflict(null)
        return
      }
      if (!isRecordableShortcutEvent(e)) return
      const formatted = formatShortcutKeyEvent(e)
      if (formatted) {
        const duplicate = allShortcuts.find((s) => s.keys === formatted && s.action !== action)
        if (duplicate) {
          setConflict(t('settings.alreadyUsedBy', { label: duplicate.label }))
          return
        }
        setConflict(null)
        updateShortcut(action, formatted)
        setRecording(false)
      }
    },
    [recording, action, updateShortcut, allShortcuts, t],
  )

  useEffect(() => {
    if (recording) {
      window.addEventListener('keydown', handleKeyDown, true)
      return () => window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [recording, handleKeyDown])

  return (
    <div className="shortcuts-row">
      <span className="shortcuts-row__action">{label}</span>
      <span className="shortcuts-row__meta">
        {recording ? (
          <span className="shortcuts-row__recording">
            {conflict ? <span className="shortcuts-row__conflict">{conflict}</span> : t('settings.pressKeys')}
          </span>
        ) : (
          <span className="shortcuts-row__keys">
            {keys.trim()
              ? shortcutDisplayParts(keys).map((k, i) => (<kbd key={i}>{k}</kbd>))
              : <span className="shortcuts-row__off">{t('settings.shortcutOff', { defaultValue: 'Off' })}</span>}
          </span>
        )}
        <span className="shortcuts-row__actions">
          {!recording && keys.trim() && (
            <button className="shortcuts-row__edit shortcuts-row__clear" onClick={() => updateShortcut(action, '')}>
              {t('settings.shortcutClear', { defaultValue: 'Clear' })}
            </button>
          )}
          <button className="shortcuts-row__edit" onClick={() => setRecording(!recording)}>
            {recording ? t('settings.cancel') : t('settings.edit')}
          </button>
        </span>
      </span>
    </div>
  )
}

// ── Hook helpers ──
interface ToolHookStatus {
  toolId?: string
  adapterId?: string
  profileId?: string
  name: string
  displayName: string
  installed: boolean
  installStatus?: 'installed' | 'not_installed' | 'needs_reinstall' | 'settings_corrupted' | 'error' | string
  configPath?: string
  configDir?: string
  status: string
  version?: string
  supportsEventSelection?: boolean
  events?: HookEventStatus[]
  enabledEventNames?: string[]
  isCustom?: boolean
  customId?: string
}

function hookToolId(tool: ToolHookStatus) {
  return tool.toolId || tool.name
}

function hookCanInstall(tool: ToolHookStatus) {
  return tool.isCustom || tool.status !== 'Unavailable'
}

type HookInstallStatus = 'installed' | 'not_installed' | 'needs_reinstall' | 'settings_corrupted' | 'error'

function hookInstallStatus(tool: ToolHookStatus): HookInstallStatus {
  if (
    tool.installStatus === 'installed'
    || tool.installStatus === 'not_installed'
    || tool.installStatus === 'needs_reinstall'
    || tool.installStatus === 'settings_corrupted'
    || tool.installStatus === 'error'
  ) return tool.installStatus
  return tool.installed ? 'installed' : 'not_installed'
}

function hookInstallStatusLabel(t: (key: string, options?: Record<string, unknown>) => string, status: HookInstallStatus): string {
  if (status === 'installed') return t('settings.hookInstalled')
  if (status === 'needs_reinstall') return t('settings.hookNeedsReinstall', { defaultValue: '需重新安装' })
  if (status === 'settings_corrupted') return t('settings.hookSettingsCorrupted', { defaultValue: '配置异常' })
  if (status === 'error') return t('settings.hookError', { defaultValue: '异常' })
  return t('settings.hookNotInstalled')
}

function hookDoctorSuggestion(t: (key: string, options?: Record<string, unknown>) => string, check: HookDoctorCheck): string | null {
  if (check.status === 'ok' || check.status === 'info') return null
  if (check.id === 'bridge-binary') {
    return t('settings.hookDoctorSuggestionBridge', { defaultValue: 'Restart Agent Island. If it still fails, reinstall the app.' })
  }
  if (check.id === 'hook-server' || check.id === 'hook-server-tcp') {
    return t('settings.hookDoctorSuggestionServer', { defaultValue: 'Keep Agent Island running and check again. New CLI sessions connect to the current Hook service.' })
  }
  if (check.id === 'installed-hooks') {
    return t('settings.hookDoctorSuggestionInstall', { defaultValue: 'Click Install All Hooks, then restart the corresponding CLI sessions.' })
  }
  if (check.id === 'automation-permission') {
    return t('settings.hookDoctorSuggestionAutomation', { defaultValue: 'Allow Agent Island to control Terminal and System Events in macOS System Settings.' })
  }
  if (check.id === 'codex-cli') {
    return t('settings.hookDoctorSuggestionCodexCli', { defaultValue: 'Install Codex CLI or expose the real codex executable. Codex Desktop / WindowsApps launchers cannot be used for hooks.' })
  }
  if (check.id === 'codex-app-server-command') {
    return t('settings.hookDoctorSuggestionCodexAppServer', { defaultValue: 'Update Codex CLI to a build that supports `codex app-server`, then run diagnostics again.' })
  }
  if (check.id.startsWith('binary-')) {
    return t('settings.hookDoctorSuggestionBinary', { defaultValue: 'Install this only if you use the corresponding terminal multiplexer or terminal; otherwise it can be ignored.' })
  }
  return t('settings.hookDoctorSuggestionGeneric', { defaultValue: 'Fix the issue from the detail above, then run diagnostics again.' })
}

// ═══════════════════════════════════════════════
// Main IslandSection
// ═══════════════════════════════════════════════

interface IslandSectionProps {
  activeView: IslandSettingsView
}

export function IslandSection({ activeView }: IslandSectionProps) {
  const { t } = useTranslation()

  return (
    <SettingSection className="setting-section--compact island-settings-section" title={t('settings.island.title')} description={t('settings.island.desc')}>
      {activeView === 'overview' && <OverviewTab />}
      {activeView === 'display' && <DisplayTab />}
      {activeView === 'behavior' && <BehaviorTab />}
      {activeView === 'integration' && <IntegrationTab />}
      {activeView === 'keys' && <ShortcutsTab />}
      {activeView === 'advanced' && <AdvancedTab />}
    </SettingSection>
  )
}

// ── Overview Tab ──
function OverviewTab() {
  const { t } = useTranslation()
  const config = useConfigStore()
  const activeInteractionPreset = (
    config.interactionMode === QUIET_ASSISTANT_PRESET.interactionMode
    && config.smartSuppression === QUIET_ASSISTANT_PRESET.smartSuppression
    && config.autoHideNoSessions === QUIET_ASSISTANT_PRESET.autoHideNoSessions
    && config.idleCompactDwellSeconds === QUIET_ASSISTANT_PRESET.idleCompactDwellSeconds
    && config.noSessionsHideDelay === QUIET_ASSISTANT_PRESET.noSessionsHideDelay
  ) ? 'quiet' : (
    config.interactionMode === PERSISTENT_MONITOR_PRESET.interactionMode
    && config.smartSuppression === PERSISTENT_MONITOR_PRESET.smartSuppression
    && config.autoHideNoSessions === PERSISTENT_MONITOR_PRESET.autoHideNoSessions
    && config.idleCompactDwellSeconds === PERSISTENT_MONITOR_PRESET.idleCompactDwellSeconds
    && config.noSessionsHideDelay === PERSISTENT_MONITOR_PRESET.noSessionsHideDelay
  ) ? 'persistent' : 'custom'

  const applyInteractionPreset = (preset: typeof QUIET_ASSISTANT_PRESET | typeof PERSISTENT_MONITOR_PRESET) => {
    config.updateConfig('interactionMode', preset.interactionMode)
    config.updateConfig('smartSuppression', preset.smartSuppression)
    config.updateConfig('autoHideNoSessions', preset.autoHideNoSessions)
    config.updateConfig('idleCompactDwellSeconds', preset.idleCompactDwellSeconds)
    config.updateConfig('noSessionsHideDelay', preset.noSessionsHideDelay)
  }

  const resetIslandDefaults = () => {
    config.resetIslandDefaults()
    setDisplayId('auto')
      .then(() => repositionNotch('auto', 0))
      .catch((e) => console.error('Failed to reset island position:', e))
  }

  return (
    <>
      <div className="overview-showcase">
        <div className="overview-hero" aria-hidden="true">
          <div className="overview-hero__wallpaper">
            <span className="overview-hero__stripe overview-hero__stripe--blue" />
            <span className="overview-hero__stripe overview-hero__stripe--cyan" />
            <span className="overview-hero__stripe overview-hero__stripe--warm" />
            <span className="overview-hero__stripe overview-hero__stripe--gold" />
          </div>
          <div className="overview-live-pill">
            <img src="/agent-island-app-icon.png" className="overview-live-pill__icon" alt="Agent Island" />
            <span className="overview-live-pill__copy">
              <strong>Agent Island</strong>
              <span>让Agent更好用</span>
            </span>
          </div>
        </div>

        <div className="overview-mode-grid">
          <button
            aria-pressed={activeInteractionPreset === 'quiet'}
            className={`overview-mode-card ${activeInteractionPreset === 'quiet' ? 'overview-mode-card--active' : ''}`}
            type="button"
            onClick={() => applyInteractionPreset(QUIET_ASSISTANT_PRESET)}
          >
            <span className="overview-mode-card__island" />
            <strong>{t('settings.island.overview.quietAssistant', { defaultValue: 'Quiet Assistant' })}</strong>
            <span className="overview-mode-card__description">{t('settings.island.overview.quietAssistantDesc', { defaultValue: 'Hidden while agents run; appears for approvals, questions, failures, and completion notifications.' })}</span>
          </button>
          <button
            aria-pressed={activeInteractionPreset === 'persistent'}
            className={`overview-mode-card ${activeInteractionPreset === 'persistent' ? 'overview-mode-card--active' : ''}`}
            type="button"
            onClick={() => applyInteractionPreset(PERSISTENT_MONITOR_PRESET)}
          >
            <span className="overview-mode-card__island" />
            <strong>{t('settings.island.overview.persistentMonitor', { defaultValue: 'Persistent Monitor' })}</strong>
            <span className="overview-mode-card__description">{t('settings.island.overview.persistentMonitorDesc', { defaultValue: 'Keeps the island visible while agents run, then returns to a mini island when idle.' })}</span>
          </button>
          {activeInteractionPreset === 'custom' && (
            <div className="overview-mode-custom" role="status">
              <strong>{t('settings.island.overview.customPreset', { defaultValue: 'Custom visibility' })}</strong>
              <span>{t('settings.island.overview.customPresetDesc', { defaultValue: 'One or more visibility timing settings differ from the presets below.' })}</span>
            </div>
          )}
        </div>
      </div>

      <div className="overview-section-heading">
        <h3>{t('settings.island.overview.coreSwitches', { defaultValue: 'Core Switches' })}</h3>
        <p>{t('settings.island.overview.coreSwitchesDesc', { defaultValue: 'Primary controls for visibility, focus behavior, and suppression.' })}</p>
      </div>

      <SettingGroup>
        <SettingRow label={t('settings.islandResetDefaults')} description={t('settings.islandResetDefaultsDesc')}>
          <GlassButton variant="secondary" onClick={resetIslandDefaults}>
            {t('settings.reset')}
          </GlassButton>
        </SettingRow>
      </SettingGroup>

      <SettingGroup>
        <SettingRow label={t('settings.islandEnabled', { defaultValue: 'Enable Island' })} description={t('settings.islandEnabledDesc', { defaultValue: 'Show Agent Island status, approvals, questions, and completions in the floating island.' })}>
          <Toggle checked={config.islandEnabled} onChange={(v) => {
            config.updateConfig('islandEnabled', v)
            if (v) {
              applyInteractionPreset(PERSISTENT_MONITOR_PRESET)
            }
          }} />
        </SettingRow>
        <SettingRow label={t('settings.islandMonitorSubagents', { defaultValue: 'Monitor subagents' })} description={t('settings.islandMonitorSubagentsDesc', { defaultValue: 'Surface subagent activity and completion history in the island.' })}>
          <Toggle checked={config.islandMonitorSubagents} onChange={(v) => config.updateConfig('islandMonitorSubagents', v)} />
        </SettingRow>
        <SettingRow label={t('settings.tipsEnabled')} description={t('settings.tipsEnabledDesc')}>
          <Toggle checked={config.tipsEnabled} onChange={(v) => {
            config.updateConfig('tipsEnabled', v)
            persistIslandFeatureFlags({ tipsEnabled: v })
          }} />
        </SettingRow>
        <SettingRow label={t('settings.smartSuppression')} description={t('settings.smartSuppressionDesc')}>
          <Toggle checked={config.smartSuppression} onChange={(v) => config.updateConfig('smartSuppression', v)} />
        </SettingRow>
        <SettingRow label={t('settings.autoCollapse')} description={t('settings.autoCollapseDesc')}>
          <Toggle checked={config.autoCollapse} onChange={(v) => config.updateConfig('autoCollapse', v)} />
        </SettingRow>
        <SettingRow label={t('settings.autoHideNoSessions')} description={t('settings.autoHideNoSessionsDesc')}>
          <Toggle checked={config.autoHideNoSessions} onChange={(v) => config.updateConfig('autoHideNoSessions', v)} />
        </SettingRow>
      </SettingGroup>
    </>
  )
}

// ── Behavior Tab ──
function BehaviorTab() {
  const { t } = useTranslation()
  const config = useConfigStore()

  const idleTimeoutOptions = [
    { value: '0', label: t('settings.idleTimeoutDisabled') },
    { value: '1', label: t('settings.idleTimeoutMinutes', { minutes: 1 }) },
    { value: '5', label: t('settings.idleTimeoutMinutes', { minutes: 5 }) },
    { value: '10', label: t('settings.idleTimeoutMinutes', { minutes: 10 }) },
    { value: '15', label: t('settings.idleTimeoutMinutes', { minutes: 15 }) },
    { value: '30', label: t('settings.idleTimeoutMinutes', { minutes: 30 }) },
  ]
  const idleInteractionRoutingOptions = [
    { value: '1', label: t('settings.idleTimeoutMinutes', { minutes: 1 }) },
    { value: '5', label: t('settings.idleTimeoutMinutes', { minutes: 5 }) },
    { value: '10', label: t('settings.idleTimeoutMinutes', { minutes: 10 }) },
    { value: '15', label: t('settings.idleTimeoutMinutes', { minutes: 15 }) },
    { value: '30', label: t('settings.idleTimeoutMinutes', { minutes: 30 }) },
  ]

  return (
    <>
      <SettingGroup label={t('settings.island.section.expand', { defaultValue: 'Expand' })}>
        <SettingRow label={t('settings.hoverExpandDelay')} description={t('settings.hoverExpandDelayDesc')}>
          <Slider value={config.hoverExpandDelay} min={0} max={1000} step={50}
            onCommit={(v) => config.updateConfig('hoverExpandDelay', v)} unit="ms" />
        </SettingRow>
        <SettingRow label={t('settings.microHoverExpandDelay')} description={t('settings.microHoverExpandDelayDesc')}>
          <Slider value={config.microHoverExpandDelay} min={0} max={1000} step={50}
            onCommit={(v) => config.updateConfig('microHoverExpandDelay', v)} unit="ms" />
        </SettingRow>
        <SettingRow label={t('settings.collapseDelay')} description={t('settings.collapseDelayDesc')}>
          <Slider value={config.collapseDelay} min={100} max={1000} step={50}
            onCommit={(v) => config.updateConfig('collapseDelay', v)} unit="ms" />
        </SettingRow>
        <SettingRow label={t('settings.islandAnimationScale', { defaultValue: 'Animation Scale' })} description={t('settings.islandAnimationScaleDesc', { defaultValue: 'Adjust the speed of island open, close, and content motion.' })}>
          <Slider value={config.islandAnimationScale} min={0.25} max={6} step={0.25}
            onCommit={(v) => config.updateConfig('islandAnimationScale', v)} unit="x" />
        </SettingRow>
      </SettingGroup>

      <SettingGroup label={t('settings.island.section.hide', { defaultValue: 'Hide and Collapse' })}>
        <SettingRow label={t('settings.autoHideNoSessions')} description={t('settings.autoHideNoSessionsDesc')}>
          <Toggle checked={config.autoHideNoSessions} onChange={(v) => config.updateConfig('autoHideNoSessions', v)} />
        </SettingRow>
        <SettingRow label={t('settings.idleCompactDwell')} description={t('settings.idleCompactDwellDesc')}>
          <Slider value={config.idleCompactDwellSeconds} min={0} max={60} step={1}
            onCommit={(v) => config.updateConfig('idleCompactDwellSeconds', v)} unit="s" />
        </SettingRow>
        <SettingRow label={t('settings.noSessionsHideDelay')} description={t('settings.noSessionsHideDelayDesc')}>
          <Slider value={config.noSessionsHideDelay} min={1} max={30} step={1}
            onCommit={(v) => config.updateConfig('noSessionsHideDelay', v)} unit="min" />
        </SettingRow>
      </SettingGroup>

      <SettingGroup label={t('settings.island.section.dwell', { defaultValue: 'Dwell Time' })}>
        <SettingRow label={t('settings.taskCompleteDwell')} description={t('settings.taskCompleteDwellDesc')}>
          <Slider value={config.taskCompleteDwellSeconds} min={1} max={30} step={1}
            onCommit={(v) => config.updateConfig('taskCompleteDwellSeconds', v)} unit="s" />
        </SettingRow>
        <SettingRow label={t('settings.escSilenceDuration')} description={t('settings.escSilenceDurationDesc')}>
          <Slider value={config.escSilenceDuration} min={10} max={300} step={10}
            onCommit={(v) => config.updateConfig('escSilenceDuration', v)} unit="s" />
        </SettingRow>
      </SettingGroup>

      <SettingGroup label={t('settings.island.section.sessionHandling', { defaultValue: 'Session Handling' })}>
        <SettingRow label={t('settings.clickToDetail')} description={t('settings.clickToDetailDesc')}>
          <Toggle checked={config.clickToDetail} onChange={(v) => config.updateConfig('clickToDetail', v)} />
        </SettingRow>
        <SettingRow label={t('settings.jumpBeforeSend')} description={t('settings.jumpBeforeSendDesc')}>
          <Toggle checked={config.jumpBeforeSend} onChange={(v) => config.updateConfig('jumpBeforeSend', v)} />
        </SettingRow>
        <SettingRow label={t('settings.carouselInterval')} description={t('settings.carouselIntervalDesc')}>
          <Slider value={config.carouselIntervalMs} min={1000} max={10000} step={500}
            onCommit={(v) => config.updateConfig('carouselIntervalMs', v)} unit="ms" />
        </SettingRow>
        <SettingRow label={t('settings.idleTimeout')} description={t('settings.idleTimeoutDesc')}>
          <Dropdown value={String(config.idleTimeoutMinutes)} options={idleTimeoutOptions}
            onChange={(v) => config.updateConfig('idleTimeoutMinutes', Number(v))} minWidth={130} />
        </SettingRow>
        <SettingRow label={t('settings.idleInteractionRouting')} description={t('settings.idleInteractionRoutingDesc')}>
          <Toggle checked={config.idleInteractionRoutingEnabled} onChange={(v) => {
            config.updateConfig('idleInteractionRoutingEnabled', v)
            persistIdleInteractionRouting({ enabled: v })
          }} />
        </SettingRow>
        {config.idleInteractionRoutingEnabled && (
          <SettingRow label={t('settings.idleInteractionRoutingMinutes')} description={t('settings.idleInteractionRoutingMinutesDesc')}>
            <Dropdown
              value={String(config.idleInteractionRoutingMinutes)}
              options={idleInteractionRoutingOptions}
              onChange={(v) => {
                const minutes = Number(v)
                config.updateConfig('idleInteractionRoutingMinutes', minutes)
                persistIdleInteractionRouting({ minutes })
              }}
              minWidth={130}
            />
          </SettingRow>
        )}
        <SettingRow label={t('settings.sessionTimeout')} description={t('settings.sessionTimeoutDesc')}>
          <Slider value={config.sessionTimeoutMinutes} min={1} max={120} step={1}
            onCommit={(v) => config.updateConfig('sessionTimeoutMinutes', v)} unit="min" />
        </SettingRow>
      </SettingGroup>
    </>
  )
}

// ── Display Tab ──
function DisplayTab() {
  const { t, i18n } = useTranslation()
  const config = useConfigStore()
  const { themes, activeThemeName, setActiveTheme, colorTheme, setColorTheme } = useThemeStore()
  const isZh = i18n.language?.startsWith('zh')
  const [displays, setDisplays] = useState<BackendDisplayInfo[]>([])
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const compactPillWidthValue = Math.round(config.compactPillWidth * (config.collapsedWidthScale / 100))

  useEffect(() => {
    listDisplays().then(setDisplays)
    if (!isTauri()) return
    let unlisten: (() => void) | undefined
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<BackendDisplayInfo[]>('display-changed', (e) => { setDisplays(e.payload) }).then((fn) => { unlisten = fn })
    })
    return () => { unlisten?.() }
  }, [])

  const previewLayout = useCallback((mode: IslandLayoutPreviewMode, overrides: IslandLayoutPreviewOptions = {}) => {
    const state = useConfigStore.getState()
    previewIslandLayout(mode, {
      collapsedWidthScale: state.collapsedWidthScale,
      microPillWidth: state.microPillWidth,
      compactPillWidth: state.compactPillWidth,
      panelMaxWidth: state.panelMaxWidth,
      notchHeightMode: state.notchHeightMode,
      customNotchHeight: state.customNotchHeight,
      contentFontSize: state.contentFontSize,
      completionCardHeight: state.completionCardHeight,
      maxPanelHeight: state.maxPanelHeight,
      detailPanelMaxHeight: state.detailPanelMaxHeight,
      ...overrides,
    }).catch((e) => console.error('Failed to preview island layout:', e))
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current)
    previewTimerRef.current = setTimeout(() => {
      clearIslandLayoutPreview().catch(() => {})
      previewTimerRef.current = undefined
    }, 1800)
  }, [])

  useEffect(() => () => {
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current)
    clearIslandLayoutPreview().catch(() => {})
  }, [])

  const fontSizeOptions = [
    { value: '11px', label: `11px - ${t('settings.fontSizeSmall', { defaultValue: 'Small' })}` },
    { value: '12px', label: `12px - ${t('settings.fontSizeCompact', { defaultValue: 'Compact' })}` },
    { value: '13px', label: `13px - ${t('settings.fontSizeDefault', { defaultValue: 'Default' })}` },
    { value: '14px', label: `14px - ${t('settings.fontSizeMedium', { defaultValue: 'Medium' })}` },
    { value: '16px', label: `16px - ${t('settings.fontSizeLarge', { defaultValue: 'Large' })}` },
  ]
  const hoverSpeedOptions = [
    { value: 'instant', label: t('settings.hoverSpeedInstant') },
    { value: 'normal', label: t('settings.hoverSpeedNormal') },
    { value: 'slow', label: t('settings.hoverSpeedSlow') },
  ]
  const maxVisibleSessionOptions = [
    { value: '3', label: '3' },
    { value: '5', label: '5' },
    { value: '8', label: '8' },
    { value: '10', label: '10' },
    { value: '0', label: t('settings.maxVisibleSessionsUnlimited') },
  ]
  const sessionRefreshIntervalOptions = [1, 2, 3, 5, 10, 30].map((seconds) => ({
    value: String(seconds),
    label: `${seconds}s`,
  }))
  const monitorOptions = [
    {
      value: 'primary',
      label: displays.find((d) => d.isPrimary)?.label
        ? `${t('settings.mainDisplay')} · ${displays.find((d) => d.isPrimary)?.label}`
        : t('settings.mainDisplay'),
    },
    { value: 'auto', label: t('settings.autoFollowFocus') },
    ...displays
      .filter((d) => !d.isPrimary)
      .map((d) => ({ value: d.id, label: d.label })),
  ]
  const displayMonitorValue = normalizeDisplayMonitorValue(config.displayMonitor, displays)

  const islandPositionLabel = config.panelHorizontalOffset === 0
    ? t('settings.islandPositionCenter', { defaultValue: 'Centered' })
    : config.panelHorizontalOffset < 0
      ? t('settings.islandPositionLeft', { defaultValue: '{{value}}px left', value: Math.abs(config.panelHorizontalOffset) })
      : t('settings.islandPositionRight', { defaultValue: '{{value}}px right', value: config.panelHorizontalOffset })

  return (
    <>
      <SettingGroup label={t('settings.island.section.surface', { defaultValue: '展示形态' })}>
        <div className="pet-picker-block">
          <div className="pet-picker-block__header">
            <div className="pet-picker-block__title">{t('settings.activeTheme')}</div>
            <div className="pet-picker-block__desc">{t('settings.activeThemeDesc')}</div>
          </div>
          <ThemePicker
            themes={themes}
            activeThemeName={activeThemeName}
            onSelect={(name) => {
              setActiveTheme(name)
              setActiveBackendTheme(name).catch((e) => console.error('Failed to persist active theme:', e))
            }}
            isZh={isZh}
          />
        </div>
      </SettingGroup>

      <SettingGroup label={t('settings.colorTheme')}>
        <div className="color-theme-cards">
          {COLOR_THEMES.map((ct) => (
            <button
              key={ct.id}
              type="button"
              className={`color-theme-card ${colorTheme === ct.id ? 'color-theme-card--active' : ''}`}
              onClick={() => {
                setColorTheme(ct.id)
                previewLayout('compact')
              }}
            >
              <div className="color-theme-card__preview">
                <div className="color-theme-card__swatch" style={{ background: ct.bg }}>
                  <div className="color-theme-card__swatch-card" style={{ background: ct.card }} />
                  <div className="color-theme-card__swatch-dot" style={{ background: ct.accent }} />
                </div>
              </div>
              <div className="color-theme-card__label">{isZh ? ct.labelZh : ct.label}</div>
              <div className="color-theme-card__tag">{ct.tag}</div>
            </button>
          ))}
        </div>
      </SettingGroup>

      <SettingGroup label={t('settings.island.section.displayPlacement', { defaultValue: '显示器位置' })}>
          <SettingRow label={t('settings.displayMonitor')} description={t('settings.displayMonitorDesc')}>
            <Dropdown value={displayMonitorValue} options={monitorOptions}
              onChange={(v) => {
                config.updateConfig('displayMonitor', v)
                setDisplayId(v)
                  .then(() => repositionNotch(v))
                  .catch((e) => console.error('Failed to set display:', e))
              }} minWidth={180} />
          </SettingRow>
          <SettingRow label={t('settings.allowHorizontalDrag')} description={t('settings.allowHorizontalDragDesc')}>
            <Toggle checked={config.allowHorizontalDrag} onChange={(v) => config.updateConfig('allowHorizontalDrag', v)} />
          </SettingRow>
          <SettingRow label={t('settings.resetIslandPosition', { defaultValue: 'Reset Island Position' })} description={islandPositionLabel}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button className="settings-mini-button" type="button" onClick={() => config.updateConfig('panelHorizontalOffset', 0)}>
                {t('settings.resetCenter', { defaultValue: 'Reset to Center' })}
              </button>
            </div>
          </SettingRow>
      </SettingGroup>

      <SettingGroup label={t('settings.panelSize')}>
        <SettingRow label={t('settings.maxVisibleSessions')} description={t('settings.maxVisibleSessionsDesc')}>
          <Dropdown value={String(config.maxVisibleSessions)} options={maxVisibleSessionOptions}
            onChange={(v) => { config.updateConfig('maxVisibleSessions', Number(v)); previewLayout('expanded') }} minWidth={120} />
        </SettingRow>
        <SettingRow label={t('settings.notchHeightMode')} description={t('settings.notchHeightModeDesc')}>
          <Dropdown value={config.notchHeightMode}
            options={[
              { value: 'matchNotch', label: t('settings.heightMatchNotch') },
              { value: 'matchMenuBar', label: t('settings.heightMatchMenuBar') },
              { value: 'custom', label: t('settings.heightCustom') },
            ]}
            onChange={(v) => {
              const notchHeightMode = v as 'matchNotch' | 'matchMenuBar' | 'custom'
              config.updateConfig('notchHeightMode', notchHeightMode)
              previewLayout('compact', { notchHeightMode })
            }} minWidth={160} />
        </SettingRow>
        {config.notchHeightMode === 'custom' && (
          <SettingRow label={t('settings.customNotchHeight')} description={`${config.customNotchHeight}px`}>
            <Slider value={config.customNotchHeight} min={CUSTOM_NOTCH_HEIGHT_MIN} max={CUSTOM_NOTCH_HEIGHT_MAX} step={1}
              onChange={(v) => previewLayout('compact', { notchHeightMode: 'custom', customNotchHeight: v })}
              onCommit={(v) => config.updateConfig('customNotchHeight', v)} unit="px" />
          </SettingRow>
        )}
        <SettingRow label={t('settings.microPillWidth', { defaultValue: 'Micro Pill Width' })} description={`${config.microPillWidth}px`}>
          <Slider value={config.microPillWidth} min={84} max={180} step={4}
            onChange={(v) => previewLayout('micro', { microPillWidth: v })}
            onCommit={(v) => config.updateConfig('microPillWidth', v)} unit="px" />
        </SettingRow>
        <SettingRow label={t('settings.compactPillWidth', { defaultValue: 'Compact Pill Width' })} description={`${compactPillWidthValue}px`}>
          <Slider value={compactPillWidthValue} min={260} max={520} step={10}
            onChange={(v) => previewLayout('compact', { compactPillWidth: v, collapsedWidthScale: 100 })}
            onCommit={(v) => {
              config.updateConfig('compactPillWidth', v)
              config.updateConfig('collapsedWidthScale', 100)
            }} unit="px" />
        </SettingRow>
        <SettingRow label={t('settings.panelMaxWidth', { defaultValue: 'Expanded Panel Width' })} description={`${config.panelMaxWidth}px`}>
          <Slider value={config.panelMaxWidth} min={480} max={760} step={10}
            onChange={(v) => previewLayout('expanded', { panelMaxWidth: v })}
            onCommit={(v) => config.updateConfig('panelMaxWidth', v)} unit="px" />
        </SettingRow>
        <SettingRow label={t('settings.hoverSpeed')} description={t('settings.hoverSpeedDesc')}>
          <Dropdown value={config.hoverSpeed} options={hoverSpeedOptions}
            onChange={(v) => config.updateConfig('hoverSpeed', v as 'instant' | 'normal' | 'slow')} minWidth={160} />
        </SettingRow>
        <SettingRow
          label={t('settings.refreshRate', { defaultValue: '刷新频率' })}
          description={t('settings.refreshRateDesc', { defaultValue: '没有实时事件时，后台轮询会按此间隔补读会话状态。事件通知仍会立即更新。' })}
        >
          <Dropdown
            value={String(config.sessionRefreshIntervalSeconds)}
            options={sessionRefreshIntervalOptions}
            onChange={(v) => {
              const seconds = Number(v)
              config.updateConfig('sessionRefreshIntervalSeconds', seconds)
              persistSessionRefreshInterval(seconds)
            }}
            minWidth={120}
          />
        </SettingRow>
        <SettingRow
          label={t('settings.windowCloseBehavior', { defaultValue: '关闭窗口时' })}
          description={t('settings.windowCloseBehaviorDesc', { defaultValue: '点击桌面窗口右上角的叉时，选择隐藏到系统托盘或退出 Agent Island。' })}
        >
          <Dropdown
            value={config.windowCloseBehavior}
            options={[
              { value: 'tray', label: t('settings.windowCloseToTray', { defaultValue: '最小化到托盘' }) },
              { value: 'exit', label: t('settings.windowCloseExit', { defaultValue: '直接退出程序' }) },
            ]}
            onChange={(value) => {
              const behavior = value === 'exit' ? 'exit' : 'tray'
              config.updateConfig('windowCloseBehavior', behavior)
              persistWindowCloseBehavior(behavior)
            }}
            minWidth={160}
          />
        </SettingRow>
        <SettingRow label={t('settings.contentFontSize')}>
          <Dropdown value={config.contentFontSize} options={fontSizeOptions}
            onChange={(v) => { config.updateConfig('contentFontSize', v); previewLayout('expanded', { contentFontSize: v }) }} minWidth={160} />
        </SettingRow>
        <SettingRow label={t('settings.showToolStatus')} description={t('settings.showToolStatusDesc')}>
          <Toggle checked={config.showToolStatus} onChange={(v) => config.updateConfig('showToolStatus', v)} />
        </SettingRow>
        <SettingRow label={t('settings.completionCardHeight')} description={`${config.completionCardHeight}px`}>
          <Slider value={config.completionCardHeight} min={80} max={420} step={10}
            onChange={(v) => previewLayout('completion', { completionCardHeight: v })}
            onCommit={(v) => config.updateConfig('completionCardHeight', v)} unit="px" />
        </SettingRow>
        <SettingRow label={t('settings.maxPanelHeight')} description={`${config.maxPanelHeight}px`}>
          <Slider value={config.maxPanelHeight} min={300} max={800} step={20}
            onChange={(v) => previewLayout('expanded', { maxPanelHeight: v })}
            onCommit={(v) => config.updateConfig('maxPanelHeight', v)} unit="px" />
        </SettingRow>
        <SettingRow label={t('settings.detailPanelMaxHeight')} description={`${config.detailPanelMaxHeight}px`}>
          <Slider value={config.detailPanelMaxHeight} min={260} max={1200} step={20}
            onChange={(v) => previewLayout('expanded', { detailPanelMaxHeight: v })}
            onCommit={(v) => config.updateConfig('detailPanelMaxHeight', v)} unit="px" />
        </SettingRow>
      </SettingGroup>

    </>
  )
}

// ── Theme Pixel Preview (for themes without character sprites) ──

function ThemePixelPreview({ theme }: { theme: ThemeConfig }) {
  const colors = theme.priorityColors
  if (!colors) {
    return (
      <span className="theme-picker__pixel-icon" aria-hidden="true">
        <span /><span /><span /><span />
      </span>
    )
  }
  const fallback = '#888'
  const grid = [
    colors.idle ?? fallback, colors.working ?? fallback,
    colors.thinking ?? fallback, colors.done ?? fallback,
    colors.attention ?? fallback, colors.idle ?? fallback,
    colors.done ?? fallback, colors.working ?? fallback,
    colors.thinking ?? fallback,
  ]
  return (
    <span className="theme-picker__pixel-grid" aria-hidden="true">
      {grid.map((color, i) => (
        <span key={i} style={{ background: color, opacity: i % 3 === 0 ? 1 : 0.7 }} />
      ))}
    </span>
  )
}

// ── Theme Picker ──

interface ThemePickerProps {
  themes: ThemeConfig[]
  activeThemeName: string
  onSelect: (name: string) => void
  isZh: boolean
}

function ThemePicker({ themes, activeThemeName, onSelect, isZh }: ThemePickerProps) {
  const builtinThemes = themes.filter((th) => !th.isCodexPet)
  const codexPetThemes = themes.filter((th) => th.isCodexPet)

  const themeLabel = (th: ThemeConfig) => {
    if (th.name === 'ink-amber') return isZh ? 'Agent Island 经典' : 'Agent Island Classic'
    return th.displayName ?? th.name.charAt(0).toUpperCase() + th.name.slice(1).replace(/[-:]/g, ' ')
  }

  return (
    <div className="pet-picker">
      {builtinThemes.length > 0 && (
        <div className="pet-picker__group">
          <div className="pet-picker__group-label">{isZh ? '内置' : 'Built-in'}</div>
          <div className="pet-picker__grid">
            {builtinThemes.map((th) => (
              <button
                key={th.name}
                type="button"
                className={`pet-picker__card ${activeThemeName === th.name ? 'pet-picker__card--active' : ''}`}
                aria-pressed={activeThemeName === th.name}
                onClick={() => onSelect(th.name)}
                title={th.description ?? themeLabel(th)}
              >
                <div className="pet-picker__thumb">
                  {th.character ? (
                    <SpriteCanvas
                      theme={th}
                      priority={PRIORITY.idle}
                      size={56}
                      enableIdleBehaviors={false}
                      animationOverride="idle"
                    />
                  ) : (
                    <ThemePixelPreview theme={th} />
                  )}
                </div>
                <div className="pet-picker__name">{themeLabel(th)}</div>
              </button>
            ))}
          </div>
        </div>
      )}
      {codexPetThemes.length > 0 && (
        <div className="pet-picker__group">
          <div className="pet-picker__group-label">codex</div>
          <div className="pet-picker__grid">
            {codexPetThemes.map((th) => (
              <button
                key={th.name}
                type="button"
                className={`pet-picker__card ${activeThemeName === th.name ? 'pet-picker__card--active' : ''}`}
                aria-pressed={activeThemeName === th.name}
                onClick={() => onSelect(th.name)}
                title={th.description ?? themeLabel(th)}
              >
                <div className="pet-picker__thumb">
                  <SpriteCanvas
                    theme={th}
                    priority={PRIORITY.idle}
                    size={56}
                    enableIdleBehaviors={false}
                    animationOverride="idle"
                  />
                </div>
                <div className="pet-picker__name">{themeLabel(th)}</div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Shortcuts Tab ──
function ShortcutsTab() {
  const { t } = useTranslation()
  const shortcuts = useConfigStore((s) => s.shortcuts)
  const config = useConfigStore()
  const syncRequestRef = useRef(0)
  const [shortcutError, setShortcutError] = useState<string | null>(null)
  const [showAdvancedShortcuts, setShowAdvancedShortcuts] = useState(false)
  const primaryShortcuts = shortcuts.filter((shortcut) => PRIMARY_SHORTCUT_ACTIONS.has(shortcut.action))
  const advancedShortcuts = shortcuts.filter((shortcut) => !PRIMARY_SHORTCUT_ACTIONS.has(shortcut.action))
  const enabledAdvancedShortcutCount = advancedShortcuts.filter((shortcut) => shortcut.keys.trim()).length
  const latestShortcutDrafts = {
    globalShortcut: config.globalShortcut,
    shortcutApprove: config.shortcutApprove,
    shortcutDeny: config.shortcutDeny,
    shortcutSkip: config.shortcutSkip,
  }
  const shortcutDraftKey = [
    latestShortcutDrafts.globalShortcut,
    latestShortcutDrafts.shortcutApprove,
    latestShortcutDrafts.shortcutDeny,
    latestShortcutDrafts.shortcutSkip,
  ].join('\u0000')
  const [shortcutDraftState, setShortcutDraftState] = useState(() => ({
    key: shortcutDraftKey,
    drafts: latestShortcutDrafts,
  }))
  const shortcutDrafts = shortcutDraftState.key === shortcutDraftKey ? shortcutDraftState.drafts : latestShortcutDrafts
  const setShortcutDrafts = (
    update: typeof latestShortcutDrafts | ((drafts: typeof latestShortcutDrafts) => typeof latestShortcutDrafts),
  ) => {
    setShortcutDraftState((state) => {
      const base = state.key === shortcutDraftKey ? state.drafts : latestShortcutDrafts
      const drafts = typeof update === 'function' ? update(base) : update
      return { key: shortcutDraftKey, drafts }
    })
  }

  const formatShortcutError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    return t('settings.shortcutApplyFailed', {
      defaultValue: 'Shortcut could not be applied: {{message}}',
      message,
    })
  }

  const syncIslandGlobalShortcut = (value: string, previous: string) => {
    const requestId = ++syncRequestRef.current
    setShortcutError(null)
    registerGlobalShortcut(value).catch((error) => {
      if (requestId !== syncRequestRef.current) return
      config.updateConfig('globalShortcut', previous)
      setShortcutDrafts((drafts) => ({ ...drafts, globalShortcut: previous }))
      setShortcutError(formatShortcutError(error))
    })
  }

  const syncGlobalActions = (patch: Partial<{
    shortcutApprove: string
    shortcutApproveEnabled: boolean
    shortcutDeny: string
    shortcutDenyEnabled: boolean
    shortcutSkip: string
    shortcutSkipEnabled: boolean
  }>, rollback?: () => void) => {
    const next = {
      approve: patch.shortcutApprove ?? config.shortcutApprove,
      approveEnabled: patch.shortcutApproveEnabled ?? config.shortcutApproveEnabled,
      deny: patch.shortcutDeny ?? config.shortcutDeny,
      denyEnabled: patch.shortcutDenyEnabled ?? config.shortcutDenyEnabled,
      skip: patch.shortcutSkip ?? config.shortcutSkip,
      skipEnabled: patch.shortcutSkipEnabled ?? config.shortcutSkipEnabled,
    }
    const requestId = ++syncRequestRef.current
    setShortcutError(null)
    setGlobalActionShortcuts(next).catch((error) => {
      if (requestId !== syncRequestRef.current) return
      rollback?.()
      setShortcutError(formatShortcutError(error))
    })
  }
  const setIslandShortcut = (value: string) => {
    setShortcutDrafts((drafts) => ({ ...drafts, globalShortcut: value }))
  }
  const commitIslandShortcut = () => {
    const value = shortcutDrafts.globalShortcut.trim()
    if (value === config.globalShortcut) return
    const previous = config.globalShortcut
    config.updateConfig('globalShortcut', value)
    syncIslandGlobalShortcut(value, previous)
  }
  const setShortcut = <K extends 'shortcutApprove' | 'shortcutDeny' | 'shortcutSkip'>(key: K, value: string) => {
    setShortcutDrafts((drafts) => ({ ...drafts, [key]: value }))
  }
  const commitShortcut = <K extends 'shortcutApprove' | 'shortcutDeny' | 'shortcutSkip'>(key: K) => {
    const value = shortcutDrafts[key].trim()
    if (value === config[key]) return
    const previous = config[key]
    config.updateConfig(key, value)
    syncGlobalActions({ [key]: value }, () => {
      config.updateConfig(key, previous)
      setShortcutDrafts((drafts) => ({ ...drafts, [key]: previous }))
    })
  }
  const setShortcutEnabled = <K extends 'shortcutApproveEnabled' | 'shortcutDenyEnabled' | 'shortcutSkipEnabled'>(key: K, value: boolean) => {
    const previous = config[key]
    config.updateConfig(key, value)
    syncGlobalActions({ [key]: value }, () => config.updateConfig(key, previous))
  }
  const commitOnEnter = (event: ReactKeyboardEvent<HTMLInputElement>, commit: () => void) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    commit()
  }

  return (
    <>
      <SettingGroup label={t('settings.globalShortcuts', { defaultValue: 'Global Shortcuts' })}>
        <SettingRow
          label={t('settings.globalShortcut', { defaultValue: 'Toggle island visibility' })}
          description={t('settings.globalShortcutDesc', { defaultValue: 'Keyboard shortcut to toggle island visibility' })}
        >
          <div className="shortcut-global-control">
            <GlassInput
              className="shortcut-global-control__input"
              value={shortcutDrafts.globalShortcut}
              onChange={(e) => setIslandShortcut(e.target.value)}
              onBlur={commitIslandShortcut}
              onKeyDown={(e) => commitOnEnter(e, commitIslandShortcut)}
              placeholder="CommandOrControl+Shift+I"
            />
          </div>
        </SettingRow>
        <SettingRow
          label={t('settings.shortcutApprove', { defaultValue: 'Approve current permission' })}
          description={t('settings.shortcutApproveDesc', { defaultValue: 'Works even when the island is not focused' })}
        >
          <div className="shortcut-global-control">
            <Toggle checked={config.shortcutApproveEnabled} onChange={(v) => setShortcutEnabled('shortcutApproveEnabled', v)} />
            <GlassInput className="shortcut-global-control__input" value={shortcutDrafts.shortcutApprove} onChange={(e) => setShortcut('shortcutApprove', e.target.value)} onBlur={() => commitShortcut('shortcutApprove')} onKeyDown={(e) => commitOnEnter(e, () => commitShortcut('shortcutApprove'))} placeholder="CommandOrControl+Shift+A" />
          </div>
        </SettingRow>
        <SettingRow
          label={t('settings.shortcutDeny', { defaultValue: 'Deny current permission' })}
          description={t('settings.shortcutDenyDesc', { defaultValue: 'Sends a deny response to the oldest pending permission' })}
        >
          <div className="shortcut-global-control">
            <Toggle checked={config.shortcutDenyEnabled} onChange={(v) => setShortcutEnabled('shortcutDenyEnabled', v)} />
            <GlassInput className="shortcut-global-control__input" value={shortcutDrafts.shortcutDeny} onChange={(e) => setShortcut('shortcutDeny', e.target.value)} onBlur={() => commitShortcut('shortcutDeny')} onKeyDown={(e) => commitOnEnter(e, () => commitShortcut('shortcutDeny'))} placeholder="CommandOrControl+Shift+D" />
          </div>
        </SettingRow>
        <SettingRow
          label={t('settings.shortcutSkip', { defaultValue: 'Skip current question' })}
          description={t('settings.shortcutSkipDesc', { defaultValue: 'Selects the first answer for the oldest pending question' })}
        >
          <div className="shortcut-global-control">
            <Toggle checked={config.shortcutSkipEnabled} onChange={(v) => setShortcutEnabled('shortcutSkipEnabled', v)} />
            <GlassInput className="shortcut-global-control__input" value={shortcutDrafts.shortcutSkip} onChange={(e) => setShortcut('shortcutSkip', e.target.value)} onBlur={() => commitShortcut('shortcutSkip')} onKeyDown={(e) => commitOnEnter(e, () => commitShortcut('shortcutSkip'))} placeholder="CommandOrControl+Shift+S" />
          </div>
        </SettingRow>
        {shortcutError && <div className="shortcut-status shortcut-status--error" role="alert">{shortcutError}</div>}
      </SettingGroup>
      <SettingGroup label={t('settings.inWindowShortcuts', { defaultValue: 'In-Window Shortcuts' })}>
        <div className="shortcuts-table">
          {primaryShortcuts.map((s) => (
            <ShortcutRow
              key={s.action}
              action={s.action}
              label={t(`settings.shortcutActions.${s.action}`, { defaultValue: s.label })}
              keys={s.keys}
            />
          ))}
        </div>
        <div className="shortcuts-advanced">
          <button
            className="shortcuts-advanced__toggle"
            onClick={() => setShowAdvancedShortcuts((value) => !value)}
            type="button"
          >
            <span>{showAdvancedShortcuts
              ? t('settings.hideAdvancedShortcuts', { defaultValue: 'Hide advanced shortcuts' })
              : t('settings.showAdvancedShortcuts', { defaultValue: 'Show advanced shortcuts' })}</span>
            <span className="shortcuts-advanced__count">
              {t('settings.enabledAdvancedShortcuts', {
                defaultValue: '{{count}} enabled',
                count: enabledAdvancedShortcutCount,
              })}
            </span>
          </button>
          {showAdvancedShortcuts && (
            <div className="shortcuts-table shortcuts-table--advanced">
              {advancedShortcuts.map((s) => (
                <ShortcutRow
                  key={s.action}
                  action={s.action}
                  label={t(`settings.shortcutActions.${s.action}`, { defaultValue: s.label })}
                  keys={s.keys}
                />
              ))}
            </div>
          )}
        </div>
      </SettingGroup>
    </>
  )
}

// ── Integration Tab ──
function IntegrationTab() {
  const { t } = useTranslation()
  const config = useConfigStore()
  const [tools, setTools] = useState<ToolHookStatus[]>([])
  const [loading, setLoading] = useState(false)
  const [actionLoading, setActionLoading] = useState<Record<string, string>>({})
  const [selectedCustomProfileId, setSelectedCustomProfileId] = useState('')
  const [customInstallDir, setCustomInstallDir] = useState('')
  const [customName, setCustomName] = useState('')
  const [addingCustom, setAddingCustom] = useState(false)
  const [configuringTool, setConfiguringTool] = useState<ToolHookStatus | null>(null)
  const [bulkInstalling, setBulkInstalling] = useState(false)
  const [bulkUninstalling, setBulkUninstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [hookDoctorReport, setHookDoctorReport] = useState<HookDoctorReport | null>(null)
  const [hookDoctorBusy, setHookDoctorBusy] = useState(false)
  const [usageProviders, setUsageProviders] = useState<UsageProviderStatus[]>([])
  const [usageLoading, setUsageLoading] = useState(false)
  const [usageAction, setUsageAction] = useState<string | null>(null)
  const usageRequestSeq = useRef(0)

  const fetchStatus = useCallback(async () => {
    setLoading(true); setError(null); setNotice(null)
    if (!isTauri()) {
      setTools([])
      setLoading(false)
      return
    }
    try {
      const status = await invoke<ToolHookStatus[]>('get_all_hook_status')
      setTools(status)
    }
    catch (e) { setError(readableError(e)) }
    setLoading(false)
  }, [])

  const fetchUsageProviders = useCallback(async (options: { live?: boolean; showLoading?: boolean } = {}) => {
    const { live = true, showLoading = true } = options
    const requestSeq = ++usageRequestSeq.current
    if (!isTauri()) {
      setUsageProviders([])
      return
    }
    if (showLoading) setUsageLoading(true)
    try {
      const providers = await withTimeout(
        listUsageProviders(live),
        USAGE_PROVIDER_REFRESH_TIMEOUT_MS,
        t('settings.usageRefreshTimeout', { defaultValue: '用量查询超时，请稍后刷新。' }),
      )
      if (requestSeq === usageRequestSeq.current) {
        setUsageProviders(providers)
      }
    } catch (e) {
      if (showLoading && requestSeq === usageRequestSeq.current) {
        setError(readableError(e))
      }
    } finally {
      if (showLoading && requestSeq === usageRequestSeq.current) {
        setUsageLoading(false)
      }
    }
  }, [t])

  useEffect(() => {
    if (!config.islandExternalEnabled) return
    const timer = window.setTimeout(() => { fetchStatus() }, 0)
    return () => window.clearTimeout(timer)
  }, [fetchStatus, config.islandExternalEnabled])

  useEffect(() => {
    if (!config.islandExternalEnabled) return
    const timer = window.setTimeout(() => { fetchUsageProviders({ live: false, showLoading: false }) }, 0)
    return () => window.clearTimeout(timer)
  }, [fetchUsageProviders, config.islandExternalEnabled])

  const detectNow = async () => {
    if (!isTauri()) {
      setNotice(t('settings.desktopOnlyHooks', { defaultValue: 'Hook management is available in the desktop app.' }))
      return
    }
    await fetchStatus()
    await fetchUsageProviders({ live: true, showLoading: true })
    setNotice(t('settings.hookDetectDone', { defaultValue: '检测完成。' }))
  }

  const runDoctor = async () => {
    setError(null); setNotice(null)
    setHookDoctorBusy(true)
    try {
      setHookDoctorReport(await runHookDoctor())
    } catch (err) {
      setHookDoctorReport({
        generatedAt: Math.floor(Date.now() / 1000),
        checks: [{ id: 'doctor-error', label: 'Hook Doctor', status: 'error', detail: readableError(err) }],
      })
    } finally {
      setHookDoctorBusy(false)
    }
  }

  const setUsageQueryEnabled = (enabled: boolean) => {
    config.updateConfig('usageQueryEnabled', enabled)
    config.updateConfig('showUsageQuota', enabled)
    persistUsageQuerySettings({ usageQueryEnabled: enabled, showUsageQuota: enabled })
    window.setTimeout(() => { fetchUsageProviders({ live: false, showLoading: false }) }, 150)
  }

  const authorizeProvider = async (provider: string) => {
    setError(null); setNotice(null)
    if (!isTauri()) {
      setNotice(t('settings.desktopOnlyHooks', { defaultValue: 'Hook management is available in the desktop app.' }))
      return
    }
    setUsageAction(provider)
    try {
      await authorizeUsageProvider(provider)
      setNotice(t('settings.usageAuthStarted', { defaultValue: '已打开终端授权，完成登录后点检测刷新状态。' }))
    } catch (e) {
      setError(readableError(e))
    } finally {
      setUsageAction(null)
    }
  }

  const installAll = async () => {
    setError(null); setNotice(null)
    if (!isTauri()) {
      setNotice(t('settings.desktopOnlyHooks', { defaultValue: 'Hook management is available in the desktop app.' }))
      return
    }
    setBulkInstalling(true)
    try {
      const targets = visibleTools.filter(hookCanInstall).map((tool) => hookToolId(tool))
      if (targets.length === 0) {
        setNotice(t('settings.noInstallableHooks', { defaultValue: '没有检测到可安装 Hook 的 CLI。请先安装对应命令行工具后再检测。' }))
        setBulkInstalling(false)
        return
      }
      const errors: string[] = []
      for (const toolId of targets) {
        setToolAction(toolId, 'install')
        try {
          await invoke('install_agent_hook', { toolName: toolId })
        } catch (err) {
          errors.push(`${toolId}: ${readableError(err)}`)
        } finally {
          setToolAction(toolId, null)
        }
      }
      await fetchStatus()
      setNotice(errors.length > 0
        ? t('settings.hookInstallAllDoneWithErrors', { defaultValue: '部分 Hook 安装失败：{{errors}}', errors: errors.join('；') })
        : t('settings.hookInstallAllDone', { defaultValue: '全部 Hook 已安装。请重启对应 CLI 会话以加载最新配置。' }))
    } catch (e) { setError(readableError(e)) }
    setBulkInstalling(false)
  }

  const uninstallAll = async () => {
    setError(null); setNotice(null)
    if (!isTauri()) {
      setNotice(t('settings.desktopOnlyHooks', { defaultValue: 'Hook management is available in the desktop app.' }))
      return
    }
    const confirmed = await askDialog(
      t('settings.uninstallAllConfirmMessage', {
        defaultValue: '将清理 Agent Island 安装到所有 CLI 工具的 Hook 配置（含自定义安装），用于排错重装。继续？',
      }),
      {
        title: t('settings.uninstallAllConfirmTitle', { defaultValue: '一键卸载全部 Hook' }),
        kind: 'warning',
      }
    )
    if (!confirmed) return
    setBulkUninstalling(true)
    try {
      const errors = await uninstallAllHooks()
      await fetchStatus()
      setNotice(errors.length > 0
        ? t('settings.hookUninstallAllDoneWithErrors', { defaultValue: '部分 Hook 卸载失败：{{errors}}', errors: errors.join('；') })
        : t('settings.hookUninstallAllDone', { defaultValue: '已清理全部 Agent Island Hook，可重新安装。' }))
    } catch (e) { setError(readableError(e)) }
    setBulkUninstalling(false)
  }

  const setToolAction = (toolId: string, action: string | null) =>
    setActionLoading(prev => { const next = { ...prev }; if (action === null) delete next[toolId]; else next[toolId] = action; return next })

  const hookToolLabel = (toolId: string) => {
    const tool = visibleTools.find((item) => hookToolId(item) === toolId)
    return tool?.displayName || tool?.name || toolId
  }

  const hookInstallError = (toolId: string, error: unknown) => t('settings.hookInstallFailed', {
    defaultValue: '{{tool}} install failed: {{reason}}',
    tool: hookToolLabel(toolId),
    reason: readableError(error),
  })

  const hookReinstallError = (toolId: string, error: unknown) => t('settings.hookReinstallFailed', {
    defaultValue: '{{tool}} reinstall failed: {{reason}}',
    tool: hookToolLabel(toolId),
    reason: readableError(error),
  })

  const install = async (toolId: string) => {
    setError(null); setNotice(null)
    if (!isTauri()) {
      setNotice(t('settings.desktopOnlyHooks', { defaultValue: 'Hook management is available in the desktop app.' }))
      return
    }
    setToolAction(toolId, 'install')
    try {
      await invoke('install_agent_hook', { toolName: toolId })
      await fetchStatus()
      setNotice(t('settings.hookInstallDone', { defaultValue: 'Hook installed. Restart the corresponding CLI session to load it.' }))
    } catch (e) { setError(hookInstallError(toolId, e)) }
    setToolAction(toolId, null)
  }

  const uninstall = async (toolId: string) => {
    setError(null); setNotice(null)
    if (!isTauri()) {
      setNotice(t('settings.desktopOnlyHooks', { defaultValue: 'Hook management is available in the desktop app.' }))
      return
    }
    setToolAction(toolId, 'uninstall')
    try {
      await invoke('uninstall_agent_hook', { toolName: toolId })
      await fetchStatus()
      setNotice(t('settings.hookUninstallDone', { defaultValue: 'Hook uninstalled.' }))
    } catch (e) { setError(readableError(e)) }
    setToolAction(toolId, null)
  }

  const reinstall = async (toolId: string) => {
    setError(null); setNotice(null)
    if (!isTauri()) {
      setNotice(t('settings.desktopOnlyHooks', { defaultValue: 'Hook management is available in the desktop app.' }))
      return
    }
    setToolAction(toolId, 'reinstall')
    try {
      await invoke('install_agent_hook', { toolName: toolId })
      await fetchStatus()
      setNotice(t('settings.hookReinstallDone', { defaultValue: 'Hook reinstalled. Restart the corresponding CLI session to load it.' }))
    } catch (e) { setError(hookReinstallError(toolId, e)) }
    setToolAction(toolId, null)
  }

  const configureEvents = async (tool: ToolHookStatus, enabledEvents: string[]) => {
    const toolId = hookToolId(tool)
    setError(null); setNotice(null)
    if (!isTauri()) {
      setNotice(t('settings.desktopOnlyHooks', { defaultValue: 'Hook management is available in the desktop app.' }))
      return
    }
    setToolAction(toolId, 'configure')
    try {
      await invoke('configure_agent_hook_events', { toolName: toolId, enabledEvents })
      await fetchStatus()
      setConfiguringTool(null)
      setNotice(t('settings.hookConfigSaved', { defaultValue: 'Hook configuration saved. Restart the corresponding CLI session to load it.' }))
    } catch (e) { setError(readableError(e)) }
    setToolAction(toolId, null)
  }

  const openPath = async (path?: string) => {
    if (!path) return
    if (!isTauri()) {
      setNotice(t('settings.desktopOnlyHooks', { defaultValue: 'Hook management is available in the desktop app.' }))
      return
    }
    try { await invoke('open_system_path', { path }) }
    catch (e) { setError(readableError(e)) }
  }

  const addCustomHook = async () => {
    if (!selectedCustomProfileId || !customInstallDir.trim()) return
    if (!isTauri()) {
      setNotice(t('settings.desktopOnlyHooks', { defaultValue: 'Hook management is available in the desktop app.' }))
      return
    }
    setError(null); setNotice(null)
    try {
      const targetPath = await invoke<string>('install_custom_agent_hook', {
        profileId: selectedCustomProfileId,
        installDirectory: customInstallDir.trim(),
        customName: customName.trim() || null,
      })
      setSelectedCustomProfileId('')
      setCustomInstallDir('')
      setCustomName('')
      setAddingCustom(false)
      await fetchStatus()
      setNotice(t('settings.customHookInstalled', {
        defaultValue: 'Custom hook installed at {{path}}',
        path: targetPath,
      }))
    }
    catch (e) { setError(readableError(e)) }
  }

  const selectCustomInstallDir = async () => {
    if (!isTauri()) return
    const result = await openDialog({
      directory: true,
      multiple: false,
      title: t('settings.selectInstallDir', { defaultValue: 'Select install directory' }),
    })
    if (typeof result === 'string') setCustomInstallDir(result)
  }

  const visibleTools = config.islandExternalEnabled
    ? [...tools].sort((a, b) => Number(Boolean(b.isCustom)) - Number(Boolean(a.isCustom)))
    : []
  const accountUsageProviders = usageProviders
    .filter((provider) =>
      ACCOUNT_USAGE_PROVIDER_RANK.has(provider.provider)
      && (provider.catalogSupported || provider.implementationStatus === 'active'),
    )
    .sort((a, b) =>
      (ACCOUNT_USAGE_PROVIDER_RANK.get(a.provider) ?? Number.MAX_SAFE_INTEGER)
      - (ACCOUNT_USAGE_PROVIDER_RANK.get(b.provider) ?? Number.MAX_SAFE_INTEGER)
      || a.label.localeCompare(b.label),
    )
  const customProfileOptions = tools
    .filter((tool) => tool.adapterId || tool.name)
    .map((tool) => ({
      id: tool.adapterId || tool.name,
      label: tool.displayName || tool.name,
    }))
    .filter((tool, index, all) => all.findIndex((item) => item.id === tool.id) === index)
  const usageStatusLabel = (provider: UsageProviderStatus) => {
    if (!provider.enabled) return t('settings.disabled', { defaultValue: 'Disabled' })
    if (provider.available) return t('settings.connected', { defaultValue: 'Connected' })
    if (provider.authStatus === 'authorized') return t('settings.waitingData', { defaultValue: 'Waiting for data' })
    if (provider.authStatus === 'missing') return t('settings.needsAuth', { defaultValue: 'Needs authorization' })
    if (provider.implementationStatus === 'available') return t('settings.usageReaderAvailable', { defaultValue: '可接入' })
    if (provider.implementationStatus === 'unsupported') return t('settings.usageReaderPending', { defaultValue: '待接入' })
    return t('settings.needsAuth', { defaultValue: 'Needs authorization' })
  }

  const shouldShowUsageAuthorize = (provider: UsageProviderStatus) =>
    config.usageQueryEnabled
    && provider.canAuthorize
    && provider.authStatus !== 'authorized'
    && !provider.available

  return (
    <>
      {error && <div className="hook-error-card">{error}</div>}
      {notice && <div className="hook-notice-card">{notice}</div>}

      <SettingGroup
        actions={(
          <button className="settings-mini-button" disabled={hookDoctorBusy} onClick={runDoctor} type="button">
            {hookDoctorBusy ? t('settings.running', { defaultValue: 'Running...' }) : t('settings.runDiagnostics', { defaultValue: 'Run diagnostics' })}
          </button>
        )}
        label={t('settings.hookDoctor', { defaultValue: 'Hook Doctor' })}
      >
        <div className="hook-doctor-intro">
          {t('settings.hookDoctorInlineDesc', { defaultValue: 'Checks the Agent Island bridge, Hook service, installed Hooks, and platform-specific terminal integration.' })}
        </div>
        {hookDoctorReport && (
          <div className="hook-doctor-report">
            {hookDoctorReport.checks.map((check) => {
              const suggestion = hookDoctorSuggestion(t, check)
              return (
                <div className={`hook-doctor-check hook-doctor-check--${check.status}`} key={check.id}>
                  <strong>{check.status.toUpperCase()}</strong>
                  <div className="hook-doctor-check__body">
                    <div className="hook-doctor-check__label">{check.label}</div>
                    <div className="hook-doctor-check__detail">{check.detail}</div>
                    {suggestion && (
                      <div className="hook-doctor-check__suggestion">
                        {t('settings.hookDoctorNextStep', { defaultValue: 'Next step: ' })}{suggestion}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </SettingGroup>

      <SettingGroup
        actions={config.islandExternalEnabled ? (
          <>
            <button className="settings-mini-button" disabled={loading || bulkInstalling || bulkUninstalling} onClick={detectNow} type="button">
              {loading || usageLoading ? t('settings.detecting', { defaultValue: '检测中...' }) : t('settings.detectNow', { defaultValue: '一键检测' })}
            </button>
            <button className="settings-mini-button" disabled={loading || bulkInstalling || bulkUninstalling} onClick={installAll} type="button">
              {bulkInstalling ? t('settings.installing', { defaultValue: '安装中...' }) : t('settings.installAllHooks', { defaultValue: '一键全部安装' })}
            </button>
            <button className="settings-mini-button" disabled={loading || bulkInstalling || bulkUninstalling} onClick={uninstallAll} type="button">
              {bulkUninstalling ? t('settings.uninstalling', { defaultValue: '卸载中...' }) : t('settings.uninstallAllHooks', { defaultValue: '一键卸载全部' })}
            </button>
          </>
        ) : null}
        label={t('settings.detectedTools')}
      >
        {!config.islandExternalEnabled && <div className="hook-empty">{t('settings.island.integration.disabled', { defaultValue: 'External tracking disabled' })}</div>}
        {config.islandExternalEnabled && visibleTools.length === 0 && !loading && <div className="hook-empty">{t('settings.noToolsDetected')}</div>}
        {config.islandExternalEnabled && loading && visibleTools.length === 0 && <div className="hook-empty">{t('settings.detectingTools')}</div>}
        {visibleTools.map((tool) => {
          const toolId = hookToolId(tool)
          const installStatus = hookInstallStatus(tool)
          const cliUnavailable = tool.status === 'Unavailable'
          const busy = actionLoading[toolId] !== undefined || bulkInstalling || bulkUninstalling
          const installBlocked = busy
          const cliMissingTitle = cliUnavailable
            ? t('settings.cliNotInstalled', { defaultValue: 'CLI 未安装，请先安装对应的命令行工具' })
            : undefined
          const isInstalled = installStatus === 'installed' || installStatus === 'needs_reinstall' || installStatus === 'settings_corrupted'
          const canConfigureHook = installStatus === 'installed' && tool.supportsEventSelection && tool.events && tool.events.length > 0
          return (
            <div key={toolId} className="hook-tool-row">
              <div className="hook-tool-row__icon">
                <PlatformIcon agentId={toolId} displayName={tool.displayName || tool.name} size={30} />
              </div>
              <div className="hook-tool-row__info">
                <div className="hook-tool-row__name">
                  {tool.displayName || tool.name}
                  {tool.isCustom && (
                    <span className="hook-tool-row__custom-badge">
                      {t('settings.customTag', { defaultValue: '自定义' })}
                    </span>
                  )}
                </div>
                <div className="hook-tool-row__path">{tool.configPath || tool.status || toolId}</div>
              </div>
              <div className={`hook-status-badge hook-status-badge--${installStatus}`}>
                {hookInstallStatusLabel(t, installStatus)}
              </div>
              <div className="hook-tool-row__actions">
                {canConfigureHook && (
                  <GlassButton variant="ghost" onClick={() => setConfiguringTool(tool)} disabled={busy}>
                    {t('settings.configureHook', { defaultValue: '配置 Hook' })}
                  </GlassButton>
                )}
                <GlassButton variant="ghost" onClick={() => openPath(tool.configDir || tool.configPath)} disabled={busy || !(tool.configDir || tool.configPath)}>
                  {t('settings.openConfigDir', { defaultValue: '打开配置目录' })}
                </GlassButton>
                {isInstalled ? (
                  <>
                    <GlassButton variant="secondary" onClick={() => reinstall(toolId)} disabled={installBlocked} title={cliMissingTitle}>
                      {actionLoading[toolId] === 'reinstall' ? t('settings.installing', { defaultValue: 'Installing...' }) : t('settings.reinstall', { defaultValue: 'Reinstall' })}
                    </GlassButton>
                    <GlassButton variant="secondary" onClick={() => uninstall(toolId)} disabled={busy}>
                      {actionLoading[toolId] === 'uninstall' ? t('settings.uninstalling', { defaultValue: 'Uninstalling...' }) : t('settings.uninstall', { defaultValue: 'Uninstall' })}
                    </GlassButton>
                  </>
                ) : (
                  <GlassButton variant="secondary" onClick={() => install(toolId)} disabled={installBlocked} title={cliMissingTitle}>
                    {actionLoading[toolId] === 'install' ? t('settings.installing', { defaultValue: 'Installing...' }) : t('settings.install', { defaultValue: 'Install' })}
                  </GlassButton>
                )}
              </div>
            </div>
          )
        })}
      </SettingGroup>

      <SettingGroup label={t('settings.customHookConfig', { defaultValue: '自定义 Hook 配置' })}>
        {!addingCustom ? (
          <button className="engine-add-btn" onClick={() => { setSelectedCustomProfileId(''); setCustomInstallDir(''); setCustomName(''); setAddingCustom(true) }}>
            + {t('settings.addCustomHookConfig', { defaultValue: '添加自定义配置' })}
          </button>
        ) : (
          <div className="engine-add-form">
            <div className="engine-add-form__row">
              <label>{t('settings.customHookName', { defaultValue: '名称' })}</label>
              <GlassInput
                placeholder={t('settings.customHookNamePlaceholder', { defaultValue: '例如 My Custom Engine' })}
                value={customName}
                onChange={(e) => setCustomName((e.target as HTMLInputElement).value)}
                style={{ flex: 1 }}
              />
            </div>
            <div className="engine-add-form__row">
              <label>{t('settings.selectApp', { defaultValue: '选择应用' })}</label>
              <select
                className="glass-input"
                value={selectedCustomProfileId}
                onChange={(e) => setSelectedCustomProfileId(e.target.value)}
                style={{ flex: 1 }}
              >
                <option value="">{t('settings.selectPlaceholder', { defaultValue: '请选择...' })}</option>
                {customProfileOptions.map((profile) => (
                  <option key={profile.id} value={profile.id}>{profile.label}</option>
                ))}
              </select>
            </div>
            <div className="engine-add-form__row">
              <label>{t('settings.installDir', { defaultValue: '安装目录' })}</label>
              <div className="engine-add-form__path-input">
                <GlassInput
                  placeholder={t('settings.installDirPlaceholder', { defaultValue: '例如 /path/to/.claude' })}
                  value={customInstallDir}
                  onChange={(e) => setCustomInstallDir((e.target as HTMLInputElement).value)}
                  style={{ flex: 1 }}
                />
                <GlassButton variant="secondary" onClick={selectCustomInstallDir}>
                  {t('settings.selectDir', { defaultValue: '选择目录' })}
                </GlassButton>
              </div>
            </div>
            <div className="engine-add-form__actions">
              <button className="engine-add-form__cancel" onClick={() => { setAddingCustom(false); setSelectedCustomProfileId(''); setCustomInstallDir(''); setCustomName('') }}>{t('settings.cancel')}</button>
              <button className="engine-add-form__submit" disabled={!selectedCustomProfileId || !customInstallDir.trim()} onClick={addCustomHook}>{t('settings.install')}</button>
            </div>
          </div>
        )}
      </SettingGroup>

      <SettingGroup
        actions={(
          <button className="settings-mini-button" disabled={usageLoading} onClick={() => fetchUsageProviders({ live: true, showLoading: true })} type="button">
            {usageLoading ? t('settings.detecting', { defaultValue: '检测中...' }) : t('settings.refresh', { defaultValue: '刷新' })}
          </button>
        )}
        label={t('settings.accountQuota', { defaultValue: '账号配额' })}
      >
        <SettingRow
          label={t('settings.usageQueryEnabled', { defaultValue: '启用用量查询' })}
          description={t('settings.usageQueryEnabledDesc', { defaultValue: '后台读取官方账号或 CLI 的 Token 配额，用于灵动岛顶部显示。第三方 API/中转站用量后续在单独模块配置。' })}
        >
          <Toggle checked={config.usageQueryEnabled} onChange={setUsageQueryEnabled} />
        </SettingRow>
        {accountUsageProviders.length === 0 && (
          <div className="hook-empty">
            {t('settings.noAccountQuotaProviders', { defaultValue: '暂无可查询的官方账号配额。' })}
          </div>
        )}
        {accountUsageProviders.map((provider) => (
          <div className="usage-provider-row" key={provider.provider}>
            <div className="usage-provider-row__main">
              <div className="usage-provider-row__title">
                <span>{provider.label}</span>
                <strong>{usageStatusLabel(provider)}</strong>
              </div>
              <div className="usage-provider-row__detail" title={provider.authPath || provider.detail}>
                {provider.source ? `${provider.source} · ${provider.detail}` : provider.detail}
              </div>
              {provider.authPath && (
                <div className="usage-provider-row__path">{provider.authPath}</div>
              )}
            </div>
            <div className="usage-provider-row__actions">
              {provider.authPath && (
                <GlassButton variant="ghost" onClick={() => invoke('open_system_path', { path: provider.authPath })}>
                  {t('settings.openCredential', { defaultValue: '打开凭据' })}
                </GlassButton>
              )}
              {shouldShowUsageAuthorize(provider) && (
                <GlassButton
                  variant="secondary"
                  onClick={() => authorizeProvider(provider.provider)}
                  disabled={usageAction === provider.provider}
                >
                  {usageAction === provider.provider
                    ? t('settings.authorizing', { defaultValue: '授权中...' })
                    : t('settings.authorizeUsage', { defaultValue: '用量授权' })}
                </GlassButton>
              )}
            </div>
          </div>
        ))}
      </SettingGroup>

      {configuringTool && (
        <HookEventConfigDialog
          key={hookToolId(configuringTool)}
          hook={configuringTool}
          busy={actionLoading[hookToolId(configuringTool)] === 'configure'}
          onClose={() => setConfiguringTool(null)}
          onSave={(enabledEvents) => configureEvents(configuringTool, enabledEvents)}
        />
      )}
    </>
  )
}


// ── Advanced Tab ──
function AdvancedTab() {
  const { t } = useTranslation()
  const config = useConfigStore()

  return (
    <>
      <SettingGroup label={t('settings.island.section.visualSignals', { defaultValue: 'Visual Signals' })}>
        <SettingRow label={t('settings.agentActivity')} description={t('settings.agentActivityDesc')}>
          <Toggle checked={config.showAgentActivityDetails} onChange={(v) => config.updateConfig('showAgentActivityDetails', v)} />
        </SettingRow>
        <SettingRow label={t('settings.pixelCursor')} description={t('settings.pixelCursorDesc')}>
          <Toggle checked={config.pixelCursorEnabled} onChange={(v) => {
            config.updateConfig('pixelCursorEnabled', v)
            persistIslandFeatureFlags({ pixelCursorEnabled: v })
          }} />
        </SettingRow>
      </SettingGroup>

    </>
  )
}
