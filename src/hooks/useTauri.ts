/* Vibe Board — Tauri Event Hooks
 * Listens for backend events and syncs stores. No-ops in browser dev mode.
 */
import { useEffect } from 'react'
import i18n from 'i18next'
import { isTauri, getSessions, getAgentStatuses, getUsageRateLimits, getUsageSnapshots, getConfig, setSoundEventRule, setLanguage, getAppStateFlags } from '../services/tauriApi'
import type { BackendSession, BackendConfig, ParsedMessage, ParsedMessageBlock } from '../services/tauriApi'
import { useSessionStore } from '../stores/sessionStore'
import { useConfigStore } from '../stores/configStore'
import type { SoundChoice } from '../stores/configStore'
import type { SessionState, DiffContent, AgentType, AgentStatusSnapshot, ToolStatus, ChatMessage, RateLimitInfo } from '../types/agent'
import { energyIntervalMs, getAppEnergyMode } from '../utils/energyPolicy'
import { agentRunStateFromSession } from '../utils/agentRunState'

type Unlisten = () => void
type TauriInitScope = string | null

function listenForTauriEvent<T>(
  eventName: string,
  handler: (event: { payload: T }) => void,
  register: (unlisten: Unlisten) => void,
  isCancelled: () => boolean,
) {
  import('@tauri-apps/api/event')
    .then(({ listen }) => listen<T>(eventName, handler))
    .then((unlisten) => {
      if (isCancelled()) unlisten()
      else register(unlisten)
    })
    .catch((error) => console.error(`[tauri] listen ${eventName}:`, error))
}

// ── Transform Backend → Frontend ─────────────────────────────────

function parseToolInput(raw?: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    return undefined
  }
  return undefined
}

function getInputString(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  return typeof value === 'string' ? value : ''
}

function buildDiffFromToolInput(name: string, input: Record<string, unknown>): DiffContent | undefined {
  const filePath = getInputString(input, 'file_path')
    || getInputString(input, 'filePath')
    || getInputString(input, 'path')
    || getInputString(input, 'notebook_path')
  if (!filePath) return undefined

  if (name === 'Edit' || name === 'NotebookEdit') {
    const oldContent = getInputString(input, 'old_string')
    const newContent = getInputString(input, 'new_string')
    if (!oldContent && !newContent) return undefined
    return contentPairToDiff(filePath, oldContent, newContent)
  }

  if (name === 'Write') {
    const newContent = getInputString(input, 'content')
    if (!newContent) return undefined
    return contentPairToDiff(filePath, '', newContent)
  }

  if (name === 'MultiEdit') {
    const rawEdits = input.edits
    let edits: Array<{ old_string?: string; new_string?: string }> = []
    if (Array.isArray(rawEdits)) {
      edits = rawEdits.filter((item): item is { old_string?: string; new_string?: string } => (
        Boolean(item) && typeof item === 'object'
      ))
    } else if (typeof rawEdits === 'string') {
      try {
        const parsed = JSON.parse(rawEdits)
        if (Array.isArray(parsed)) edits = parsed
      } catch {
        return undefined
      }
    }

    const oldContent = edits.map((edit) => edit.old_string ?? '').filter(Boolean).join('\n...\n')
    const newContent = edits.map((edit) => edit.new_string ?? '').filter(Boolean).join('\n...\n')
    if (!oldContent && !newContent) return undefined
    return contentPairToDiff(filePath, oldContent, newContent)
  }

  return undefined
}

export function transformSession(bs: BackendSession): SessionState {
  // Preserve existing chatHistory/subagents/activeTools from the store
  // so that replaceAllSessions doesn't wipe them on each backend update
  const existing = useSessionStore.getState().sessions[bs.id]
  const backendSubagents = bs.subagents ?? []
  const subagents = backendSubagents.length > 0
    ? backendSubagents
    : (existing?.subagents ?? [])
  const lastUserMessage = bs.lastUserMessage ?? existing?.lastUserMessage

  const session: SessionState = {
    id: bs.id,
    agentType: bs.agentType as AgentType,
    engineLabel: bs.engineLabel ?? undefined,
    engineConfigRoot: bs.engineConfigRoot ?? undefined,
    codexAppServerThreadId: bs.codexAppServerThreadId ?? undefined,
    project: bs.project,
    cwd: bs.cwd,
    terminal: bs.terminal,
    phase: bs.phase as SessionState['phase'],
    startedAt: bs.startedAt,
    duration: bs.duration,
    tokens: bs.tokens,
    rateLimits: bs.rateLimits ?? undefined,
    statusLineText: bs.statusLineText ?? undefined,
    contextWindow: bs.contextWindow ?? undefined,
    lastMainAgentAt: bs.lastMainAgentAt ?? undefined,
    cacheTtlMs: bs.cacheTtlMs ?? undefined,
    lastToolName: bs.lastToolName ?? undefined,
    lastToolTarget: bs.lastToolTarget ?? undefined,
    lastToolStatus: (bs.lastToolStatus as ToolStatus) ?? undefined,
    sessionTitle: bs.sessionTitle ?? undefined,
    pid: bs.pid ?? undefined,
    tty: bs.tty ?? undefined,
    termProgram: bs.termProgram ?? undefined,
    termBundleId: bs.termBundleId ?? undefined,
    weztermPane: bs.weztermPane ?? undefined,
    zellijPaneId: bs.zellijPaneId ?? undefined,
    zellijSessionName: bs.zellijSessionName ?? undefined,
    cmuxSurfaceId: bs.cmuxSurfaceId ?? undefined,
    cmuxWorkspaceId: bs.cmuxWorkspaceId ?? undefined,
    chatHistory: existing?.chatHistory ?? [],
    subagents: subagents.map((subagent) => ({
      agentId: subagent.agentId,
      name: subagent.name ?? undefined,
      agentType: subagent.agentType ?? undefined,
      description: subagent.description,
      transcriptPath: subagent.transcriptPath ?? undefined,
      agentTranscriptPath: subagent.agentTranscriptPath ?? undefined,
      lastAssistantMessage: subagent.lastAssistantMessage ?? undefined,
      startedAt: subagent.startedAt,
      completedAt: subagent.completedAt ?? undefined,
      status: subagent.status === 'error'
        ? 'error'
        : subagent.status === 'completed'
          ? 'completed'
          : 'running',
      tools: subagent.tools ?? [],
    })),
    activeTools: (bs.activeTools ?? existing?.activeTools ?? []).map((tool) => ({
      toolUseId: tool.toolUseId,
      toolName: tool.toolName,
      status: tool.status === 'error'
        ? 'error'
        : tool.status === 'success'
          ? 'success'
          : 'running',
      startedAt: tool.startedAt,
      completedAt: tool.completedAt ?? undefined,
      error: tool.error ?? undefined,
      toolInput: tool.toolInput ?? undefined,
      diff: buildDiffFromToolInput(tool.toolName, parseToolInput(tool.toolInput) ?? {}),
    })),
    tasks: (bs.tasks ?? existing?.tasks ?? []).map((task) => ({
      id: task.id,
      name: task.name,
      status: task.status === 'completed'
        ? 'completed'
        : task.status === 'in_progress'
          ? 'in_progress'
          : 'pending',
    })),
    isYoloMode: bs.isYoloMode || undefined,
    model: bs.model ?? existing?.model ?? undefined,
    notice: bs.notice ?? existing?.notice,
    lastUserMessage,
    lastUserMessageAt: lastUserMessage === existing?.lastUserMessage ? existing?.lastUserMessageAt : undefined,
    responseText: bs.lastResponse ?? undefined,
    description: bs.lastThought ?? bs.description ?? undefined,
  }

  return {
    ...session,
    runState: bs.runState ?? agentRunStateFromSession(session),
  }
}

function usageProviderForAgent(agentType: AgentType | string): string {
  if (agentType === 'claude-code') return 'claude-code'
  return agentType
}

function providerLabelForAgent(agentType: AgentType | string, engineLabel?: string): string {
  if (engineLabel) return engineLabel
  if (agentType === 'claude-code') return 'Claude'
  if (agentType === 'codex') return 'Codex'
  if (agentType === 'workbuddy') return 'WorkBuddy'
  if (agentType === 'zcode') return 'ZCode'
  if (agentType === 'doubao') return 'Doubao'
  return String(agentType)
}

function usageSnapshotFromSession(session: SessionState): RateLimitInfo | undefined {
  if (!session.rateLimits) return undefined
  const provider = usageProviderForAgent(session.agentType)
  return {
    ...session.rateLimits,
    provider,
    providerLabel: providerLabelForAgent(session.agentType, session.engineLabel),
    source: session.rateLimits.source ?? 'agent-statusline',
    updatedAt: session.rateLimits.updatedAt ?? Date.now(),
    windows: session.rateLimits.windows && session.rateLimits.windows.length > 0
      ? session.rateLimits.windows
      : [
        {
          id: 'five_hour',
          title: '5h',
          usedPercent: session.rateLimits.fiveHourUsage,
          remainingPercent: Math.max(0, 100 - session.rateLimits.fiveHourUsage),
          remainingLabel: session.rateLimits.fiveHourRemaining,
          windowMinutes: 300,
        },
        {
          id: 'seven_day',
          title: '7d',
          usedPercent: session.rateLimits.sevenDayUsage,
          remainingPercent: Math.max(0, 100 - session.rateLimits.sevenDayUsage),
          remainingLabel: session.rateLimits.sevenDayRemaining,
          windowMinutes: 10080,
        },
      ],
  }
}

function sessionUsageSnapshots(sessions: SessionState[]): RateLimitInfo[] {
  return sessions.map(usageSnapshotFromSession).filter(Boolean) as RateLimitInfo[]
}

function applyBackendConfig(config: BackendConfig) {
  const store = useConfigStore.getState()
  const soundEvents = config.soundEvents && Object.keys(config.soundEvents).length > 0
    ? store.soundEvents.map((event) => ({
      ...event,
      enabled: config.soundRules?.[event.id]?.enabled ?? config.soundEvents[event.id] ?? event.enabled,
    }))
    : store.soundEvents
  const soundRules = config.soundRules && Object.keys(config.soundRules).length > 0
    ? Object.fromEntries(
      Object.entries(config.soundRules).map(([id, rule]) => [
        id,
        { enabled: rule.enabled, sound: rule.sound as SoundChoice },
      ]),
    )
    : store.soundRules

  useConfigStore.setState({
    soundEnabled: config.soundEnabled,
    volume: Math.round(config.soundVolume * 100),
    launchAtLogin: config.launchAtLogin ?? false,
    autoHide: config.autoHide,
    smartSuppression: config.smartSuppression,
    showUsageQuota: config.showTokenUsage ?? true,
    usageQueryEnabled: config.usageQueryEnabled ?? true,
    codexAppServerSyncEnabled: config.codexAppServerSyncEnabled ?? true,
    codexAppServerSyncIntervalSeconds: config.codexAppServerSyncIntervalSeconds ?? 30,
    sessionRefreshIntervalSeconds: Math.max(1, Math.min(30, config.sessionRefreshIntervalSeconds ?? 3)),
    windowCloseBehavior: config.windowCloseBehavior === 'exit' ? 'exit' : 'tray',
    hostVisibilityMode: config.hostVisibilityMode === 'follow' ? 'follow' : 'independent',
    notchPositionMode: ['top', 'left', 'right'].includes(config.notchPositionMode)
      ? config.notchPositionMode
      : 'top',
    notchVerticalOffset: Number.isFinite(config.notchVerticalOffset) ? config.notchVerticalOffset : 0,
    language: config.language || store.language,
    autoHideNoSessions: config.autoHideNoSessions,
    displayMonitor: config.displayId,
    panelHorizontalOffset: Number.isFinite(config.panelHorizontalOffset) ? config.panelHorizontalOffset : store.panelHorizontalOffset,
    globalShortcut: config.globalShortcut,
    soundEvents,
    soundRules,
    customSounds: Array.isArray(config.customSounds) ? config.customSounds : store.customSounds,
    soundPack: config.soundPack as 'eight-bit' | 'subtle' | 'synth' | 'system' | 'none' | 'custom',
    probeSessionFilter: config.probeSessionFilter,
    excludedHookCwdSubstrings: typeof config.excludedHookCwdSubstrings === 'string'
      ? config.excludedHookCwdSubstrings
      : store.excludedHookCwdSubstrings,
    sessionSilenceRules: Array.isArray(config.sessionSilenceRules)
      ? config.sessionSilenceRules
      : store.sessionSilenceRules,
    tipsEnabled: config.tipsEnabled,
    pixelCursorEnabled: config.pixelCursorEnabled,
    confettiEnabled: config.confettiEnabled,
    analyticsEnabled: config.analyticsEnabled ?? true,
    analyticsConsentPromptCompleted: config.analyticsConsentPromptCompleted ?? true,
    followFocus: config.followFocus,
    quietHours: {
      enabled: config.quietHoursEnabled,
      start: config.quietHoursStart,
      end: config.quietHoursEnd,
    },
    idleTimeoutMinutes: config.idleTimeoutMinutes ?? 5,
    idleInteractionRoutingEnabled: config.idleInteractionRoutingEnabled ?? false,
    idleInteractionRoutingMinutes: config.idleInteractionRoutingMinutes ?? 5,
    setupWizardCompleted: config.setupWizardCompleted ?? false,
    autoLaunchAgents: Array.isArray(config.autoLaunchAgents) ? config.autoLaunchAgents : [],
  })

  if (config.language) {
    if (i18n.language !== config.language) {
      void i18n.changeLanguage(config.language)
    }
  }
}

function syncSoundEventSettingsToBackend() {
  const { soundEvents, soundRules } = useConfigStore.getState()
  const events = soundEvents
  events.forEach((event) => {
    const rule = soundRules[event.id] ?? { enabled: event.enabled, sound: 'default' }
    setSoundEventRule(event.id, rule.enabled, rule.sound)
      .catch((e) => console.error('[tauri] setSoundEventRule:', e))
  })
}

let usageRateLimitRefreshInFlight = false
let usageRateLimitLastRefreshAt = 0
let usageRateLimitRefreshQueued = false
const USAGE_RATE_LIMIT_ACTIVE_REFRESH_MS = 60_000
const USAGE_RATE_LIMIT_IDLE_REFRESH_MS = 120_000
const USAGE_RATE_LIMIT_QUIET_REFRESH_MS = 300_000

function refreshUsageRateLimits(force = false) {
  if (!useConfigStore.getState().usageQueryEnabled) return
  const now = Date.now()
  const refreshInterval = energyIntervalMs(getAppEnergyMode(useSessionStore.getState().sessionList), {
    activeMs: USAGE_RATE_LIMIT_ACTIVE_REFRESH_MS,
    idleVisibleMs: USAGE_RATE_LIMIT_IDLE_REFRESH_MS,
    quietMs: USAGE_RATE_LIMIT_QUIET_REFRESH_MS,
  })
  if (!force && now - usageRateLimitLastRefreshAt < refreshInterval) return
  if (usageRateLimitRefreshInFlight) {
    usageRateLimitRefreshQueued = true
    return
  }

  usageRateLimitRefreshInFlight = true
  usageRateLimitLastRefreshAt = now
  getUsageSnapshots()
    .then(async (snapshots) => {
      if (snapshots.length > 0) {
        useSessionStore.getState().setUsageSnapshots(snapshots)
        return
      }
      const rateLimits = await getUsageRateLimits()
      if (rateLimits) {
        useSessionStore.getState().setUsageSnapshots([rateLimits])
      }
    })
    .catch(e => console.error('[tauri] getUsageSnapshots:', e))
    .finally(() => {
      usageRateLimitRefreshInFlight = false
      if (usageRateLimitRefreshQueued) {
        usageRateLimitRefreshQueued = false
        window.setTimeout(() => refreshUsageRateLimits(), 500)
      }
    })
}

const APP_SERVER_LIVE_POLL_MS = 10_000
type SessionSyncMode = 'full' | 'events' | 'off'

function refreshAppServerLiveFlag() {
  getAppStateFlags()
    .then(flags => useSessionStore.getState().setCodexAppServerLive(flags.codexAppServerLive))
    .catch(e => console.error('[tauri] getAppStateFlags:', e))
}

function refreshAgentStatuses() {
  getAgentStatuses()
    .then((statuses) => useSessionStore.getState().setAgentStatuses(statuses))
    .catch(e => console.error('[tauri] getAgentStatuses:', e))
}

// ── Hooks ────────────────────────────────────────────────────────

/** Listen for session-update events from the backend and sync sessionStore. */
export function useSessionEvents(mode: SessionSyncMode = 'full') {
  const sessionRefreshIntervalSeconds = useConfigStore((state) => state.sessionRefreshIntervalSeconds)

  useEffect(() => {
    if (!isTauri() || mode === 'off') return

    let unlisten: (() => void) | undefined
    let unlistenAgentStatus: (() => void) | undefined
    let cancelled = false
    let lastSessionSnapshot = ''
    const fullSync = mode === 'full'
    const usageRateLimitTimer = fullSync
      ? window.setInterval(refreshUsageRateLimits, USAGE_RATE_LIMIT_ACTIVE_REFRESH_MS)
      : undefined
    const appServerLiveTimer = fullSync
      ? window.setInterval(refreshAppServerLiveFlag, APP_SERVER_LIVE_POLL_MS)
      : undefined
    const snapshotSessions = (sessions: BackendSession[], suppressed: boolean) => JSON.stringify({
      suppressed,
      sessions: [...sessions].sort((a, b) => a.id.localeCompare(b.id)),
    })
    const applyBackendSessions = (
      sessions: BackendSession[],
      options: { suppressed?: boolean; force?: boolean } = {},
    ) => {
      const suppressed = options.suppressed === true
      const snapshot = snapshotSessions(sessions, suppressed)
      if (!options.force && snapshot === lastSessionSnapshot) return
      lastSessionSnapshot = snapshot

      const transformed = sessions.map(transformSession)
      const store = useSessionStore.getState()
      store.replaceAllSessions(transformed, { suppressed })
      const usageSnapshots = sessionUsageSnapshots(transformed)
      if (usageSnapshots.length > 0) store.setUsageSnapshots(usageSnapshots)
      if (fullSync) refreshUsageRateLimits(options.force === true)
      if (suppressed) {
        const current = useSessionStore.getState().panelState
        if (current === 'expanded') {
          store.setPanelState('collapsed')
        }
      }
    }

    // Load initial sessions
    getSessions()
      .then((sessions) => {
        if (!cancelled) applyBackendSessions(sessions, { force: true })
      })
      .catch(e => console.error('[tauri] getSessions:', e))
    if (fullSync) refreshAgentStatuses()

    if (fullSync) refreshAppServerLiveFlag()
    const sessionRefreshTimer = fullSync
      ? window.setInterval(() => {
        getSessions()
          .then((sessions) => {
            if (!cancelled) applyBackendSessions(sessions)
          })
          .catch(e => console.error('[tauri] poll getSessions:', e))
        refreshAgentStatuses()
      }, Math.max(1, Math.min(30, sessionRefreshIntervalSeconds)) * 1000)
      : undefined

    listenForTauriEvent<{ sessions: BackendSession[]; suppressed?: boolean }>(
      'session-update',
      (event) => {
        applyBackendSessions(event.payload.sessions, { suppressed: event.payload.suppressed === true })
      },
      (fn) => { unlisten = fn },
      () => cancelled,
    )

    listenForTauriEvent<AgentStatusSnapshot[]>(
      'agent-status-update',
      (event) => useSessionStore.getState().setAgentStatuses(event.payload),
      (fn) => { unlistenAgentStatus = fn },
      () => cancelled,
    )

    return () => {
      cancelled = true
      if (usageRateLimitTimer !== undefined) window.clearInterval(usageRateLimitTimer)
      if (appServerLiveTimer !== undefined) window.clearInterval(appServerLiveTimer)
      if (sessionRefreshTimer !== undefined) window.clearInterval(sessionRefreshTimer)
      unlisten?.()
      unlistenAgentStatus?.()
    }
  }, [mode, sessionRefreshIntervalSeconds])
}

/** Listen for config-changed events from the backend and sync configStore. */
export function useConfigSync(enabled = true, canWriteMigrations = true) {
  useEffect(() => {
    if (!isTauri() || !enabled) return

    let unlisten: (() => void) | undefined
    let cancelled = false

    getConfig().then((config) => {
      if (cancelled) return
      const localLanguage = useConfigStore.getState().language
      const effectiveConfig = canWriteMigrations && localLanguage && config.language !== localLanguage
        ? { ...config, language: localLanguage }
        : config
      if (canWriteMigrations && effectiveConfig.language !== config.language) {
        setLanguage(effectiveConfig.language).catch(e => console.error('[tauri] setLanguage:', e))
      }
      applyBackendConfig(effectiveConfig)
      if (canWriteMigrations && (!effectiveConfig.soundRules || Object.keys(effectiveConfig.soundRules).length === 0)) {
        syncSoundEventSettingsToBackend()
      }
    })
      .catch(e => console.error('[tauri] getConfig:', e))

    listenForTauriEvent<BackendConfig>(
      'config-changed',
      (event) => {
        applyBackendConfig(event.payload)
      },
      (fn) => { unlisten = fn },
      () => cancelled,
    )

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [canWriteMigrations, enabled])
}

// ── Conversation Update Mapping ─────────────────────────────────

/** Map a list of ParsedMessages (from Rust) into ChatMessages (frontend type). */
export function mapParsedMessages(parsed: ParsedMessage[]): ChatMessage[] {
  const messages: ChatMessage[] = []

  const lastAssistant = () => {
    const last = messages[messages.length - 1]
    return last?.role === 'assistant' ? last : undefined
  }

  const formatToolInput = (input: Record<string, string>) =>
    Object.entries(input).map(([k, v]) => `${k}: ${v}`).join('\n')

  const applyToolResult = (block: Extract<ParsedMessageBlock, { type: 'tool_result' }>) => {
    const assistant = lastAssistant()
    const tool = assistant?.toolCalls?.find((candidate) => candidate.toolUseId === block.toolUseId)
    if (!tool) return
    tool.status = block.isError ? 'error' : 'success'
    if (block.content) {
      tool.result = block.content.length > 1200 ? `${block.content.slice(0, 1200)}...` : block.content
    }
  }

  for (const msg of parsed) {
    const ts = msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now()
    const imageBlocks = msg.blocks.filter((block): block is Extract<ParsedMessageBlock, { type: 'image' }> => block.type === 'image')
    const images = imageBlocks.map((block) => block.source).filter(Boolean)

    if (msg.role === 'user') {
      const text = msg.blocks
        .filter((block): block is Extract<ParsedMessageBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('')
      const toolResults = msg.blocks.filter((block): block is Extract<ParsedMessageBlock, { type: 'tool_result' }> => block.type === 'tool_result')

      for (const result of toolResults) {
        applyToolResult(result)
      }

      if (!text && images.length === 0) continue

      messages.push({
        role: 'user',
        content: text,
        timestamp: ts,
        ...(images.length > 0 ? { images } : {}),
      })
      continue
    }

    const textParts: string[] = []
    const thinkingParts: string[] = []
    const toolCalls: NonNullable<Extract<ChatMessage, { role: 'assistant' }>['toolCalls']> = []
    const assistantImages = [...images]

    for (const block of msg.blocks) {
      if (block.type === 'text') {
        textParts.push(block.text)
      } else if (block.type === 'thinking') {
        thinkingParts.push(block.thinking)
      } else if (block.type === 'tool_use') {
        const tu = block as Extract<ParsedMessageBlock, { type: 'tool_use' }>
        toolCalls.push({
          toolUseId: tu.id,
          toolName: tu.name,
          toolInput: formatToolInput(tu.input),
          diff: buildDiffFromToolInput(tu.name, tu.input),
          status: 'success' as ToolStatus,
        })
      } else if (block.type === 'tool_result') {
        applyToolResult(block)
      } else if (block.type === 'interrupted') {
        textParts.push('[Request interrupted by user]')
      }
    }

    const content = textParts.join('')
    const thinking = thinkingParts.join('\n\n')

    if (!content && !thinking && toolCalls.length === 0 && assistantImages.length === 0) continue

    const previous = lastAssistant()
    if (previous) {
      if (content) {
        if (previous.trailingContent) {
          previous.content = previous.content
            ? `${previous.content}\n\n${previous.trailingContent}`
            : previous.trailingContent
          previous.messageCount = (previous.messageCount ?? 0) + 1
        }
        previous.trailingContent = content
      }
      if (thinking) {
        previous.thinking = previous.thinking ? `${previous.thinking}\n\n${thinking}` : thinking
        previous.thinkingCount = (previous.thinkingCount ?? 0) + 1
      }
      if (toolCalls.length > 0) {
        previous.toolCalls = previous.toolCalls ? [...previous.toolCalls, ...toolCalls] : toolCalls
      }
      if (assistantImages.length > 0) {
        previous.images = previous.images ? [...previous.images, ...assistantImages] : assistantImages
      }
      continue
    }

    messages.push({
      role: 'assistant',
      content: '',
      timestamp: ts,
      trailingContent: content || undefined,
      thinking: thinking || undefined,
      thinkingCount: thinking ? 1 : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      ...(assistantImages.length > 0 ? { images: assistantImages } : {}),
    })
  }

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    const hasProcess = !!msg.thinking || !!msg.toolCalls?.length || !!msg.content
    if (!hasProcess && msg.trailingContent) {
      msg.content = msg.trailingContent
      msg.trailingContent = undefined
    }
  }

  return messages
}

function contentPairToDiff(filePath: string, oldContent: string, newContent: string): DiffContent {
  const lines = [
    ...oldContent.split('\n').filter((line) => line.length > 0).map((content, index) => ({
      type: 'remove' as const,
      lineNumber: index + 1,
      content,
    })),
    ...newContent.split('\n').filter((line) => line.length > 0).map((content, index) => ({
      type: 'add' as const,
      lineNumber: index + 1,
      content,
    })),
  ]

  return { filePath, lines }
}

/** Map a single live block into ChatMessages without assistant turn aggregation. */
export function mapParsedBlocksFlat(msg: ParsedMessage): ChatMessage[] {
  const ts = msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now()
  const messages: ChatMessage[] = []

  for (const block of msg.blocks) {
    switch (block.type) {
      case 'text':
        messages.push({
          role: msg.role === 'user' ? 'user' : 'assistant',
          content: block.text,
          timestamp: ts,
        })
        break

      case 'tool_use': {
        const tu = block as Extract<ParsedMessageBlock, { type: 'tool_use' }>
          messages.push({
            role: 'tool_use',
            toolName: tu.name,
            toolUseId: tu.id,
            toolInput: Object.entries(tu.input).map(([k, v]) => `${k}: ${v}`).join('\n'),
            status: 'success' as ToolStatus,
            timestamp: ts,
          })
        break
      }

      case 'tool_result': {
        const tr = block as Extract<ParsedMessageBlock, { type: 'tool_result' }>
        if (tr.isError && tr.content) {
          messages.push({
            role: 'error',
            message: tr.content,
            timestamp: ts,
          })
        }
        break
      }

      case 'thinking':
        messages.push({
          role: 'thinking',
          content: block.thinking,
          timestamp: ts,
        })
        break

      case 'image':
        messages.push({
          role: msg.role === 'user' ? 'user' : 'assistant',
          content: '',
          timestamp: ts,
          images: [block.source],
        })
        break

      case 'interrupted':
        messages.push({
          role: 'assistant',
          content: '[Request interrupted by user]',
          timestamp: ts,
        })
        break
    }
  }

  return messages
}

/** Listen for conversation-update events from the file watcher and sync chat history. */
export function useConversationUpdates(enabled = true) {
  useEffect(() => {
    if (!isTauri() || !enabled) return

    let unlisten: (() => void) | undefined
    let cancelled = false

    listenForTauriEvent<{
        sessionId: string
        result: {
          allMessages: ParsedMessage[]
          newMessages: ParsedMessage[]
          clearDetected: boolean
          truncated?: boolean
          totalCount?: number
        }
      }>(
      'conversation-update',
      (event) => {
          const { sessionId, result } = event.payload
          const store = useSessionStore.getState()

          if (!store.sessions[sessionId]) return

          if (result.clearDetected) {
            store.setChatHistory(sessionId, mapParsedMessages(result.allMessages))
            return
          }

          // Truncated payload: backend trimmed older messages from the
          // streaming buffer, so allMessages is just the tail. Replacing the
          // store with the tail can erase local messages that arrived between
          // the initial tail load and the watcher update, causing a flash.
          // Append only the genuinely-newer delta instead, keyed off the
          // existing tail timestamp to avoid duplicating the initial-load
          // window when the watcher fires for the first time.
          if (result.truncated && result.newMessages.length > 0) {
            const session = store.sessions[sessionId]
            const lastTs = session.chatHistory.length > 0
              ? session.chatHistory[session.chatHistory.length - 1].timestamp
              : 0
            const newChat = mapParsedMessages(result.newMessages)
              .filter((m) => m.timestamp > lastTs)
            if (newChat.length === 0) return
            store.setChatHistory(sessionId, [...session.chatHistory, ...newChat])
            return
          }

          // Non-truncated: allMessages is authoritative for the whole session.
          store.setChatHistory(sessionId, mapParsedMessages(result.allMessages))
      },
      (fn) => { unlisten = fn },
      () => cancelled,
    )

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [enabled])
}

/** Listen for hook self-recovery notices and expose them in the island. */
export function useHookRecoveryEvents(enabled = true) {
  useEffect(() => {
    if (!isTauri() || !enabled) return

    let unlistenRestored: (() => void) | undefined
    let unlistenFailed: (() => void) | undefined
    let clearTimer: ReturnType<typeof setTimeout> | undefined
    let cancelled = false

    const show = (notification: 'restored' | 'rate_limited') => {
      const store = useSessionStore.getState()
      store.setHookNotification(notification)
      if (clearTimer) clearTimeout(clearTimer)
      clearTimer = setTimeout(() => {
        useSessionStore.getState().setHookNotification(null)
      }, 5000)
    }

    listenForTauriEvent<string>(
      'hook-recovery',
      () => show('restored'),
      (fn) => { unlistenRestored = fn },
      () => cancelled,
    )
    listenForTauriEvent<void>(
      'hook-recovery-failed',
      () => show('rate_limited'),
      (fn) => { unlistenFailed = fn },
      () => cancelled,
    )

    return () => {
      cancelled = true
      unlistenRestored?.()
      unlistenFailed?.()
      if (clearTimer) clearTimeout(clearTimer)
    }
  }, [enabled])
}

/** Combined init hook — call once in App with the current window label. */
export function useTauriInit(scope: TauriInitScope = 'notch') {
  const ready = scope !== null
  useSessionEvents(scope === 'notch' ? 'full' : 'off')
  useConfigSync(ready, scope === 'notch')
  useConversationUpdates(scope === 'notch')
  useHookRecoveryEvents(scope === 'notch')
}
