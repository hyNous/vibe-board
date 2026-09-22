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
}

export interface UsageDashboard {
  providers: UsageSnapshot[]
  computedAt: number
  /** Effective date of the built-in price table used for cost estimates. */
  pricingEffectiveDate: string | null
}

export interface CodexAppServerThreadSummary {
  id: string
  name?: string | null
  preview?: string | null
  cwd?: string | null
  status?: string | null
  phase: string
  updatedAt?: number | null
}

export interface CodexAppServerSyncReport {
  total: number
  synced: number
  read: number
  errors: string[]
  threads: CodexAppServerThreadSummary[]
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
  analyticsEnabled: boolean
  analyticsConsentPromptCompleted: boolean
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

export interface BackendAdapterInfo {
  name: string
  displayName: string
  icon: string
  status: string
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
      analyticsEnabled: true,
      analyticsConsentPromptCompleted: false,
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

export async function setAnalyticsEnabled(enabled: boolean): Promise<void> {
  if (!isTauri()) {
    console.log(`[mock] setAnalyticsEnabled(${enabled})`)
    return
  }
  return invoke('set_analytics_enabled', { enabled })
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

export interface CodexAppServerProbeCheck {
  id: string
  label: string
  status: 'ok' | 'warn' | 'error'
  detail: string
  suggestion?: string
}

export interface CodexAppServerProbe {
  port: number
  cliPath?: string | null
  cliVersion?: string | null
  desktopPath?: string | null
  cliAvailable: boolean
  appServerCommandAvailable: boolean
  serverListening: boolean
  codexAppInstalled: boolean
  authConfigured: boolean
  sessionsDirExists: boolean
  checks: CodexAppServerProbeCheck[]
}

export async function probeCodexAppServer(): Promise<CodexAppServerProbe> {
  if (!isTauri()) {
    return {
      port: 41241,
      cliPath: null,
      cliVersion: null,
      desktopPath: null,
      cliAvailable: false,
      appServerCommandAvailable: false,
      serverListening: false,
      codexAppInstalled: false,
      authConfigured: false,
      sessionsDirExists: false,
      checks: [
        { id: 'browser', label: 'Browser mode', status: 'warn', detail: 'Codex app-server diagnostics run inside the Tauri app.' },
      ],
    }
  }
  return invoke<CodexAppServerProbe>('probe_codex_app_server')
}

export interface BuddyDeviceConfig {
  enabled: boolean
  transport: string
  port: number
  sharedSecret: string
}

export interface BuddyDeviceSnapshot {
  protocolVersion: number
  sessions: Array<{
    id: string
    agentType: string
    sourceSlot: number
    project: string
    phase: string
    statusCode: number
    needsAttention: boolean
    lastToolName?: string | null
  }>
  focusAction: string
}

export async function buddyDeviceSnapshot(): Promise<BuddyDeviceSnapshot> {
  if (!isTauri()) return { protocolVersion: 1, sessions: [], focusAction: 'buddy_reverse_focus' }
  return invoke<BuddyDeviceSnapshot>('buddy_device_snapshot')
}

export async function getBuddyDeviceConfig(): Promise<BuddyDeviceConfig> {
  if (!isTauri()) return { enabled: false, transport: 'http', port: 17893, sharedSecret: '' }
  return invoke<BuddyDeviceConfig>('get_buddy_device_config')
}

export async function setBuddyDeviceConfig(config: BuddyDeviceConfig): Promise<BuddyDeviceConfig> {
  if (!isTauri()) return config
  return invoke<BuddyDeviceConfig>('set_buddy_device_config', { config })
}

export async function buddyReverseFocus(sessionId: string): Promise<void> {
  if (!isTauri()) return
  return invoke('buddy_reverse_focus', { sessionId })
}

// ── Hook Management ──────────────────────────────────────────────

export async function installHooks(agent: string): Promise<void> {
  if (!isTauri()) {
    console.log(`[mock] installHooks(${agent})`)
    return
  }
  return invoke('install_hooks', { agent })
}

export async function removeHooks(agent: string): Promise<void> {
  if (!isTauri()) {
    console.log(`[mock] removeHooks(${agent})`)
    return
  }
  return invoke('remove_hooks', { agent })
}

export async function getAdapterStatus(): Promise<BackendAdapterInfo[]> {
  if (!isTauri()) return []
  return invoke<BackendAdapterInfo[]>('get_adapter_status')
}

export type HookVerificationResult = 'ok' | 'needs_reinstall' | 'settings_corrupted'

export async function verifyHooks(agent: string): Promise<HookVerificationResult> {
  if (!isTauri()) return 'ok'
  return invoke<HookVerificationResult>('verify_hooks', { agent })
}

// ── Sound Commands ──────────────────────────────────────────

export async function setSoundVolume(volume: number): Promise<void> {
  if (!isTauri()) return
  return invoke('set_sound_volume', { volume })
}

export async function setSoundEnabled(enabled: boolean): Promise<void> {
  if (!isTauri()) return
  return invoke('set_sound_enabled', { enabled })
}

export async function setSoundPack(pack: string): Promise<void> {
  if (!isTauri()) return
  return invoke('set_sound_pack', { pack })
}

/** Play the sound configured for a given event id (e.g. 'permission-request'). No-op outside Tauri. */
export async function playSound(event: string): Promise<void> {
  if (!isTauri()) return
  return invoke('play_sound', { event })
}

export async function previewSound(event: string, sound: string): Promise<void> {
  if (!isTauri()) return
  return invoke('preview_sound', { event, sound })
}

export async function setProbeSessionFilter(enabled: boolean): Promise<void> {
  if (!isTauri()) return
  return invoke('set_probe_session_filter', { enabled })
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

export async function setSoundQuietHours(enabled: boolean, start: string, end: string): Promise<void> {
  if (!isTauri()) return
  return invoke('set_sound_quiet_hours', { enabled, start, end })
}

export async function setSoundEventEnabled(eventId: string, enabled: boolean): Promise<void> {
  if (!isTauri()) return
  return invoke('set_sound_event_enabled', { eventId, enabled })
}

export async function setSoundEventRule(eventId: string, enabled: boolean, sound: string): Promise<void> {
  if (!isTauri()) return
  return invoke('set_sound_event_rule', { eventId, enabled, sound })
}

export async function importCustomSound(filePath: string): Promise<{ id: string; name: string; path: string; dataUrl?: string }> {
  if (!isTauri()) {
    const normalized = filePath.replace(/\\/g, '/')
    return {
      id: `${Date.now()}`,
      name: normalized.split(/[\\/]+/).pop() || 'Custom sound',
      path: filePath,
    }
  }
  return invoke('import_custom_sound', { filePath })
}

export interface SoundPackImportResult {
  name: string
  displayName: string
  version?: string | null
  rootPath: string
  importedSounds: Array<{ id: string; name: string; path: string; dataUrl?: string; eventId: string; category: string }>
  appliedRules: Array<{ eventId: string; soundId: string }>
}

export async function importSoundPack(packPath: string): Promise<SoundPackImportResult> {
  if (!isTauri()) {
    return {
      name: 'preview-pack',
      displayName: 'Preview Pack',
      version: null,
      rootPath: packPath,
      importedSounds: [],
      appliedRules: [],
    }
  }
  return invoke('import_sound_pack', { packPath })
}

export async function setCustomSounds(sounds: Array<{ id: string; name: string; path: string; dataUrl?: string }>): Promise<void> {
  if (!isTauri()) return
  return invoke('set_custom_sounds', { sounds })
}

export async function registerGlobalShortcut(shortcut: string): Promise<void> {
  if (!isTauri()) return
  return invoke('register_global_shortcut', { shortcut })
}

export async function unregisterGlobalShortcut(): Promise<void> {
  if (!isTauri()) return
  return invoke('unregister_global_shortcut')
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

/** Request a full parse of a session's JSONL conversation file. */
export async function getChatHistory(sessionId: string): Promise<ParsedMessage[]> {
  if (!isTauri()) return []
  return invoke<ParsedMessage[]>('get_chat_history', { sessionId })
}

/** Paginated slice of a session's chat history. Matches Rust ChatHistorySlice. */
export interface ChatHistorySlice {
  messages: ParsedMessage[]
  hasMore: boolean
  firstMessageId: string | null
  totalCount: number
  transcriptPath: string | null
}

/**
 * Load only the tail (most recent N messages) of a session's transcript.
 * `beforeId` is kept for backend compatibility, but the floating chat view
 * intentionally avoids loading older pages for performance.
 */
export async function getChatHistoryTail(
  sessionId: string,
  options: { limit?: number; beforeId?: string } = {},
): Promise<ChatHistorySlice> {
  if (!isTauri()) {
    return { messages: [], hasMore: false, firstMessageId: null, totalCount: 0, transcriptPath: null }
  }
  return invoke<ChatHistorySlice>('get_chat_history_tail', {
    sessionId,
    limit: options.limit ?? 50,
    beforeId: options.beforeId ?? null,
  })
}

function demoSubagentChatHistory(transcriptPath: string): ParsedMessage[] {
  const iso = (offsetMs: number) => new Date(Date.now() - offsetMs).toISOString()

  if (transcriptPath === 'demo://subagent/coverage-running') {
    return [
      {
        id: 'demo-coverage-user',
        role: 'user',
        timestamp: iso(52_000),
        blocks: [
          { type: 'text', text: '检查 src/auth 测试覆盖缺口，只读不要改文件。' },
        ],
      },
      {
        id: 'demo-coverage-agent',
        role: 'assistant',
        timestamp: iso(38_000),
        blocks: [
          { type: 'thinking', thinking: '需要先定位 auth 相关测试，再 grep getToken / refreshToken 覆盖情况。' },
          {
            type: 'tool_use',
            id: 'demo-coverage-read',
            name: 'Read',
            input: { file_path: 'src/auth/middleware.test.ts' },
          },
          {
            type: 'tool_result',
            toolUseId: 'demo-coverage-read',
            content: 'No tests found for buildAuthHeaders empty-token branch.',
            isError: false,
          },
          {
            type: 'tool_use',
            id: 'demo-coverage-grep',
            name: 'Grep',
            input: { pattern: 'refreshToken|getToken', path: 'src/auth' },
          },
          {
            type: 'tool_result',
            toolUseId: 'demo-coverage-grep',
            content: 'src/auth/middleware.ts\nsrc/auth/auth.ts',
            isError: false,
          },
          { type: 'text', text: '仍在检查：getToken、refreshToken 和空 token 分支缺少直接回归覆盖。' },
        ],
      },
    ]
  }

  if (transcriptPath === 'demo://subagent/readme-completed') {
    return [
      {
        id: 'demo-readme-user',
        role: 'user',
        timestamp: iso(48_000),
        blocks: [
          { type: 'text', text: '总结 README 中的产品定位和能力点。' },
        ],
      },
      {
        id: 'demo-readme-agent',
        role: 'assistant',
        timestamp: iso(18_000),
        blocks: [
          {
            type: 'tool_use',
            id: 'demo-readme-read',
            name: 'Read',
            input: { file_path: 'README.md' },
          },
          {
            type: 'tool_result',
            toolUseId: 'demo-readme-read',
            content: '# Vibe Board\nVibe Board 是一个面向 AI 编程 Agent 的 macOS 灵动岛应用。',
            isError: false,
          },
          {
            type: 'text',
            text: 'README 总结完成：Vibe Board 面向 Claude Code、Codex 等 AI 编程 Agent，在 macOS 顶部提供灵动岛式状态、审批、提问、计划和完成提醒。',
          },
        ],
      },
    ]
  }

  return []
}

/** Request a full parse of a completed subagent transcript JSONL file. */
export async function getSubagentChatHistory(sessionId: string, transcriptPath: string): Promise<ParsedMessage[]> {
  if (!isTauri()) {
    if (transcriptPath.startsWith('demo://subagent/')) return demoSubagentChatHistory(transcriptPath)
    return []
  }
  return invoke<ParsedMessage[]>('get_subagent_chat_history', { sessionId, transcriptPath })
}

export async function openImage(src: string): Promise<void> {
  if (!isTauri()) {
    window.open(src, '_blank', 'noopener,noreferrer')
    return
  }
  return invoke('open_image', { src })
}

export function isLocalImageSource(src: string): boolean {
  const trimmed = src.trim()
  return trimmed.startsWith('/')
    || trimmed.startsWith('~/')
    || trimmed.startsWith('~\\')
    || trimmed.startsWith('file://')
}

export async function resolveImageSrc(src: string): Promise<string> {
  if (!isTauri() || !isLocalImageSource(src)) return src
  return invoke<string>('read_image_data_url', { src })
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

// ── Suppression Commands ────────────────────────────────────────

/** Check if a session's terminal is currently focused (smart suppression). */
export async function shouldSuppress(sessionId: string): Promise<boolean> {
  if (!isTauri()) return false
  return invoke<boolean>('should_suppress', { sessionId })
}

/** Check if a session's owning terminal tab/window is currently focused. */
export async function isTerminalFocused(sessionId: string): Promise<boolean> {
  if (!isTauri()) return false
  return invoke<boolean>('is_terminal_focused', { sessionId })
}

/** Get current cursor screen coordinates. */
export async function getCursorPosition(): Promise<[number, number]> {
  if (!isTauri()) return [0, 0]
  return invoke<[number, number]>('get_cursor_position')
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

export interface LogicalRect {
  left: number
  top: number
  width: number
  height: number
}

export async function isCursorInWindowZones(
  zones: LogicalRect[],
  windowLabel?: 'notch',
): Promise<boolean> {
  if (!isTauri() || zones.length === 0) return false
  return invoke<boolean>('is_cursor_in_window_zones', { zones, windowLabel })
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

export async function loadSessions(): Promise<SessionState[]> {
  if (!isTauri()) return []
  try {
    const data = await invoke<string>('load_sessions')
    return data ? JSON.parse(data) : []
  } catch (err) {
    console.warn('Failed to parse loaded sessions:', err)
    return []
  }
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

// ── Engine Instance Commands ────────────────────────────────────

export interface BackendEngineInstance {
  id: string
  label: string
  configRoot: string
  enabled: boolean
}

export async function addEngineInstance(label: string, configRoot: string): Promise<BackendEngineInstance> {
  if (!isTauri()) throw new Error('Not in Tauri')
  return await invoke<BackendEngineInstance>('add_engine_instance', { label, configRoot })
}

export async function removeEngineInstance(id: string): Promise<void> {
  if (!isTauri()) return
  await invoke('remove_engine_instance', { id })
}

export async function setEngineInstanceEnabled(id: string, enabled: boolean): Promise<void> {
  if (!isTauri()) return
  await invoke('set_engine_instance_enabled', { id, enabled })
}

export async function verifyEnginePath(path: string): Promise<boolean> {
  if (!isTauri()) return false
  return await invoke<boolean>('verify_engine_path', { path })
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

export async function simulateHookEvent(eventName: string, toolName?: string): Promise<void> {
  if (!isTauri()) return
  return invoke('simulate_hook_event', { eventName, toolName })
}

export async function simulateHookLifecycle(): Promise<void> {
  if (!isTauri()) return
  for (const eventName of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) {
    await simulateHookEvent(eventName)
  }
}

export async function getAllHookStatus(): Promise<HookStatus[]> {
  if (!isTauri()) return []
  return invoke<HookStatus[]>('get_all_hook_status')
}

export async function reinstallAllHooks(): Promise<string[]> {
  if (!isTauri()) return []
  return invoke<string[]>('reinstall_all_hooks')
}

export async function uninstallAllHooks(): Promise<string[]> {
  if (!isTauri()) return []
  return invoke<string[]>('uninstall_all_hooks')
}

// ── Webhook Management ───────────────────────────────────────────

export interface WebhookConfig {
  id: string
  name: string
  platform: 'dingtalk' | 'feishu'
  url: string
  secret: string | null
  sources: string[]
  events: string[]
  enabled: boolean
  delayEnabled: boolean
  delayMinutes: number
}

export async function listWebhooks(): Promise<WebhookConfig[]> {
  if (!isTauri()) return []
  return invoke<WebhookConfig[]>('list_webhooks')
}

export async function addWebhook(config: WebhookConfig): Promise<void> {
  if (!isTauri()) return
  return invoke('add_webhook', { config })
}

export async function removeWebhook(id: string): Promise<void> {
  if (!isTauri()) return
  return invoke('remove_webhook', { id })
}

export async function updateWebhook(config: WebhookConfig): Promise<void> {
  if (!isTauri()) return
  return invoke('update_webhook', { config })
}

export async function testWebhook(id: string): Promise<string> {
  if (!isTauri()) return 'mock: test skipped in browser'
  return invoke<string>('test_webhook', { id })
}

export async function getWebhookLogs(): Promise<DiagnosticEvent[]> {
  if (!isTauri()) return []
  return invoke<DiagnosticEvent[]>('get_webhook_logs')
}

// ── Haptic Feedback ─────────────────────────────────────────────

export async function performHaptic(intensity: number): Promise<void> {
  if (!isTauri()) return
  return invoke('perform_haptic', { intensity })
}

// ── Diagnostic Events ────────────────────────────────────────────

export interface DiagnosticEvent {
  seq: number
  timestampMs: number
  severity: 'debug' | 'info' | 'warning' | 'error'
  component: string
  message: string
  payload: unknown | null
}

export async function getDiagnosticEvents(sinceSeq?: number, component?: string): Promise<DiagnosticEvent[]> {
  if (!isTauri()) return []
  return invoke<DiagnosticEvent[]>('get_diagnostic_events', {
    sinceSeq: sinceSeq ?? null,
    component: component ?? null,
  })
}
