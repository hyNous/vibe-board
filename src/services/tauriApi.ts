/* Vibe Board — Tauri IPC API Service
 * Typed wrappers for Tauri commands with graceful browser-dev-mode fallbacks.
 */

import type { AgentRunState, AgentStatusSnapshot, RateLimitInfo, SessionNotice, SessionState, UsageRateWindow } from '../types/agent'
import type { SideIslandSize, IslandDragAnchor } from '../utils/islandLayout'
import type { AppLanguage } from '../i18n/language'

declare const __APP_VERSION__: string

/** Returns true when running inside a Tauri webview. */
export function isTauri(): boolean {
  if (typeof window === 'undefined') return false
  const tauriWindow = window as Window & {
    isTauri?: boolean | (() => boolean)
    __TAURI_INTERNALS__?: unknown
    __TAURI__?: unknown
  }
  if (typeof tauriWindow.isTauri === 'function') return tauriWindow.isTauri()
  if (typeof tauriWindow.isTauri === 'boolean') return tauriWindow.isTauri
  if (window.location.protocol === 'tauri:' || window.location.hostname === 'tauri.localhost') {
    return true
  }
  if (window.navigator.userAgent.includes('IsWebView2/True')) return true
  return '__TAURI_INTERNALS__' in tauriWindow || '__TAURI__' in tauriWindow
}

/** Lazy invoke — dynamically imports to avoid crash in browser dev mode. */
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const globalInvoke = (window as Window & {
    __TAURI__?: { core?: { invoke?: <R>(command: string, args?: Record<string, unknown>) => Promise<R> } }
  }).__TAURI__?.core?.invoke
  if (typeof globalInvoke === 'function') {
    return globalInvoke<T>(cmd, args)
  }
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
  return tauriInvoke<T>(cmd, args)
}

export async function getCurrentAppVersion(): Promise<string> {
  if (!isTauri()) return __APP_VERSION__

  try {
    const { getVersion } = await import('@tauri-apps/api/app')
    return await getVersion()
  } catch (error) {
    console.warn('[tauriApi] failed to read app version:', error)
    return __APP_VERSION__
  }
}

export async function restartApp(): Promise<void> {
  if (!isTauri()) return
  return invoke('restart_app')
}

// ── Backend Types (match Rust serde camelCase output) ────────────

export interface BackendSession {
  id: string
  agentType: string
  engineLabel: string | null
  engineConfigRoot: string | null
  codexAppServerThreadId?: string | null
  project: string
  cwd: string
  terminal: string
  phase: string
  runState?: AgentRunState | null
  startedAt: number
  duration: number
  tokens: { input: number; output: number; cacheRead: number; cacheCreate: number }
  rateLimits: {
    fiveHourUsage: number
    fiveHourRemaining: string
    sevenDayUsage: number
    sevenDayRemaining: string
    provider?: string
    providerLabel?: string
    source?: string
    updatedAt?: number
    windows?: RateLimitInfo['windows']
  } | null
  statusLineText: string | null
  contextWindow: {
    totalInputTokens: number
    totalOutputTokens: number
    contextWindowSize: number
    usedPercentage: number | null
  } | null
  lastMainAgentAt: number | null
  cacheTtlMs: number | null
  lastToolName: string | null
  lastToolTarget: string | null
  lastToolStatus: string | null
  description: string | null
  sessionTitle: string | null
  pid: number | null
  tty: string | null
  termProgram: string | null
  termBundleId: string | null
  weztermPane: string | null
  zellijPaneId: string | null
  zellijSessionName: string | null
  cmuxSurfaceId: string | null
  cmuxWorkspaceId: string | null
  subagents: Array<{
    agentId: string
    name: string | null
    agentType: string | null
    description: string
    transcriptPath: string | null
    agentTranscriptPath: string | null
    lastAssistantMessage: string | null
    startedAt: number
    completedAt: number | null
    status: string
    tools: string[]
  }>
  activeTools: Array<{
    toolUseId: string
    toolName: string
    status: string
    startedAt: number
    completedAt: number | null
    error: string | null
    toolInput?: string | null
  }>
  tasks: Array<{
    id: string
    name: string
    status: string
  }>
  isYoloMode: boolean
  model: string | null
  notice?: SessionNotice | null
  lastUserMessage: string | null
  lastResponse: string | null
  lastThought: string | null
}

export interface MonitorSessionSummary {
  id: string
  agentType: string
  engineLabel: string | null
  project: string
  cwd: string
  terminal: string
  phase: string
  startedAt: number
  duration: number
  tokenTotal: number
  lastToolName: string | null
  lastToolTarget: string | null
  lastToolStatus: string | null
  subagentCount: number
  activeToolCount: number
  title: string | null
}

export type UsageState = 'ok' | 'disabled' | 'unauthorized' | 'unavailable' | 'failed' | 'unsupported'

export interface UsageTokens {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
}

/**
 * Equivalent cost for a model or a period. `complete` is false when some usage
 * in the period has no price entry, so the UI marks the amount as a lower bound
 * instead of pretending it is exact. `verified` is false while the price entry
 * has not been confirmed against the vendor price page.
 */
export interface UsageCost {
  amount: number
  currency: string
  effectiveDate: string | null
  verified: boolean
  complete: boolean
}

export interface UsageModelPeriod {
  model: string
  tokens: UsageTokens
  requests: number
  cost: UsageCost | null
}

export interface UsagePeriod {
  id: 'today' | 'week' | 'month' | string
  tokens: UsageTokens | null
  requests: number | null
  cost: UsageCost | null
  models: UsageModelPeriod[]
  unpricedModels: string[]
}

export interface UsageHistory {
  available: boolean
  source: string | null
  detail: string
  sessionsScanned: number | null
  tokenEvents: number | null
  pricingEffectiveDate: string | null
  periods: UsagePeriod[]
}

export interface UsageHistoryScanStatus {
  scanning: boolean
  filesTotal: number
  filesScanned: number
  filesParsed: number
  filesSkipped: number
  oversizedLines: number
  events: number
  error: string | null
  startedAt: number | null
  finishedAt: number | null
}

/**
 * Normalized usage snapshot returned by the backend for every provider. The
 * Usage page renders these fields only — no provider-name branching.
 */
export interface UsageSnapshot {
  provider: string
  label: string
  state: UsageState
  detail: string
  source: string | null
  fetchedAt: number | null
  windows: UsageRateWindow[]
  history: UsageHistory
  enabled: boolean
  catalogSupported: boolean
  implementationStatus: 'active' | 'available' | 'unsupported'
  settingsOrder: number | null
  authStatus: 'authorized' | 'missing' | 'unknown'
  authPath: string | null
  canAuthorize: boolean
  /** True when this provider has a wired online query path (M8c). */
  networkSupported: boolean
  /** True only after the user authorized this provider's online query. */
  networkAuthorized: boolean
  networkKind: 'http' | 'cli' | null
  networkTarget: string | null
  /** Local credential file location; never the value. */
  networkCredential: string | null
  networkUnsupportedReason: string | null
  /** True when the tool exists on this machine (program, credential/config file, or local quota data). */
  detected: boolean
  /** When the stored login stops renewing itself (ms); used for an early reminder. */
  loginExpiresAt: number | null
}

export interface UsageDashboard {
  providers: UsageSnapshot[]
  computedAt: number
  /** Effective date of the built-in price table used for cost estimates. */
  pricingEffectiveDate: string | null
}

export interface BackendConfig {
  soundEnabled: boolean
  soundVolume: number
  launchAtLogin: boolean
  autoHide: boolean
  smartSuppression: boolean
  completionTimeout: number
  showTokenUsage: boolean
  usageQueryEnabled: boolean
  /** Provider ids the user allowed to query online; empty by default. */
  usageNetworkAuthorizedProviders: string[]
  codexAppServerSyncEnabled: boolean
  codexAppServerSyncConfigured?: boolean
  codexAppServerSyncIntervalSeconds: number
  sessionRefreshIntervalSeconds: number
  windowCloseBehavior: 'tray' | 'exit'
  hostVisibilityMode: 'independent' | 'follow'
  notchPositionMode: 'top' | 'left' | 'right'
  notchVerticalOffset: number
  language: AppLanguage
  displayId: string
  panelHorizontalOffset: number
  autoHideNoSessions: boolean
  soundEvents: Record<string, boolean>
  soundRules: Record<string, { enabled: boolean; sound: string }>
  customSounds: Array<{ id: string; name: string; path: string; dataUrl?: string }>
  soundPack: string
  bootSoundDefaultMigrated?: boolean
  probeSessionFilter: boolean
  excludedHookCwdSubstrings: string
  sessionSilenceRules: Array<{
    id: string
    kind: 'cwd' | 'prompt'
    pattern: string
    enabled: boolean
    createdAt: number
  }>
  tipsEnabled: boolean
  pixelCursorEnabled: boolean
  confettiEnabled: boolean
  followFocus: boolean
  quietHoursEnabled: boolean
  quietHoursStart: string
  quietHoursEnd: string
  idleTimeoutMinutes: number
  idleInteractionRoutingEnabled: boolean
  idleInteractionRoutingMinutes: number
  globalShortcut: string
  setupWizardCompleted: boolean
  autoLaunchAgents: string[]
}

export interface BackendDisplayInfo {
  id: string
  name: string
  label: string
  width: number
  height: number
  scaleFactor: number
  isPrimary: boolean
}

// ── Session Commands ─────────────────────────────────────────────

export async function getSessions(): Promise<BackendSession[]> {
  if (!isTauri()) return []
  return invoke<BackendSession[]>('get_sessions')
}

export async function getUsageRateLimits(): Promise<RateLimitInfo | null> {
  if (!isTauri()) return null
  return invoke<RateLimitInfo | null>('get_usage_rate_limits')
}

export async function getAgentStatuses(): Promise<AgentStatusSnapshot[]> {
  if (!isTauri()) return []
  return invoke<AgentStatusSnapshot[]>('get_agent_statuses')
}

export async function getUsageSnapshots(): Promise<RateLimitInfo[]> {
  if (!isTauri()) return []
  return invoke<RateLimitInfo[]>('get_usage_snapshots')
}

export async function getUsageDashboard(): Promise<UsageDashboard> {
  if (!isTauri()) return { providers: [], computedAt: Date.now(), pricingEffectiveDate: null }
  return invoke<UsageDashboard>('get_usage_dashboard')
}

const EMPTY_USAGE_HISTORY_SCAN: UsageHistoryScanStatus = {
  scanning: false,
  filesTotal: 0,
  filesScanned: 0,
  filesParsed: 0,
  filesSkipped: 0,
  oversizedLines: 0,
  events: 0,
  error: null,
  startedAt: null,
  finishedAt: null,
}

/** Starts the local usage-history scan; it runs in the background. */
export async function startUsageHistoryScan(): Promise<void> {
  if (!isTauri()) return
  return invoke('start_usage_history_scan')
}

export async function getUsageHistoryScanStatus(): Promise<UsageHistoryScanStatus> {
  if (!isTauri()) return EMPTY_USAGE_HISTORY_SCAN
  return invoke<UsageHistoryScanStatus>('get_usage_history_scan_status')
}

export interface AppStateFlags {
  codexAppServerLive: boolean
}

export async function getAppStateFlags(): Promise<AppStateFlags> {
  if (!isTauri()) return { codexAppServerLive: false }
  return invoke<AppStateFlags>('get_app_state_flags')
}

export async function listUsageProviders(live = true): Promise<UsageSnapshot[]> {
  if (!isTauri()) return []
  return invoke<UsageSnapshot[]>('list_usage_providers', { live })
}

export async function authorizeUsageProvider(provider: string): Promise<void> {
  if (!isTauri()) return
  return invoke('authorize_usage_provider', { provider })
}

/**
 * Grants or revokes one provider's permission to query online. Returns the
 * updated list of authorized provider ids. Nothing is queried while a provider
 * is absent from that list.
 */
export async function setUsageNetworkAuthorization(
  provider: string,
  authorized: boolean,
): Promise<string[]> {
  if (!isTauri()) return []
  return invoke<string[]>('set_usage_network_authorization', { provider, authorized })
}

export async function getMonitorSessions(): Promise<MonitorSessionSummary[]> {
  if (!isTauri()) return []
  return invoke<MonitorSessionSummary[]>('get_monitor_sessions')
}

let jumpInFlight = false

export async function activateSessionHost(sessionId: string): Promise<boolean> {
  if (!isTauri()) return false
  return invoke<boolean>('activate_session_host', { sessionId })
}

export async function jumpToTerminal(sessionId: string): Promise<void> {
  if (!isTauri()) {
    console.log(`[mock] jumpToTerminal(${sessionId})`)
    return
  }
  if (jumpInFlight) {
    return
  }
  jumpInFlight = true
  try {
    await invoke('jump_to_terminal', { sessionId })
  } finally {
    jumpInFlight = false
  }
}

// ── Config Commands ──────────────────────────────────────────────

export async function getConfig(): Promise<BackendConfig> {
  if (!isTauri()) {
    return {
      soundEnabled: true,
      soundVolume: 0.7,
      launchAtLogin: false,
      autoHide: true,
      smartSuppression: true,
      completionTimeout: 5,
      showTokenUsage: true,
      usageQueryEnabled: true,
      usageNetworkAuthorizedProviders: [],
      codexAppServerSyncEnabled: true,
      codexAppServerSyncConfigured: false,
      codexAppServerSyncIntervalSeconds: 30,
      sessionRefreshIntervalSeconds: 3,
      windowCloseBehavior: 'tray',
      hostVisibilityMode: 'independent',
      notchPositionMode: 'top',
      notchVerticalOffset: 0,
      language: 'en',
      displayId: 'primary',
      panelHorizontalOffset: 0,
      autoHideNoSessions: false,
      soundEvents: {},
      soundRules: {},
      customSounds: [],
      soundPack: 'synth',
      probeSessionFilter: false,
      excludedHookCwdSubstrings: '',
      sessionSilenceRules: [],
      tipsEnabled: true,
      pixelCursorEnabled: true,
      confettiEnabled: true,
      followFocus: false,
      quietHoursEnabled: false,
      quietHoursStart: '22:00',
      quietHoursEnd: '08:00',
      idleTimeoutMinutes: 5,
      idleInteractionRoutingEnabled: false,
      idleInteractionRoutingMinutes: 5,
      globalShortcut: 'CommandOrControl+Shift+I',
      setupWizardCompleted: false,
      autoLaunchAgents: [],
    }
  }
  return invoke<BackendConfig>('get_config')
}

export async function updateConfig(config: BackendConfig): Promise<void> {
  if (!isTauri()) {
    console.log('[mock] updateConfig:', config)
    return
  }
  return invoke('update_config', { config })
}

export async function setLanguage(language: AppLanguage): Promise<void> {
  if (!isTauri()) return
  return invoke('set_language', { language })
}

export async function setLaunchAtLogin(enabled: boolean): Promise<void> {
  if (!isTauri()) {
    console.log(`[mock] setLaunchAtLogin(${enabled})`)
    return
  }
  return invoke('set_launch_at_login', { enabled })
}

export interface HookDoctorCheck {
  id: string
  label: string
  status: 'ok' | 'warn' | 'error' | 'info'
  detail: string
}

export interface HookDoctorReport {
  generatedAt: number
  checks: HookDoctorCheck[]
}

export async function runHookDoctor(): Promise<HookDoctorReport> {
  if (!isTauri()) {
    return {
      generatedAt: Math.floor(Date.now() / 1000),
      checks: [
        { id: 'browser', label: 'Browser mode', status: 'warn', detail: 'Hook Doctor runs inside the Tauri app.' },
      ],
    }
  }
  return invoke<HookDoctorReport>('run_hook_doctor')
}

export async function setIslandFeatureFlags(options: {
  tipsEnabled: boolean
  pixelCursorEnabled: boolean
  confettiEnabled: boolean
  followFocus: boolean
}): Promise<void> {
  if (!isTauri()) return
  return invoke('set_island_feature_flags', options)
}

export async function setSoundEventRule(eventId: string, enabled: boolean, sound: string): Promise<void> {
  if (!isTauri()) return
  return invoke('set_sound_event_rule', { eventId, enabled, sound })
}

export async function registerGlobalShortcut(shortcut: string): Promise<void> {
  if (!isTauri()) return
  return invoke('register_global_shortcut', { shortcut })
}

// ── Chat History Commands ────────────────────────────────────────

/** Parsed message block from Rust ConversationParser */
export type ParsedMessageBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, string> }
  | { type: 'tool_result'; toolUseId: string; content: string | null; isError: boolean }
  | { type: 'thinking'; thinking: string }
  | { type: 'image'; source: string }
  | { type: 'interrupted' }

/** Parsed message from Rust ConversationParser */
export interface ParsedMessage {
  id: string
  role: 'user' | 'assistant'
  timestamp: string | null
  blocks: ParsedMessageBlock[]
}

export async function openSystemPath(path: string): Promise<void> {
  if (!isTauri()) {
    console.log(`[mock] openSystemPath(${path})`)
    return
  }
  return invoke('open_system_path', { path })
}

// ── Window Management ───────────────────────────────────────────

export type ResizeNotchResult = {
  anchorOffsetX: number
}

export async function resizeNotch(width: number, height: number, horizontalOffset = 0, displayId?: string): Promise<ResizeNotchResult> {
  if (!isTauri()) return { anchorOffsetX: 0 }
  return invoke<ResizeNotchResult>('resize_notch', { width, height, horizontalOffset, displayId })
}

/**
 * Set notch window opacity (0.0 = invisible, 1.0 = fully visible).
 * Uses opacity instead of hide/show because macOS breaks transparent
 * window compositing after a hide()/show() cycle.
 */
export async function setNotchOpacity(opacity: number): Promise<void> {
  if (!isTauri()) return
  return invoke('set_notch_opacity', { opacity })
}

// ── Window Focus Commands ───────────────────────────────────────

export async function setNotchFocusable(focusable: boolean): Promise<void> {
  if (!isTauri()) return
  return invoke('set_notch_focusable', { focusable })
}

export async function setNotchIgnoreCursorEvents(
  ignore: boolean,
  windowLabel?: 'notch',
): Promise<void> {
  if (!isTauri()) return
  return invoke('set_notch_ignore_cursor_events', { ignore, windowLabel })
}

export async function openSettingsWindow(): Promise<void> {
  if (!isTauri()) return
  return invoke('open_settings_window')
}

/** Open the offline tutorial bundled with the app in its own window. */
export async function openTutorialWindow(): Promise<void> {
  if (!isTauri()) return
  return invoke('open_tutorial_window')
}

/** Check if a session's owning terminal tab/window is currently focused. */
export async function isTerminalFocused(sessionId: string): Promise<boolean> {
  if (!isTauri()) return false
  return invoke<boolean>('is_terminal_focused', { sessionId })
}

/** Native fallback for transparent-window hover hit testing. */
export async function isCursorOverNotch(width?: number, height?: number, anchorOffsetX?: number, anchorOffsetY?: number): Promise<boolean> {
  if (!isTauri()) return false
  return invoke<boolean>('is_cursor_over_notch', { width, height, anchorOffsetX, anchorOffsetY })
}

// ── Display Commands ────────────────────────────────────────────

export async function listDisplays(): Promise<BackendDisplayInfo[]> {
  if (!isTauri()) return []
  return invoke<BackendDisplayInfo[]>('list_displays')
}

export async function setDisplayId(displayId: string): Promise<void> {
  if (!isTauri()) return
  return invoke('set_display_id', { displayId })
}

export async function repositionNotch(displayId?: string, horizontalOffset?: number): Promise<void> {
  if (!isTauri()) return
  return invoke('reposition_notch', { displayId, horizontalOffset })
}

export type IslandLayoutPreviewMode = 'micro' | 'compact' | 'expanded' | 'completion'

export interface IslandLayoutPreviewOptions {
  collapsedWidthScale?: number
  microPillWidth?: number
  compactPillWidth?: number
  panelMaxWidth?: number
  notchHeightMode?: 'matchNotch' | 'matchMenuBar' | 'custom'
  customNotchHeight?: number
  contentFontSize?: string
  completionCardHeight?: number
  maxPanelHeight?: number
  detailPanelMaxHeight?: number
  sideIslandSize?: SideIslandSize
}

export async function previewIslandLayout(mode: IslandLayoutPreviewMode, options?: IslandLayoutPreviewOptions): Promise<void> {
  if (!isTauri()) return
  return invoke('preview_island_layout', { mode, options: options ?? null })
}

export async function clearIslandLayoutPreview(): Promise<void> {
  if (!isTauri()) return
  return invoke('clear_island_layout_preview')
}

export async function startNotchDrag(
  horizontalOffset: number,
  width: number,
  height: number,
  displayId?: string,
  anchor?: IslandDragAnchor,
): Promise<boolean> {
  if (!isTauri()) return false
  return invoke<boolean>('start_notch_drag', {
    horizontalOffset,
    width,
    height,
    displayId,
    visibleWidth: anchor?.visibleWidth,
    visibleHeight: anchor?.visibleHeight,
    visibleOffsetX: anchor?.offsetX,
    visibleOffsetY: anchor?.offsetY,
  })
}

export type NotchDragResult = {
  horizontalOffset: number
  verticalOffset: number
  positionMode: 'top' | 'left' | 'right'
}

export async function endNotchDrag(): Promise<NotchDragResult | null> {
  if (!isTauri()) return null
  return invoke<NotchDragResult | null>('end_notch_drag')
}

// ── Diagnostics Commands ────────────────────────────────────────

export async function exportDiagnostics(targetPath: string): Promise<void> {
  if (!isTauri()) {
    // In browser dev mode, just log — no real zip to create
    console.log('[mock] exportDiagnostics to:', targetPath)
    return
  }
  return invoke<void>('export_diagnostics', { targetPath })
}

// ── App Lifecycle ──────────────────────────────────────────

// ── Persistence Commands ─────────────────────────────────────────

export async function saveSessions(sessions: SessionState[]): Promise<void> {
  if (!isTauri()) {
    console.log('[mock] saveSessions:', sessions.length, 'sessions')
    return
  }
  return invoke('save_sessions', { sessionsJson: JSON.stringify(sessions) })
}

// ── App Lifecycle ────────────────────────────────────────────────

export async function quitApp(): Promise<void> {
  if (!isTauri()) {
    window.close()
    return
  }
  try {
    await invoke('quit_app')
  } catch {
    window.close()
  }
}

// ── Agent Detection & Hook Management ────────────────────────────

export interface DetectedTool {
  name: string
  displayName: string
  status: 'Active' | 'Installed' | 'Available' | 'Unavailable'
  binaryPath: string | null
  configDir: string | null
}

export type HookEventCategory = 'approvals' | 'notifications' | 'lifecycle' | 'activity'

export interface HookEventStatus {
  name: string
  category: HookEventCategory
  categoryTitle: string
  categorySubtitle: string
  timeout?: number | null
  enabled: boolean
}

export interface HookStatus {
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
  supportsEventSelection?: boolean
  events?: HookEventStatus[]
  enabledEventNames?: string[]
  bridgeCommand?: string | null
  bridgePath?: string | null
  isCustom?: boolean
  customId?: string
}

export async function detectTools(): Promise<DetectedTool[]> {
  if (!isTauri()) return []
  return invoke<DetectedTool[]>('detect_tools')
}

export async function installAgentHook(toolName: string): Promise<void> {
  if (!isTauri()) return
  return invoke('install_agent_hook', { toolName })
}

export async function uninstallAgentHook(toolName: string): Promise<void> {
  if (!isTauri()) return
  return invoke('uninstall_agent_hook', { toolName })
}

export async function getAllHookStatus(): Promise<HookStatus[]> {
  if (!isTauri()) return []
  return invoke<HookStatus[]>('get_all_hook_status')
}

export async function reinstallAllHooks(): Promise<string[]> {
  if (!isTauri()) return []
  return invoke<string[]>('reinstall_all_hooks')
}

// ── Haptic Feedback ─────────────────────────────────────────────

export async function performHaptic(intensity: number): Promise<void> {
  if (!isTauri()) return
  return invoke('perform_haptic', { intensity })
}
