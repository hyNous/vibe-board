/* Vibe Board — Shared TypeScript Types */

export type AgentType =
  | 'claude-code' | 'cline' | 'codex' | 'gemini-cli'
  | 'cursor' | 'cursor-cli'
  | 'copilot'
  | 'qoder' | 'qoder-cli'
  | 'codebuddy' | 'codebuddycn'
  | 'qwen' | 'kimi' | 'doubao' | 'deepseek' | 'opencode'
  | 'droid' | 'stepfun' | 'antigravity'
  | 'workbuddy' | 'hermes' | 'pi' | 'kiro' | 'zcode'

export type ToolStatus = 'running' | 'success' | 'error' | 'interrupted'

/** Provider-neutral lifecycle status used by the Island and Agent Monitor. */
export type AgentRunStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'waiting_input'
  | 'blocked'
  | 'rate_limited'
  | 'error'
  | 'completed'
  | 'cancelled'
  | 'unknown'

export interface AgentRunState {
  agent: string
  sessionId?: string
  status: AgentRunStatus
  phase?: string
  currentAction?: string
  startedAt?: string
  updatedAt: string
}

/** Normalized lifecycle events consumed by views instead of provider payloads. */
export type AgentRunEvent =
  | { type: 'session_started'; agent: string; sessionId: string; startedAt?: string }
  | { type: 'status_changed'; status: AgentRunStatus; phase?: string; currentAction?: string }
  | { type: 'tool_started'; toolName: string; toolTarget?: string }
  | { type: 'tool_finished'; toolName: string; toolTarget?: string; status: Extract<ToolStatus, 'success' | 'error' | 'interrupted'> }
  | { type: 'waiting_input'; question?: string }
  | { type: 'rate_limited'; phase?: string; currentAction?: string }
  | { type: 'error'; message?: string }
  | { type: 'completed'; summary?: string }
  | { type: 'usage_updated' }

export type UnifiedAgentEvent = AgentRunEvent

export type SessionPhase =
  | 'ready'
  | 'idle'
  | 'processing'
  | 'waiting_input'
  | 'compacting'
  | 'done'
  | 'error'
  | 'interrupted'

export type PanelState = 'collapsed' | 'hover' | 'expanded'

export type BaseLayer = 'compact' | 'expanded' | 'detail'
export type DisplayLevel = 'dormant' | 'compact' | 'visible'

export type OverlayType = 'completion' | 'response' | 'compacting'

export const OVERLAY_PRIORITY: Record<OverlayType, number> = {
  completion: 20,
  response: 10,
  compacting: 15,
}

export interface OverlayItem {
  id: string
  sessionId: string
  type: OverlayType
  data: unknown
  createdAt: number
  suppressed?: boolean
}

export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
}

export interface DiffLine {
  type: 'add' | 'remove' | 'context'
  lineNumber: number
  content: string
}

export interface DiffContent {
  filePath: string
  lines: DiffLine[]
}

export interface UsageRateWindow {
  id: string
  title: string
  usedPercent: number
  remainingPercent?: number | null
  remainingLabel?: string
  resetsAt?: string | null
  windowMinutes?: number | null
}

export interface RateLimitInfo {
  fiveHourUsage: number     // percentage 0-100
  fiveHourRemaining: string // "1d6h" format
  sevenDayUsage: number
  sevenDayRemaining: string
  provider?: AgentType | string
  providerLabel?: string
  source?: string
  updatedAt?: number
  windows?: UsageRateWindow[]
}

export interface AgentStatusSnapshot {
  agent: string
  label: string
  primary?: boolean
  online: boolean
  lastSeenAt: number
  lastCompletedAt?: number | null
  tokens: TokenUsage
  rateLimits?: RateLimitInfo | null
  detail?: string | null
}

export interface ContextWindowInfo {
  totalInputTokens: number
  totalOutputTokens: number
  contextWindowSize: number
  usedPercentage: number | null
}

export interface TerminalInfo {
  app: string
  pid: number
  tty: string
  tabId?: string
  paneId?: string
}

/**
 * Metadata for tail-only chat history. Backend returns only the newest slice
 * (e.g. last 50 messages); hasMore lets the UI explain that older messages
 * were intentionally skipped for performance.
 */
export interface ChatHistoryMeta {
  hasMore: boolean
  firstMessageId?: string
  totalCount?: number
  transcriptPath?: string
}

export type SessionNoticeKind =
  | 'terminal_approval'
  | 'terminal_question'
  | 'restart'
  | 'trust'
  | 'extension'
  | 'status_warning'
  | 'compact_complete'

export interface SessionNotice {
  kind: SessionNoticeKind
  title: string
  detail?: string
  actionLabel?: string
}

export interface SessionState {
  id: string
  agentType: AgentType
  engineLabel?: string
  engineConfigRoot?: string
  codexAppServerThreadId?: string
  project: string
  cwd?: string
  terminal: string
  phase: SessionPhase
  /** Normalized lifecycle state; legacy phase remains for compatibility. */
  runState?: AgentRunState
  startedAt: number
  idleSince?: number
  duration: number
  tokens: TokenUsage
  rateLimits?: RateLimitInfo
  statusLineText?: string
  contextWindow?: ContextWindowInfo
  lastMainAgentAt?: number
  cacheTtlMs?: number
  lastToolName?: string
  lastToolTarget?: string
  lastToolStatus?: ToolStatus
  description?: string
  chatHistory: ChatMessage[]
  chatHistoryMeta?: ChatHistoryMeta
  subagents: SubagentInfo[]
  activeTools: ToolResult[]
  tasks?: TaskInfo[]
  lastUserMessage?: string
  lastUserMessageAt?: number
  sessionTitle?: string
  pid?: number
  tty?: string
  termProgram?: string
  termBundleId?: string
  weztermPane?: string
  zellijPaneId?: string
  zellijSessionName?: string
  cmuxSurfaceId?: string
  cmuxWorkspaceId?: string
  responseText?: string
  taskCompletedAt?: number // timestamp when task completed
  isYoloMode?: boolean
  model?: string
  notice?: SessionNotice
  lastActivityAt?: number // timestamp for processing timeout
}

export interface SubagentInfo {
  agentId: string
  name?: string
  agentType?: string
  description: string
  transcriptPath?: string
  agentTranscriptPath?: string
  lastAssistantMessage?: string
  startedAt: number
  completedAt?: number
  status: 'running' | 'completed' | 'error'
  tools: string[]
}

export interface ToolResult {
  toolUseId: string
  toolName: string
  status: 'running' | 'success' | 'error'
  startedAt: number
  completedAt?: number
  error?: string
  toolInput?: string
  diff?: DiffContent
}

export interface TaskInfo {
  id: string
  name: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface McpToolInfo {
  server: string
  tool: string
  displayName: string
}

export interface ChatToolCall {
  toolUseId?: string
  toolName: string
  toolInput?: string
  status: ToolStatus
  result?: string
  diff?: DiffContent
}

// Chat message types for conversation view
export type ChatMessage =
  | { role: 'user'; content: string; timestamp: number; images?: string[] }
  | {
      role: 'assistant'
      content: string
      timestamp: number
      images?: string[]
      toolCalls?: ChatToolCall[]
      thinking?: string
      thinkingCount?: number
      messageCount?: number
      trailingContent?: string
    }
  | ({ role: 'tool_use'; timestamp: number } & ChatToolCall)
  | { role: 'thinking'; content: string; timestamp: number }
  | { role: 'error'; message: string; timestamp: number }

export type AgentEvent =
  | { type: 'session_start'; sessionId: string; project: string; terminal: string; agentType: AgentType; cwd?: string }
  | { type: 'session_end'; sessionId: string }
  | { type: 'processing'; sessionId: string; description: string }
  | { type: 'tool_use'; sessionId: string; toolName: string; toolInput: string; toolTarget?: string; status: ToolStatus }
  | { type: 'task_complete'; sessionId: string; summary: string }
  | { type: 'error'; sessionId: string; message: string }
  | { type: 'interrupt'; sessionId: string }
  | { type: 'context_compact'; sessionId: string; phase: 'pre' | 'post' }
  | { type: 'token_usage'; sessionId: string; input: number; output: number; cacheRead: number; cacheCreate: number }
  | { type: 'task_update'; sessionId: string; taskId: string; subject: string; status: 'pending' | 'in_progress' | 'completed' }
  | { type: 'user_message'; sessionId: string; content: string }
