import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  getNetworkMonitorRequestDetail,
  getNetworkMonitorRequests,
  getNetworkMonitorStatus,
  getClaudeWrapperStatus,
  getMonitorSessionDetail,
  getMonitorSessions,
  createDemoTaskTrace,
  getTaskTraces,
  installClaudeWrapper,
  removeClaudeWrapper,
  setNetworkMonitorEnabled,
  type ClaudeWrapperStatus,
  type MonitorSessionDetail,
  type MonitorSessionSummary,
  type MonitorTimelineItem,
  type NetworkMonitorStatus,
  type NetworkRequestDetail,
  type NetworkRequestSummary,
  type TaskRecord,
  type AgentRunRecord,
  type TaskEventRecord,
} from '../../../services/monitorApi'
import { getChatHistoryTail, jumpToTerminal, openSystemPath } from '../../../services/tauriApi'
import { mapParsedMessages } from '../../../hooks/useTauri'
import { selectSessionList, useSessionStore } from '../../../stores/sessionStore'
import { useConfigStore } from '../../../stores/configStore'
import type { BackendSession } from '../../../services/tauriApi'
import type { ChatMessage, SessionState, TokenUsage } from '../../../types/agent'
import { formatDurationShort } from '../../../utils/time'
import { getSessionTaskDurationSeconds } from '../../../utils/sessionDisplay'
import { formatTokens } from '../../../utils/tokens'
import { energyIntervalMs, getAppEnergyMode } from '../../../utils/energyPolicy'
import type { MonitorSettingsView } from '../../../types/capability'
import { UnifiedUsageSection } from './UnifiedUsageSection'
import { Toggle } from '../Toggle'
import './AgentMonitorSection.css'

type DetailTab = 'overview' | 'network' | 'conversation' | 'timeline' | 'approvals' | 'raw'
type DetailSession = BackendSession | SessionState
type NetworkDetailTab = 'system' | 'messages' | 'tools' | 'response' | 'headers' | 'raw'

const DETAIL_TABS: Array<{ id: DetailTab; label: string }> = [
  { id: 'overview', label: '概览' },
  { id: 'network', label: '网络请求' },
  { id: 'conversation', label: '对话' },
  { id: 'timeline', label: '工具时间线' },
  { id: 'approvals', label: '审批与问题' },
  { id: 'raw', label: 'Raw 事件' },
]

const DEFAULT_NETWORK_STATUS: NetworkMonitorStatus = {
  enabled: false,
  proxyUrl: null,
  upstreamBaseUrl: 'https://api.anthropic.com',
  requestCount: 0,
  activeRequestCount: 0,
}

const DEFAULT_WRAPPER_STATUS: ClaudeWrapperStatus = {
  installed: false,
  shimPath: '~/.agentbro/bin/claude',
  pathHintInstalled: false,
  shellConfigPath: '~/.zshrc',
}

function agentLabel(agentType: string, engineLabel?: string | null) {
  if (engineLabel && agentType === 'claude-code' && engineLabel !== 'Claude Code') return engineLabel
  if (agentType === 'claude-code') return 'Claude'
  if (agentType === 'gemini-cli') return 'Gemini'
  return agentType
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function phaseLabel(phase?: string) {
  switch (phase) {
    case 'starting':
    case 'running':
    case 'processing': return '运行中'
    case 'waiting_approval': return '等审批'
    case 'waiting_permission': return '等审批'
    case 'waiting_input': return '等输入'
    case 'blocked': return '已阻塞'
    case 'compacting': return '压缩上下文'
    case 'done':
    case 'completed': return '完成'
    case 'error': return '错误'
    case 'failed':
    case 'failure': return '失败'
    case 'interrupted': return '已中断'
    case 'cancelled': return '已取消'
    case 'rate_limited': return '限流'
    case 'unknown': return '未知'
    case 'idle':
    default: return '空闲'
  }
}

function pendingLabel(kind?: string | null) {
  if (kind === 'permission') return '权限'
  if (kind === 'question') return '问题'
  if (kind === 'plan') return '计划'
  return kind || ''
}

function totalTokens(tokens: TokenUsage | BackendSession['tokens'] | undefined) {
  if (!tokens) return 0
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreate
}

type TaskFilter = 'all' | 'active' | 'completed' | 'failed'

const COMPLETED_STATUSES = new Set(['done', 'completed'])
const FAILED_STATUSES = new Set(['error', 'failed', 'failure', 'interrupted', 'cancelled'])
const BLOCKING_STATUSES = new Set([
  'waiting',
  'waiting_approval',
  'waiting_for_approval',
  'waiting_permission',
  'waiting_input',
  'waiting_for_input',
  'blocked',
])

function isTaskCompleted(task: TaskRecord) {
  return COMPLETED_STATUSES.has(task.status)
}

function isTaskFailed(task: TaskRecord) {
  return FAILED_STATUSES.has(task.status)
}

function isTaskActive(task: TaskRecord) {
  return !isTaskCompleted(task) && !isTaskFailed(task)
}

function flattenTaskRuns(task: TaskRecord): Array<{ run: AgentRunRecord; task: TaskRecord }> {
  const result: Array<{ run: AgentRunRecord; task: TaskRecord }> = []
  const visit = (run: AgentRunRecord) => {
    result.push({ run, task })
    for (const child of run.children ?? []) visit(child)
  }
  for (const run of task.runs ?? []) visit(run)
  return result
}

interface TaskUsageSummary {
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheCreateTokens: number | null
  totalTokens: number
}

interface TaskErrorSummary {
  id: string
  timestampMs?: number
  title: string
  detail?: string | null
  status: string
}

interface TaskMetrics {
  rootAgent: string | null
  childAgentCount: number
  blockingCount: number
  durationSeconds: number | null
  usage: TaskUsageSummary | null
  errors: TaskErrorSummary[]
  runCount: number
}

function numberValue(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function taskUsageFromPayload(payloadJson?: string | null): Partial<TaskUsageSummary> | null {
  if (!payloadJson) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(payloadJson)
  } catch {
    return null
  }
  const root = jsonObject(parsed)
  const usage = jsonObject(root.usage ?? root.usageSummary ?? root.tokenUsage ?? root.tokens)
  const read = (keys: string[]) => numberValue(usage, keys) ?? numberValue(root, keys)
  const inputTokens = read(['input_tokens', 'inputTokens', 'input'])
  const outputTokens = read(['output_tokens', 'outputTokens', 'output'])
  const cacheReadTokens = read(['cache_read_input_tokens', 'cacheReadInputTokens', 'cache_read', 'cacheRead'])
  const cacheCreateTokens = read(['cache_creation_input_tokens', 'cacheCreationInputTokens', 'cache_create', 'cacheCreate'])
  const totalTokens = read(['total_tokens', 'totalTokens', 'total'])
  if ([inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, totalTokens].every((value) => value == null)) return null
  return { inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, totalTokens: totalTokens ?? 0 }
}

function taskUsage(task: TaskRecord): TaskUsageSummary | null {
  let seen = false
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheCreate = 0
  let total = 0
  let inputKnown = false
  let outputKnown = false
  let cacheReadKnown = false
  let cacheCreateKnown = false
  let totalKnown = false

  for (const { run } of flattenTaskRuns(task)) {
    for (const event of run.events ?? []) {
      const parsed = taskUsageFromPayload(event.payloadJson)
      if (!parsed) continue
      seen = true
      if (parsed.inputTokens != null) {
        input += parsed.inputTokens
        inputKnown = true
      }
      if (parsed.outputTokens != null) {
        output += parsed.outputTokens
        outputKnown = true
      }
      if (parsed.cacheReadTokens != null) {
        cacheRead += parsed.cacheReadTokens
        cacheReadKnown = true
      }
      if (parsed.cacheCreateTokens != null) {
        cacheCreate += parsed.cacheCreateTokens
        cacheCreateKnown = true
      }
      if (parsed.totalTokens != null && parsed.totalTokens > 0) {
        total += parsed.totalTokens
        totalKnown = true
      }
    }
  }

  if (!seen) return null
  const componentTotal = (inputKnown ? input : 0)
    + (outputKnown ? output : 0)
    + (cacheReadKnown ? cacheRead : 0)
    + (cacheCreateKnown ? cacheCreate : 0)
  return {
    inputTokens: inputKnown ? input : null,
    outputTokens: outputKnown ? output : null,
    cacheReadTokens: cacheReadKnown ? cacheRead : null,
    cacheCreateTokens: cacheCreateKnown ? cacheCreate : null,
    totalTokens: totalKnown ? total : componentTotal,
  }
}

function taskErrors(task: TaskRecord): TaskErrorSummary[] {
  const errors: TaskErrorSummary[] = []
  for (const { run } of flattenTaskRuns(task)) {
    if (FAILED_STATUSES.has(run.status)) {
      errors.push({
        id: `run:${run.id}`,
        timestampMs: run.completedAt ? run.completedAt * 1000 : run.startedAt * 1000,
        title: run.title,
        detail: run.exitCode != null ? `进程退出码 ${run.exitCode}` : run.dispatchedTask,
        status: run.status,
      })
    }
    for (const event of run.events ?? []) {
      if (event.status && FAILED_STATUSES.has(event.status) || event.eventType.toLowerCase().includes('error')) {
        errors.push({
          id: event.id,
          timestampMs: event.timestampMs,
          title: event.title,
          detail: event.detail,
          status: event.status || 'error',
        })
      }
    }
  }
  return errors
}

function taskMetrics(task: TaskRecord, nowSeconds = Math.floor(Date.now() / 1000)): TaskMetrics {
  const runs = flattenTaskRuns(task).map(({ run }) => run)
  const started = runs.map((run) => run.startedAt).filter((value) => Number.isFinite(value) && value > 0)
  const finished = runs.map((run) => run.completedAt).filter((value): value is number => value != null && Number.isFinite(value) && value > 0)
  const end = runs.some((run) => !run.completedAt) ? nowSeconds : Math.max(...finished, 0)
  const start = started.length > 0 ? Math.min(...started) : null
  return {
    rootAgent: task.runs?.[0]?.agent ?? null,
    childAgentCount: runs.filter((run) => run.parentRunId != null).length,
    blockingCount: runs.filter((run) => BLOCKING_STATUSES.has(run.status)).length,
    durationSeconds: start != null && end >= start ? end - start : null,
    usage: taskUsage(task),
    errors: taskErrors(task),
    runCount: runs.length,
  }
}

function formatTaskUsage(usage: TaskUsageSummary | null) {
  return usage ? `${formatTokens(usage.totalTokens)} tok` : '未采集'
}

function formatOptionalTokens(value: number | null) {
  return value == null ? '—' : formatTokens(value)
}

function summaryFromSession(session: SessionState): MonitorSessionSummary {
  const pendingKind = session.pendingPermission
    ? 'permission'
    : session.pendingQuestion
      ? 'question'
      : session.planContent
        ? 'plan'
        : null
  return {
    id: session.id,
    agentType: session.agentType,
    engineLabel: session.engineLabel ?? null,
    project: session.project,
    cwd: session.cwd ?? '',
    terminal: session.terminal,
    phase: session.phase,
    startedAt: session.startedAt,
    duration: getSessionTaskDurationSeconds(session),
    tokenTotal: totalTokens(session.tokens),
    lastToolName: session.lastToolName ?? null,
    lastToolTarget: session.lastToolTarget ?? null,
    lastToolStatus: session.lastToolStatus ?? null,
    waitingUser: pendingKind !== null,
    pendingKind,
    subagentCount: session.subagents.length,
    activeToolCount: session.activeTools.filter((tool) => tool.status === 'running').length,
    title: session.sessionTitle ?? null,
  }
}

function formatTime(timestampMs?: number | null) {
  if (!timestampMs) return '-'
  return new Date(timestampMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function usageValue(usage: Record<string, unknown> | null | undefined, key: string) {
  const value = usage?.[key]
  return typeof value === 'number' ? value : 0
}

function usageTotal(usage: Record<string, unknown> | null | undefined) {
  return usageValue(usage, 'input_tokens')
    + usageValue(usage, 'output_tokens')
    + usageValue(usage, 'cache_creation_input_tokens')
    + usageValue(usage, 'cache_read_input_tokens')
}

function requestTypeLabel(request: NetworkRequestSummary) {
  return request.requestSubType ? `${request.requestType}:${request.requestSubType}` : request.requestType
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function requestSystem(body: unknown) {
  return jsonObject(body).system
}

function requestMessages(body: unknown) {
  return jsonArray(jsonObject(body).messages)
}

function requestTools(body: unknown) {
  return jsonArray(jsonObject(body).tools)
}

function responseEvents(responseBody: string | null | undefined) {
  if (!responseBody) return []
  return responseBody
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== '[DONE]')
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return line
      }
    })
}

function shortPath(path?: string | null) {
  if (!path) return '-'
  const separator = path.includes('\\') ? '\\' : '/'
  const parts = path.split(/[\\/]+/).filter(Boolean)
  if (parts.length <= 3) return path
  if (separator === '\\') return `...${parts.slice(-3).join(separator)}`
  return `…/${parts.slice(-3).join('/')}`
}

function parentPath(path?: string | null) {
  if (!path) return null
  const normalized = path.replace(/[\\/]+$/, '')
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  if (index <= 0) return null
  return normalized.slice(0, index)
}

function sessionPlan(session?: DetailSession) {
  if (!session) return null
  if ('pendingPlan' in session && session.pendingPlan) return session.pendingPlan
  if ('planContent' in session && session.planContent) {
    return {
      title: session.planTitle || 'Plan',
      content: session.planContent,
      permissions: session.planPermissions || [],
    }
  }
  return null
}

function timelineKindLabel(kind: string) {
  if (kind === 'tool') return 'tool'
  if (kind === 'hook_tool') return 'hook'
  if (kind === 'approval') return '审批'
  if (kind === 'question') return '问题'
  if (kind === 'plan') return '计划'
  if (kind === 'subagent') return 'subagent'
  if (kind === 'session') return 'session'
  return kind
}

function messagePreview(message: ChatMessage) {
  if (message.role === 'assistant') {
    return message.content || message.trailingContent || message.thinking || `${message.toolCalls?.length ?? 0} tool calls`
  }
  if (message.role === 'tool_use') return `${message.toolName}${message.toolInput ? `\n${message.toolInput}` : ''}`
  if (message.role === 'permission') return `${message.toolName}${message.toolInput ? `\n${message.toolInput}` : ''}`
  if (message.role === 'thinking') return message.content
  if (message.role === 'error') return message.message
  return message.content
}

interface AgentMonitorSectionProps {
  activeView?: MonitorSettingsView
}

function roleLabel(role: ChatMessage['role']) {
  if (role === 'tool_use') return 'tool'
  if (role === 'permission') return 'approval'
  return role
}

interface RequestStats {
  key: string
  requestCount: number
  inputTokens: number
  outputTokens: number
  cacheCreate: number
  cacheRead: number
  mainAgentCount: number
  subAgentCount: number
}

function emptyRequestStats(key: string): RequestStats {
  return {
    key,
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreate: 0,
    cacheRead: 0,
    mainAgentCount: 0,
    subAgentCount: 0,
  }
}

function aggregateRequestStats(requests: NetworkRequestSummary[], by: 'model' | 'project') {
  const groups = new Map<string, RequestStats>()
  for (const request of requests) {
    const key = by === 'model'
      ? request.model || request.provider || 'unknown'
      : request.project || '未关联项目'
    const stats = groups.get(key) ?? emptyRequestStats(key)
    stats.requestCount += 1
    stats.inputTokens += request.usageSummary?.inputTokens ?? usageValue(request.usage, 'input_tokens')
    stats.outputTokens += request.usageSummary?.outputTokens ?? usageValue(request.usage, 'output_tokens')
    stats.cacheCreate += request.usageSummary?.cacheCreationInputTokens ?? usageValue(request.usage, 'cache_creation_input_tokens')
    stats.cacheRead += request.usageSummary?.cacheReadInputTokens ?? usageValue(request.usage, 'cache_read_input_tokens')
    if (request.requestType === 'MainAgent') stats.mainAgentCount += 1
    if (request.requestType === 'SubAgent') stats.subAgentCount += 1
    groups.set(key, stats)
  }
  return Array.from(groups.values()).sort((a, b) => b.requestCount - a.requestCount)
}

function cacheHitRate(stats: RequestStats) {
  const cacheTotal = stats.cacheCreate + stats.cacheRead
  return cacheTotal > 0 ? Math.round((stats.cacheRead / cacheTotal) * 100) : null
}

export function AgentMonitorSection({ activeView = 'sessions' }: AgentMonitorSectionProps) {
  const liveSessions = useSessionStore(selectSessionList)
  const sessionRefreshIntervalSeconds = useConfigStore((state) => state.sessionRefreshIntervalSeconds)
  const [sessions, setSessions] = useState<MonitorSessionSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [agentFilter, setAgentFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [projectFilter, setProjectFilter] = useState('all')
  const [activeTab, setActiveTab] = useState<DetailTab>('overview')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<MonitorSessionDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [chatLoading, setChatLoading] = useState(false)
  const [chatError, setChatError] = useState('')
  const [networkStatus, setNetworkStatus] = useState<NetworkMonitorStatus>(DEFAULT_NETWORK_STATUS)
  const [networkUpstream, setNetworkUpstream] = useState(DEFAULT_NETWORK_STATUS.upstreamBaseUrl)
  const [networkRequests, setNetworkRequests] = useState<NetworkRequestSummary[]>([])
  const [selectedNetworkRequestId, setSelectedNetworkRequestId] = useState<string | null>(null)
  const [networkDetail, setNetworkDetail] = useState<NetworkRequestDetail | null>(null)
  const [networkLoading, setNetworkLoading] = useState(false)
  const [networkBusy, setNetworkBusy] = useState(false)
  const [networkError, setNetworkError] = useState('')
  const [wrapperStatus, setWrapperStatus] = useState<ClaudeWrapperStatus>(DEFAULT_WRAPPER_STATUS)
  const [wrapperBusy, setWrapperBusy] = useState(false)
  const energyMode = useMemo(() => getAppEnergyMode(liveSessions), [liveSessions])
  const configuredRefreshMs = Math.max(1, Math.min(30, sessionRefreshIntervalSeconds)) * 1000
  const sessionRefreshIntervalMs = energyIntervalMs(energyMode, {
    activeMs: configuredRefreshMs,
    idleVisibleMs: configuredRefreshMs * 2,
    quietMs: configuredRefreshMs * 5,
  })
  const networkRefreshIntervalMs = energyIntervalMs(energyMode, {
    activeMs: 2000,
    idleVisibleMs: 5000,
    quietMs: 12000,
  })

  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [creatingDemo, setCreatingDemo] = useState(false)
  const [demoNotice, setDemoNotice] = useState<string | null>(null)
  const [tasksLoading, setTasksLoading] = useState(false)
  const [tasksError, setTasksError] = useState('')
  const [taskFilter, setTaskFilter] = useState<TaskFilter>('active')

  const allTaskRuns = useMemo(() => {
    return tasks.flatMap((task) => flattenTaskRuns(task))
  }, [tasks])

  const selectedRunItem = allTaskRuns.find((item) => item.run.id === selectedRunId)
  const selectedRun = selectedRunItem?.run ?? null
  const taskCounts = useMemo(() => ({
    all: tasks.length,
    active: tasks.filter(isTaskActive).length,
    completed: tasks.filter(isTaskCompleted).length,
    failed: tasks.filter(isTaskFailed).length,
  }), [tasks])
  const visibleTasks = useMemo(() => {
    if (taskFilter === 'active') return tasks.filter(isTaskActive)
    if (taskFilter === 'completed') return tasks.filter(isTaskCompleted)
    if (taskFilter === 'failed') return tasks.filter(isTaskFailed)
    return tasks
  }, [taskFilter, tasks])
  const selectedTaskMetrics = selectedRunItem ? taskMetrics(selectedRunItem.task) : null

  const loadTasks = useCallback(async (showSpinner = false) => {
    if (showSpinner) setTasksLoading(true)
    setTasksError('')
    try {
      const records = await getTaskTraces()
      setTasks(records)
      setTaskFilter((current) => current === 'active' && records.every((task) => !isTaskActive(task)) ? 'all' : current)
      const allRuns = records.flatMap((t) => [
        ...flattenTaskRuns(t).map(({ run }) => run),
      ])
      setSelectedRunId((current) => {
        if (current && allRuns.some((r) => r.id === current)) return current
        return records[0]?.runs?.[0]?.id ?? null
      })
    } catch (err) {
      setTasksError(String(err))
    } finally {
      setTasksLoading(false)
    }
  }, [])

  const handleCreateDemoTrace = useCallback(async () => {
    setCreatingDemo(true)
    setTasksError('')
    setDemoNotice(null)
    try {
      const createdTask = await createDemoTaskTrace()
      await loadTasks(true)
      const rootRunId = createdTask.runs?.[0]?.id ?? 'run-demo-codex-root'
      setSelectedRunId(rootRunId)
      setDemoNotice('Demo Task Trace 已创建：包含 Codex 根任务与嵌套的 Dummy Child 子任务。')
    } catch (err) {
      setTasksError(`创建 Demo Task Trace 失败: ${String(err)}`)
    } finally {
      setCreatingDemo(false)
    }
  }, [loadTasks])

  const loadSessions = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true)
    setError('')
    try {
      const remoteSessions = await getMonitorSessions()
      const nextSessions = remoteSessions.length > 0 ? remoteSessions : liveSessions.map(summaryFromSession)
      setSessions(nextSessions)
      setSelectedId((current) => {
        if (current && nextSessions.some((session) => session.id === current)) return current
        return nextSessions[0]?.id ?? null
      })
    } catch (err) {
      setError(String(err))
      setSessions(liveSessions.map(summaryFromSession))
    } finally {
      setLoading(false)
    }
  }, [liveSessions])

  const loadNetworkStatus = useCallback(async () => {
    try {
      const status = await getNetworkMonitorStatus()
      setNetworkStatus(status)
      setNetworkUpstream((current) => current.trim() ? current : status.upstreamBaseUrl)
      return status
    } catch (err) {
      setNetworkError(String(err))
      return null
    }
  }, [])

  const loadWrapperStatus = useCallback(async () => {
    try {
      const status = await getClaudeWrapperStatus()
      setWrapperStatus(status)
      return status
    } catch (err) {
      setNetworkError(String(err))
      return null
    }
  }, [])

  const loadNetworkRequests = useCallback(async () => {
    try {
      const requests = await getNetworkMonitorRequests()
      setNetworkRequests(requests)
      setSelectedNetworkRequestId((current) => {
        if (current && requests.some((request) => request.id === current)) return current
        return requests[0]?.id ?? null
      })
      return requests
    } catch (err) {
      setNetworkError(String(err))
      return []
    }
  }, [])

  useEffect(() => {
    if (activeView === 'tasks') {
      loadTasks(true)
    } else {
      loadSessions(true)
    }
  }, [activeView, loadSessions, loadTasks])

  useEffect(() => {
    loadNetworkStatus().then((status) => {
      if (status?.enabled) loadNetworkRequests()
    })
    loadWrapperStatus()
  }, [loadNetworkRequests, loadNetworkStatus, loadWrapperStatus])

  useEffect(() => {
    if (activeView === 'tasks') return
    const timer = window.setInterval(() => loadSessions(false), sessionRefreshIntervalMs)
    return () => window.clearInterval(timer)
  }, [activeView, loadSessions, sessionRefreshIntervalMs])

  useEffect(() => {
    if (!networkStatus.enabled) return
    const timer = window.setInterval(() => {
      loadNetworkStatus()
      loadNetworkRequests()
    }, networkRefreshIntervalMs)
    return () => window.clearInterval(timer)
  }, [loadNetworkRequests, loadNetworkStatus, networkRefreshIntervalMs, networkStatus.enabled])

  useEffect(() => {
    if (!selectedId || activeView === 'tasks') {
      setDetail(null)
      return
    }

    let cancelled = false
    setDetailLoading(true)
    setDetailError('')
    getMonitorSessionDetail(selectedId)
      .then((result) => {
        if (cancelled) return
        setDetail(result)
      })
      .catch((err) => {
        if (cancelled) return
        setDetail(null)
        setDetailError(String(err))
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [activeView, selectedId])

  useEffect(() => {
    if (!selectedId || activeTab !== 'conversation') return

    let cancelled = false
    setChatLoading(true)
    setChatError('')
    getChatHistoryTail(selectedId, { limit: 200 })
      .then((slice) => {
        if (cancelled) return
        setMessages(mapParsedMessages(slice.messages))
      })
      .catch((err) => {
        if (cancelled) return
        setMessages([])
        setChatError(String(err))
      })
      .finally(() => {
        if (!cancelled) setChatLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [activeTab, selectedId])

  const networkViewActive = activeTab === 'network' || activeView === 'capture'

  useEffect(() => {
    if (!networkViewActive || !networkStatus.enabled) return
    loadNetworkRequests()
  }, [loadNetworkRequests, networkStatus.enabled, networkViewActive])

  useEffect(() => {
    if (!networkViewActive || !selectedNetworkRequestId) {
      setNetworkDetail(null)
      return
    }

    let cancelled = false
    setNetworkLoading(true)
    setNetworkError('')
    getNetworkMonitorRequestDetail(selectedNetworkRequestId)
      .then((result) => {
        if (cancelled) return
        setNetworkDetail(result)
      })
      .catch((err) => {
        if (cancelled) return
        setNetworkDetail(null)
        setNetworkError(String(err))
      })
      .finally(() => {
        if (!cancelled) setNetworkLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [networkViewActive, selectedNetworkRequestId, networkRequests])

  const agentOptions = useMemo(() => Array.from(new Set(sessions.map((session) => session.agentType))).sort(), [sessions])
  const statusOptions = useMemo(() => Array.from(new Set(sessions.map((session) => session.phase))).sort(), [sessions])
  const projectOptions = useMemo(() => Array.from(new Set(sessions.map((session) => session.project || 'Unknown'))).sort(), [sessions])

  const filteredSessions = useMemo(() => sessions.filter((session) => {
    if (agentFilter !== 'all' && session.agentType !== agentFilter) return false
    if (statusFilter !== 'all' && session.phase !== statusFilter) return false
    if (projectFilter !== 'all' && (session.project || 'Unknown') !== projectFilter) return false
    return true
  }), [agentFilter, projectFilter, sessions, statusFilter])

  const selectedSummary = sessions.find((session) => session.id === selectedId) ?? null
  const liveSelected = liveSessions.find((session) => session.id === selectedId)
  const detailSession: DetailSession | undefined = detail?.session ?? liveSelected
  const plan = sessionPlan(detailSession)
  const timeline = detail?.timeline ?? []
  const toolTimeline = timeline.filter((item) => ['session', 'tool', 'hook_tool', 'approval', 'question', 'plan', 'subagent'].includes(item.kind))
  const rawEvents = detail?.rawEvents ?? []
  const pendingPermission = detailSession?.pendingPermission
  const pendingQuestion = detailSession?.pendingQuestion
  const waitingCount = sessions.filter((session) => session.waitingUser).length
  const runningCount = sessions.filter((session) => session.phase === 'processing' || session.phase === 'compacting').length

  const jumpSelected = () => {
    if (!selectedId) return
    jumpToTerminal(selectedId).catch((err) => setDetailError(String(err)))
  }

  const openSelectedTranscript = () => {
    if (!detail?.transcriptPath) return
    openSystemPath(detail.transcriptPath).catch((err) => setDetailError(String(err)))
  }

  const openSelectedTranscriptDirectory = () => {
    const directory = parentPath(detail?.transcriptPath)
    if (!directory) return
    openSystemPath(directory).catch((err) => setDetailError(String(err)))
  }

  const toggleNetworkMonitor = async (enabled: boolean) => {
    setNetworkBusy(true)
    setNetworkError('')
    try {
      const status = await setNetworkMonitorEnabled(enabled, networkUpstream)
      setNetworkStatus(status)
      setNetworkUpstream(status.upstreamBaseUrl)
      if (status.enabled) {
        await loadNetworkRequests()
      } else {
        setNetworkRequests([])
        setSelectedNetworkRequestId(null)
        setNetworkDetail(null)
      }
    } catch (err) {
      setNetworkError(String(err))
    } finally {
      setNetworkBusy(false)
    }
  }

  const toggleClaudeWrapper = async () => {
    setWrapperBusy(true)
    setNetworkError('')
    try {
      const status = wrapperStatus.installed
        ? await removeClaudeWrapper()
        : await installClaudeWrapper()
      setWrapperStatus(status)
    } catch (err) {
      setNetworkError(String(err))
    } finally {
      setWrapperBusy(false)
    }
  }

  const accessControls = (
    <>
      <div className={`agent-monitor__network-control ${networkStatus.enabled ? 'agent-monitor__network-control--on' : ''}`}>
        <div className="agent-monitor__network-copy">
          <strong>原生网络请求监控</strong>
          <span>开启后启动本地 inspector 代理，记录 request body、system prompt、messages、tools、response、usage 和 KV cache 数据。</span>
          <label>
            上游地址
            <input
              value={networkUpstream}
              onChange={(event) => setNetworkUpstream(event.target.value)}
              disabled={networkStatus.enabled || networkBusy}
              placeholder="https://api.anthropic.com"
            />
          </label>
          {networkStatus.proxyUrl && (
            <code>ANTHROPIC_BASE_URL={networkStatus.proxyUrl} claude</code>
          )}
        </div>
        <div className="agent-monitor__network-actions">
          <Toggle checked={networkStatus.enabled} onChange={toggleNetworkMonitor} disabled={networkBusy} />
          <span>{networkStatus.enabled ? '已开启' : '关闭'}</span>
        </div>
      </div>

      <div className={`agent-monitor__wrapper-control ${wrapperStatus.installed ? 'agent-monitor__wrapper-control--on' : ''}`}>
        <div>
          <strong>Claude 命令无感接入</strong>
          <span>
            安装一次后，新开的 iTerm、Terminal、Cursor/VS Code 终端里继续输入 claude，会先进入 Agent Island inspector，再启动真实 Claude。只注入进程级环境变量，不覆盖 Claude settings 或 hooks。
          </span>
          <code>{wrapperStatus.shimPath}</code>
          <em>{wrapperStatus.pathHintInstalled ? `PATH 已写入 ${wrapperStatus.shellConfigPath} · hooks preserved` : `PATH 尚未写入 ${wrapperStatus.shellConfigPath}`}</em>
        </div>
        <button type="button" onClick={toggleClaudeWrapper} disabled={wrapperBusy}>
          {wrapperStatus.installed ? '移除接入' : '安装接入'}
        </button>
      </div>
    </>
  )

  const summaryStats = (
    <div className="agent-monitor__stats" aria-label="Agent monitor summary">
      <div><span>Sessions</span><strong>{sessions.length}</strong></div>
      <div><span>运行中</span><strong>{runningCount}</strong></div>
      <div><span>等待用户</span><strong>{waitingCount}</strong></div>
      <div><span>网络请求</span><strong>{networkStatus.requestCount}</strong></div>
      <div><span>Raw events</span><strong>{rawEvents.length}</strong></div>
    </div>
  )

  const quickControls = (
    <div className="agent-monitor__quick-controls">
      <section className={networkStatus.enabled ? 'agent-monitor__quick-control agent-monitor__quick-control--on' : 'agent-monitor__quick-control'}>
        <div>
          <span>Inspector 代理</span>
          <strong>{networkStatus.enabled ? '运行中' : '未开启'}</strong>
          <em>{networkStatus.proxyUrl || networkStatus.upstreamBaseUrl}</em>
        </div>
        <Toggle checked={networkStatus.enabled} onChange={toggleNetworkMonitor} disabled={networkBusy} />
      </section>
      <section className={wrapperStatus.installed ? 'agent-monitor__quick-control agent-monitor__quick-control--on' : 'agent-monitor__quick-control'}>
        <div>
          <span>Claude 命令接入</span>
          <strong>{wrapperStatus.installed ? '已安装' : '未安装'}</strong>
          <em>{wrapperStatus.pathHintInstalled ? 'PATH 已配置 · 保留 hooks' : '等待安装'}</em>
        </div>
        <button type="button" onClick={toggleClaudeWrapper} disabled={wrapperBusy}>
          {wrapperStatus.installed ? '移除' : '安装'}
        </button>
      </section>
    </div>
  )

  const modelStats = aggregateRequestStats(networkRequests, 'model')
  const projectStats = aggregateRequestStats(networkRequests, 'project')
  const networkTokenTotal = networkRequests.reduce((total, request) => (
    total + (request.usageSummary?.totalTokens ?? usageTotal(request.usage))
  ), 0)

  if (activeView === 'access') {
    return (
      <section className="agent-monitor">
        <header className="agent-monitor__header">
          <div>
            <h2>接入设置</h2>
            <p>管理本地 inspector 代理和 Claude 命令无感接入。provider 仍按当前 shell、项目或全局 Claude 配置决定，Claude hooks/settings 会被保留。</p>
          </div>
          <button type="button" className="agent-monitor__refresh" onClick={() => {
            loadNetworkStatus()
            loadWrapperStatus()
          }}>
            重新加载
          </button>
        </header>
        {accessControls}
        {networkError && <div className="agent-monitor__notice">{networkError}</div>}
      </section>
    )
  }

  if (activeView === 'capture') {
    return (
      <section className="agent-monitor">
        <header className="agent-monitor__header">
          <div>
            <h2>请求抓包</h2>
            <p>按 MainAgent、SubAgent、count、preflight 分类查看 Claude Code 的 system、messages、tools、response 和 KV cache。</p>
          </div>
          <button type="button" className="agent-monitor__refresh" onClick={() => {
            loadNetworkStatus()
            loadNetworkRequests()
          }}>
            刷新请求
          </button>
        </header>
        {accessControls}
        {networkError && <div className="agent-monitor__notice">{networkError}</div>}
        <div className="agent-monitor__capture-workbench">
          <NetworkRequestsTab
            status={networkStatus}
            requests={networkRequests}
            selectedRequestId={selectedNetworkRequestId}
            detail={networkDetail}
            loading={networkLoading}
            onSelect={setSelectedNetworkRequestId}
            onRefresh={() => {
              loadNetworkStatus()
              loadNetworkRequests()
            }}
          />
        </div>
      </section>
    )
  }

  if (activeView === 'stats') {
    return (
      <section className="agent-monitor">
        <header className="agent-monitor__header">
          <div>
            <h2>项目统计</h2>
            <p>按项目和模型聚合请求量、Main/SubAgent 占比、token 消耗和 KV cache 命中。</p>
          </div>
          <button type="button" className="agent-monitor__refresh" onClick={loadNetworkRequests}>刷新统计</button>
        </header>
        {summaryStats}
        <div className="agent-monitor__metric-row agent-monitor__metric-row--wide">
          <div>
            <span>Captured tokens</span>
            <strong>{formatTokens(networkTokenTotal)}</strong>
            <em>来自已捕获网络请求</em>
          </div>
          <div>
            <span>MainAgent requests</span>
            <strong>{networkRequests.filter((request) => request.requestType === 'MainAgent').length}</strong>
            <em>主会话推理请求</em>
          </div>
          <div>
            <span>SubAgent requests</span>
            <strong>{networkRequests.filter((request) => request.requestType === 'SubAgent').length}</strong>
            <em>子任务请求</em>
          </div>
        </div>
        <StatsPanel title="模型使用统计" items={modelStats} />
        <StatsPanel title="项目请求统计" items={projectStats} />
      </section>
    )
  }

  if (activeView === 'usage') {
    return <UnifiedUsageSection />
  }

  if (activeView === 'overview') {
    return (
      <section className="agent-monitor">
        <header className="agent-monitor__header">
          <div>
            <h2>监控总览</h2>
            <p>集中查看 Agent 会话、Claude 原生请求、KV cache 和接入状态。</p>
          </div>
          <button type="button" className="agent-monitor__refresh" onClick={() => {
            loadSessions(true)
            loadNetworkStatus()
            loadNetworkRequests()
          }}>
            重新加载
          </button>
        </header>
        {quickControls}
        {networkError && <div className="agent-monitor__notice">{networkError}</div>}
        {summaryStats}
        <div className="agent-monitor__overview-grid">
          <section>
            <h3>抓包状态</h3>
            <div className="agent-monitor__kv-grid">
              <div><span>Inspector</span><strong>{networkStatus.enabled ? '运行中' : '未开启'}</strong></div>
              <div><span>无感接入</span><strong>{wrapperStatus.installed ? '已安装' : '未安装'}</strong></div>
              <div><span>Proxy</span><strong>{networkStatus.proxyUrl || '-'}</strong></div>
              <div><span>Upstream</span><strong>{networkStatus.upstreamBaseUrl}</strong></div>
            </div>
          </section>
          <section>
            <h3>请求结构</h3>
            <div className="agent-monitor__metric-row">
              <div><span>MainAgent</span><strong>{networkRequests.filter((request) => request.requestType === 'MainAgent').length}</strong><em>主请求</em></div>
              <div><span>SubAgent</span><strong>{networkRequests.filter((request) => request.requestType === 'SubAgent').length}</strong><em>子请求</em></div>
              <div><span>Tokens</span><strong>{formatTokens(networkTokenTotal)}</strong><em>已捕获</em></div>
            </div>
          </section>
        </div>
        <StatsPanel title="模型使用统计" items={modelStats.slice(0, 3)} compact />
      </section>
    )
  }

  if (activeView === 'tasks') {
    return (
      <section className="agent-monitor">
        <header className="agent-monitor__header">
          <div>
            <h2>Tasks</h2>
            <p>持久化任务链路，查看 Codex 与嵌套子 Agent 的执行层级与事件追踪。</p>
          </div>
          <div className="agent-monitor__header-actions">
            <button
              type="button"
              className="agent-monitor__demo-btn"
              data-testid="create-demo-task-trace-btn"
              disabled={creatingDemo}
              onClick={handleCreateDemoTrace}
            >
              {creatingDemo ? '创建中...' : '+ 创建演示 Task Trace'}
            </button>
            <button
              type="button"
              className="agent-monitor__refresh"
              onClick={() => loadTasks(true)}
            >
              重新加载
            </button>
          </div>
        </header>

        {demoNotice && <div className="agent-monitor__notice agent-monitor__notice--success">{demoNotice}</div>}
        {tasksError && <div className="agent-monitor__notice">{tasksError}</div>}

        <div className="agent-monitor__task-filters" role="tablist" aria-label="Task status">
          {([
            ['all', '全部'],
            ['active', 'Active'],
            ['completed', 'Completed'],
            ['failed', 'Failed'],
          ] as Array<[TaskFilter, string]>).map(([filter, label]) => (
            <button
              key={filter}
              type="button"
              role="tab"
              aria-selected={taskFilter === filter}
              className={taskFilter === filter ? 'agent-monitor__task-filter agent-monitor__task-filter--active' : 'agent-monitor__task-filter'}
              onClick={() => setTaskFilter(filter)}
            >
              <span>{label}</span>
              <em>{taskCounts[filter]}</em>
            </button>
          ))}
        </div>

        <div className="agent-monitor__layout">
          <div className="agent-monitor__sessions" aria-label="Task list">
            {tasksLoading && tasks.length === 0 ? (
              <div className="agent-monitor__empty">正在读取任务链路...</div>
            ) : tasks.length === 0 ? (
              <div className="agent-monitor__empty">暂无持久化任务，点击上方按钮创建演示任务链路。</div>
            ) : visibleTasks.length === 0 ? (
              <div className="agent-monitor__empty">当前分类暂无任务。</div>
            ) : (
              <div className="agent-monitor__session-list">
                {visibleTasks.map((task) => {
                  const metrics = taskMetrics(task)
                  return (
                    <div key={task.id} className="agent-monitor__task-card">
                      <div className="agent-monitor__task-card-header">
                        <div>
                          <strong>{task.title}</strong>
                          <span className="agent-monitor__task-meta"> · {task.project} · {task.traceId}</span>
                        </div>
                        <span className="agent-monitor__tag">
                          {phaseLabel(task.status)}
                        </span>
                      </div>
                      <div className="agent-monitor__task-card-metrics">
                        <div><span>Root Agent</span><strong>{metrics.rootAgent ? agentLabel(metrics.rootAgent) : '—'}</strong></div>
                        <div><span>Child Agents</span><strong>{metrics.childAgentCount}</strong></div>
                        <div><span>Blocking</span><strong>{metrics.blockingCount}</strong></div>
                        <div><span>Duration</span><strong>{metrics.durationSeconds == null ? '—' : formatDurationShort(metrics.durationSeconds)}</strong></div>
                        <div><span>Usage</span><strong>{formatTaskUsage(metrics.usage)}</strong></div>
                      </div>
                      {(task.runs ?? []).map((run: AgentRunRecord) => (
                        <div key={run.id} className="agent-monitor__session-group">
                          <button
                            type="button"
                            className={run.id === selectedRunId ? 'agent-monitor__session-row agent-monitor__session-row--active' : 'agent-monitor__session-row'}
                            onClick={() => setSelectedRunId(run.id)}
                          >
                            <span className="agent-monitor__session-agent">
                              <strong>{agentLabel(run.agent)}</strong>
                              <em>{run.role}</em>
                            </span>
                            <span className="agent-monitor__session-main">
                              <strong>{run.title}</strong>
                              {run.dispatchedTask && <em title={run.dispatchedTask}>{run.dispatchedTask}</em>}
                            </span>
                            <span className="agent-monitor__session-state">
                              <i className={`agent-monitor__dot agent-monitor__dot--${run.status}`} />
                              {phaseLabel(run.status)}
                            </span>
                          </button>
                          {run.children && run.children.length > 0 && (
                            <div className="agent-monitor__subagent-nested-list">
                              {run.children.map((child: AgentRunRecord) => (
                                <button
                                  key={child.id}
                                  type="button"
                                  className={selectedRunId === child.id ? 'agent-monitor__subagent-nested-row agent-monitor__subagent-nested-row--active' : 'agent-monitor__subagent-nested-row'}
                                  onClick={() => setSelectedRunId(child.id)}
                                >
                                  <span className="agent-monitor__subagent-tree-branch">└─</span>
                                  <span className="agent-monitor__subagent-nested-agent">{agentLabel(child.agent)}</span>
                                  <span className="agent-monitor__subagent-nested-title">{child.title}</span>
                                  <span className="agent-monitor__subagent-nested-state">
                                    <i className={`agent-monitor__dot agent-monitor__dot--${child.status}`} />
                                    {phaseLabel(child.status)}
                                  </span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <aside className="agent-monitor__detail">
            {!selectedRun ? (
              <div className="agent-monitor__empty agent-monitor__empty--detail">选择一个任务或 Run 查看详情。</div>
            ) : (
              <>
                {selectedRunItem && selectedTaskMetrics && (
                  <TaskDetailSummary task={selectedRunItem.task} metrics={selectedTaskMetrics} />
                )}
                <div className="agent-monitor__detail-header">
                  <div>
                    <span>{agentLabel(selectedRun.agent)} · {selectedRun.role}</span>
                    <h3>{selectedRun.title}</h3>
                    <code>
                      {selectedRun.sessionId}
                      {selectedRun.pid != null && ` · PID ${selectedRun.pid}`}
                      {selectedRun.exitCode != null && ` · exit ${selectedRun.exitCode}`}
                    </code>
                  </div>
                </div>

                {selectedRunItem && selectedTaskMetrics && (
                  <TaskDetailSections task={selectedRunItem.task} metrics={selectedTaskMetrics} />
                )}

                <div className="agent-monitor__timeline">
                  <h4 className="agent-monitor__task-detail-title">Timeline</h4>
                  {(selectedRun.events ?? []).map((evt: TaskEventRecord) => (
                    <div key={evt.id} className="agent-monitor__timeline-item">
                      <time>{new Date(evt.timestampMs).toTimeString().slice(0, 8)}</time>
                      <span>{evt.eventType || evt.kind}</span>
                      <div>
                        <strong>{evt.title}</strong>
                        {evt.detail && <p>{evt.detail}</p>}
                      </div>
                      {evt.status && <em>{phaseLabel(evt.status)}</em>}
                    </div>
                  ))}
                </div>
              </>
            )}
          </aside>
        </div>
      </section>
    )
  }

  return (
    <section className="agent-monitor">
      <header className="agent-monitor__header">
        <div>
          <h2>Agent监控</h2>
          <p>查看 Agent 会话状态与工具调用，并在手动开启后捕获 Claude Code 原生网络请求。</p>
        </div>
        <button type="button" className="agent-monitor__refresh" onClick={() => loadSessions(true)}>
          重新加载
        </button>
      </header>

      {networkError && <div className="agent-monitor__notice">{networkError}</div>}

      {summaryStats}

      <div className="agent-monitor__filters">
        <label>
          Agent
          <select value={agentFilter} onChange={(event) => setAgentFilter(event.target.value)}>
            <option value="all">全部</option>
            {agentOptions.map((agent) => <option key={agent} value={agent}>{agentLabel(agent)}</option>)}
          </select>
        </label>
        <label>
          状态
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="all">全部</option>
            {statusOptions.map((status) => <option key={status} value={status}>{phaseLabel(status)}</option>)}
          </select>
        </label>
        <label>
          项目
          <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}>
            <option value="all">全部</option>
            {projectOptions.map((project) => <option key={project} value={project}>{project}</option>)}
          </select>
        </label>
      </div>

      {error && <div className="agent-monitor__notice">Monitor IPC 读取失败，已回退到前端 sessionStore：{error}</div>}

      <div className="agent-monitor__layout">
        <div className="agent-monitor__sessions" aria-label="Agent session list">
          {loading && sessions.length === 0 ? (
            <div className="agent-monitor__empty">正在读取 Agent 会话...</div>
          ) : filteredSessions.length === 0 ? (
            <div className="agent-monitor__empty">暂无匹配的 Agent 会话。</div>
          ) : (
            <div className="agent-monitor__session-list">
              {filteredSessions.map((session) => {
                const sessionData = liveSessions.find((s) => s.id === session.id)
                const subagents = sessionData?.subagents ?? (detailSession?.id === session.id ? detailSession?.subagents : undefined)
                return (
                  <div key={session.id} className="agent-monitor__session-group">
                    <button
                      type="button"
                      className={session.id === selectedId ? 'agent-monitor__session-row agent-monitor__session-row--active' : 'agent-monitor__session-row'}
                      onClick={() => {
                        setSelectedId(session.id)
                        setActiveTab('overview')
                      }}
                    >
                      <span className="agent-monitor__session-agent">
                        <strong>{agentLabel(session.agentType, session.engineLabel)}</strong>
                        <em>{session.id.slice(0, 8)}</em>
                      </span>
                      <span className="agent-monitor__session-main">
                        <strong>{session.title || session.project || 'Unknown'}</strong>
                        <em title={session.cwd}>{shortPath(session.cwd)}</em>
                      </span>
                      <span className="agent-monitor__session-state">
                        <i className={`agent-monitor__dot agent-monitor__dot--${session.phase}`} />
                        {phaseLabel(session.phase)}
                      </span>
                      <span className="agent-monitor__session-metrics">
                        <em>{formatDurationShort(session.duration)}</em>
                        <em>{formatTokens(session.tokenTotal)} tok</em>
                        <em>{session.subagentCount} sub</em>
                      </span>
                      <span className="agent-monitor__session-foot">
                        <em>{session.lastToolName || '无工具'}</em>
                        <em>{session.waitingUser ? pendingLabel(session.pendingKind) : '无等待'}</em>
                      </span>
                    </button>
                    {subagents && subagents.length > 0 && (
                      <div className="agent-monitor__subagent-nested-list">
                        {subagents.map((sub) => (
                          <button
                            key={sub.agentId}
                            type="button"
                            className={selectedId === sub.agentId ? 'agent-monitor__subagent-nested-row agent-monitor__subagent-nested-row--active' : 'agent-monitor__subagent-nested-row'}
                            onClick={(e) => {
                              e.stopPropagation()
                              setSelectedId(sub.agentId)
                              setActiveTab('overview')
                            }}
                          >
                            <span className="agent-monitor__subagent-tree-branch">└─</span>
                            <span className="agent-monitor__subagent-nested-agent">{agentLabel(sub.agentType || 'dummy')}</span>
                            <span className="agent-monitor__subagent-nested-title">{sub.name || 'Dummy Child'}</span>
                            <span className="agent-monitor__subagent-nested-state">
                              <i className={`agent-monitor__dot agent-monitor__dot--${sub.status === 'completed' ? 'done' : sub.status}`} />
                              {phaseLabel(sub.status === 'completed' ? 'done' : sub.status)}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <aside className="agent-monitor__detail">
          {!selectedId ? (
            <div className="agent-monitor__empty agent-monitor__empty--detail">选择一个 session 查看详情。</div>
          ) : (
            <>
              <div className="agent-monitor__detail-header">
                <div>
                  <span>{selectedSummary ? agentLabel(selectedSummary.agentType, selectedSummary.engineLabel) : 'Session'}</span>
                  <h3>{selectedSummary?.title || selectedSummary?.project || selectedId}</h3>
                  <code title={detail?.transcriptPath || undefined}>{selectedId}</code>
                </div>
                <div className="agent-monitor__detail-actions">
                  <button type="button" onClick={openSelectedTranscript} disabled={!detail?.transcriptPath}>
                    打开 JSON
                  </button>
                  <button type="button" onClick={openSelectedTranscriptDirectory} disabled={!parentPath(detail?.transcriptPath)}>
                    打开目录
                  </button>
                  <button type="button" onClick={jumpSelected}>跳转终端</button>
                </div>
              </div>

              <div className="agent-monitor__tabs">
                {DETAIL_TABS.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    className={activeTab === tab.id ? 'active' : ''}
                    onClick={() => setActiveTab(tab.id)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {detailLoading && <div className="agent-monitor__inline">正在刷新详情...</div>}
              {detailError && <div className="agent-monitor__notice">{detailError}</div>}

              {activeTab === 'overview' && (
                <OverviewTab session={detailSession} summary={selectedSummary} rawCount={rawEvents.length} timelineCount={timeline.length} />
              )}

              {activeTab === 'network' && (
                <NetworkRequestsTab
                  status={networkStatus}
                  requests={networkRequests}
                  selectedRequestId={selectedNetworkRequestId}
                  detail={networkDetail}
                  loading={networkLoading}
                  onSelect={setSelectedNetworkRequestId}
                  onRefresh={() => {
                    loadNetworkStatus()
                    loadNetworkRequests()
                  }}
                />
              )}

              {activeTab === 'conversation' && (
                <ConversationTab loading={chatLoading} error={chatError} messages={messages} />
              )}

              {activeTab === 'timeline' && (
                <TimelineTab items={toolTimeline} />
              )}

              {activeTab === 'approvals' && (
                <ApprovalsTab
                  permission={pendingPermission}
                  question={pendingQuestion}
                  plan={plan}
                  onJump={jumpSelected}
                />
              )}

              {activeTab === 'raw' && (
                <RawEventsTab events={rawEvents} />
              )}
            </>
          )}
        </aside>
      </div>
    </section>
  )
}

function TaskDetailSummary({ task, metrics }: { task: TaskRecord; metrics: TaskMetrics }) {
  return (
    <section className="agent-monitor__task-detail-summary">
      <div className="agent-monitor__task-detail-summary-head">
        <div>
          <span>Task</span>
          <strong>{task.title}</strong>
          <em title={`${task.project} · ${task.traceId} · ${task.id}`}>Trace metadata</em>
        </div>
        <b>{phaseLabel(task.status)}</b>
      </div>
      <div className="agent-monitor__task-detail-metrics">
        <div><span>Root Agent</span><strong>{metrics.rootAgent ? agentLabel(metrics.rootAgent) : '—'}</strong></div>
        <div><span>Child Agents</span><strong>{metrics.childAgentCount}</strong></div>
        <div><span>Blocking</span><strong>{metrics.blockingCount}</strong></div>
        <div><span>Duration</span><strong>{metrics.durationSeconds == null ? '—' : formatDurationShort(metrics.durationSeconds)}</strong></div>
      </div>
    </section>
  )
}

function TaskTreeSummary({ runs, depth = 0 }: { runs: AgentRunRecord[]; depth?: number }) {
  return (
    <div className="agent-monitor__task-tree">
      {runs.map((run) => (
        <div key={run.id} className="agent-monitor__task-tree-node">
          <div className="agent-monitor__task-tree-row" style={{ paddingLeft: `${depth * 16}px` }}>
            <span>{depth > 0 ? '└─' : '●'}</span>
            <strong>{agentLabel(run.agent)} · {run.title}</strong>
            <em>{phaseLabel(run.status)}</em>
          </div>
          {run.children && run.children.length > 0 && <TaskTreeSummary runs={run.children} depth={depth + 1} />}
        </div>
      ))}
    </div>
  )
}

function TaskDetailSections({ task, metrics }: { task: TaskRecord; metrics: TaskMetrics }) {
  const runs = flattenTaskRuns(task).map(({ run }) => run)
  return (
    <div className="agent-monitor__task-detail-sections">
      <section className="agent-monitor__task-detail-section">
        <h4>Task Tree</h4>
        {task.runs && task.runs.length > 0 ? <TaskTreeSummary runs={task.runs} /> : <p>暂无 Agent Run。</p>}
      </section>

      <section className="agent-monitor__task-detail-section">
        <h4>Agent Runs <em>{metrics.runCount}</em></h4>
        {runs.length > 0 ? (
          <div className="agent-monitor__task-run-list">
            {runs.map((run) => (
              <div key={run.id} className="agent-monitor__task-run-item">
                <strong>{agentLabel(run.agent)} · {run.title}</strong>
                <span>{run.role}</span>
                <em>{phaseLabel(run.status)}</em>
              </div>
            ))}
          </div>
        ) : <p>暂无 Agent Run。</p>}
      </section>

      <section className="agent-monitor__task-detail-section">
        <h4>Usage</h4>
        {metrics.usage ? (
          <div className="agent-monitor__task-usage">
            <div><span>Total</span><strong>{formatTokens(metrics.usage.totalTokens)}</strong></div>
            <div><span>Input</span><strong>{formatOptionalTokens(metrics.usage.inputTokens)}</strong></div>
            <div><span>Output</span><strong>{formatOptionalTokens(metrics.usage.outputTokens)}</strong></div>
            <div><span>Cache</span><strong>{formatOptionalTokens(metrics.usage.cacheReadTokens)}</strong></div>
          </div>
        ) : <p>暂无 trace usage 数据（事件未提供 token 字段）。</p>}
      </section>

      <section className="agent-monitor__task-detail-section">
        <h4>Errors <em>{metrics.errors.length}</em></h4>
        {metrics.errors.length > 0 ? (
          <div className="agent-monitor__task-error-list">
            {metrics.errors.map((error) => (
              <div key={error.id} className="agent-monitor__task-error-item">
                <strong>{error.title}</strong>
                <span>{error.detail || '未提供错误详情'}</span>
                <em>{phaseLabel(error.status)}</em>
              </div>
            ))}
          </div>
        ) : <p>暂无错误。</p>}
      </section>
    </div>
  )
}

function OverviewTab({
  session,
  summary,
  rawCount,
  timelineCount,
}: {
  session?: DetailSession
  summary: MonitorSessionSummary | null
  rawCount: number
  timelineCount: number
}) {
  if (!session && !summary) return <div className="agent-monitor__empty">暂无详情数据。</div>

  const tokens = session?.tokens
  const contextWindow = session?.contextWindow
  const rateLimits = session?.rateLimits

  return (
    <div className="agent-monitor__overview">
      <div className="agent-monitor__kv-grid">
        <div><span>phase</span><strong>{phaseLabel(session?.phase ?? summary?.phase)}</strong></div>
        <div><span>cwd</span><strong title={session?.cwd ?? summary?.cwd}>{shortPath(session?.cwd ?? summary?.cwd)}</strong></div>
        <div><span>terminal</span><strong>{session?.terminal || summary?.terminal || '-'}</strong></div>
        <div><span>pid</span><strong>{session?.pid ?? '-'}</strong></div>
        <div><span>tools</span><strong>{timelineCount}</strong></div>
        <div><span>raw events</span><strong>{rawCount}</strong></div>
      </div>

      <div className="agent-monitor__metric-row">
        <div>
          <span>Token usage</span>
          <strong>{formatTokens(totalTokens(tokens))}</strong>
          <em>{formatTokens(tokens?.input ?? 0)} in · {formatTokens(tokens?.output ?? 0)} out · {formatTokens(tokens?.cacheRead ?? 0)} cache</em>
        </div>
        <div>
          <span>Context window</span>
          <strong>{contextWindow?.usedPercentage != null ? `${Math.round(contextWindow.usedPercentage)}%` : '-'}</strong>
          <em>{formatTokens(contextWindow?.totalInputTokens ?? 0)} / {formatTokens(contextWindow?.contextWindowSize ?? 0)}</em>
        </div>
        <div>
          <span>Rate limit</span>
          <strong>{rateLimits ? `${Math.round(rateLimits.fiveHourUsage)}%` : '-'}</strong>
          <em>{rateLimits ? `5h ${rateLimits.fiveHourRemaining} · 7d ${rateLimits.sevenDayRemaining}` : 'no statusline data'}</em>
        </div>
      </div>

      {session?.subagents && session.subagents.length > 0 && (
        <div className="agent-monitor__subagents">
          <h4>Subagents</h4>
          {session.subagents.map((subagent) => (
            <div key={subagent.agentId} className="agent-monitor__subagent">
              <strong>{subagent.name ? `@${subagent.name}` : (subagent.agentType || 'subagent')}</strong>
              <span>{subagent.status}</span>
              <p>{subagent.description}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function StatsPanel({
  title,
  items,
  compact = false,
}: {
  title: string
  items: RequestStats[]
  compact?: boolean
}) {
  return (
    <section className={`agent-monitor__stats-panel ${compact ? 'agent-monitor__stats-panel--compact' : ''}`}>
      <h3>{title}</h3>
      {items.length === 0 ? (
        <div className="agent-monitor__empty">暂无可统计的网络请求。开启请求抓包并运行 Claude 后会在这里聚合。</div>
      ) : (
        <div className="agent-monitor__stats-list">
          {items.map((item) => {
            const hitRate = cacheHitRate(item)
            return (
              <article key={item.key} className="agent-monitor__stats-item">
                <header>
                  <strong>{item.key}</strong>
                  <span>{item.requestCount} reqs</span>
                </header>
                <div>
                  <span>Token</span>
                  <strong>{formatTokens(item.inputTokens + item.outputTokens)}</strong>
                  <em>{formatTokens(item.inputTokens)} in · {formatTokens(item.outputTokens)} out</em>
                </div>
                <div>
                  <span>KV Cache</span>
                  <strong>{hitRate == null ? '-' : `${hitRate}%`}</strong>
                  <em>{formatTokens(item.cacheCreate)} create · {formatTokens(item.cacheRead)} read</em>
                </div>
                <div>
                  <span>Agent</span>
                  <strong>{item.mainAgentCount}/{item.subAgentCount}</strong>
                  <em>Main/Sub</em>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}

function NetworkRequestsTab({
  status,
  requests,
  selectedRequestId,
  detail,
  loading,
  onSelect,
  onRefresh,
}: {
  status: NetworkMonitorStatus
  requests: NetworkRequestSummary[]
  selectedRequestId: string | null
  detail: NetworkRequestDetail | null
  loading: boolean
  onSelect: (requestId: string) => void
  onRefresh: () => void
}) {
  const [detailTab, setDetailTab] = useState<NetworkDetailTab>('system')

  if (!status.enabled) {
    return (
      <div className="agent-monitor__empty">
        开启上方“原生网络请求监控”后，这里会显示 Claude Code API 请求、system prompt、messages、tools 和 usage。
      </div>
    )
  }

  if (requests.length === 0) {
    return (
      <div className="agent-monitor__empty">
        代理已启动，等待请求进入。外部终端可用 <code>ANTHROPIC_BASE_URL={status.proxyUrl} claude</code> 启动。
      </div>
    )
  }

  const selected = requests.find((request) => request.id === selectedRequestId) ?? requests[0]
  const usage = selected?.usageSummary ?? null
  const rawUsage = selected?.usage ?? null
  const networkTabs: Array<{ id: NetworkDetailTab; label: string }> = [
    { id: 'system', label: 'System' },
    { id: 'messages', label: 'Messages' },
    { id: 'tools', label: 'Tools' },
    { id: 'response', label: 'Response' },
    { id: 'headers', label: 'Headers' },
    { id: 'raw', label: 'Raw' },
  ]

  return (
    <div className="agent-monitor__network-tab">
      <div className="agent-monitor__network-toolbar">
        <span>{status.activeRequestCount > 0 ? `${status.activeRequestCount} 个请求进行中` : '无进行中请求'}</span>
        <button type="button" onClick={onRefresh}>刷新请求</button>
      </div>

      <div className="agent-monitor__network-list">
        {requests.map((request) => (
          <button
            key={request.id}
            type="button"
            className={request.id === selected.id ? 'agent-monitor__network-row agent-monitor__network-row--active' : 'agent-monitor__network-row'}
            onClick={() => onSelect(request.id)}
          >
            <span>{formatTime(request.timestampMs)}</span>
            <strong>{request.model || request.provider}</strong>
            <em>{request.inProgress ? 'streaming' : request.status ? `HTTP ${request.status}` : request.error ? 'error' : 'pending'}</em>
            <small>{requestTypeLabel(request)} · {request.messageCount} msg · {request.toolCount} tools · {formatBytes(request.requestBytes)}</small>
          </button>
        ))}
      </div>

      <div className="agent-monitor__network-detail">
        <div className="agent-monitor__kv-grid">
          <div><span>model</span><strong>{selected.model || '-'}</strong></div>
          <div><span>type</span><strong>{requestTypeLabel(selected)}</strong></div>
          <div><span>status</span><strong>{selected.inProgress ? 'streaming' : selected.status ?? selected.error ?? '-'}</strong></div>
          <div><span>duration</span><strong>{selected.durationMs != null ? `${selected.durationMs}ms` : '-'}</strong></div>
          <div><span>tokens</span><strong>{usage ? formatTokens(usage.totalTokens) : rawUsage ? formatTokens(usageTotal(rawUsage)) : '-'}</strong></div>
          <div><span>cache hit</span><strong>{usage?.cacheHitRate != null ? `${Math.round(usage.cacheHitRate)}%` : '-'}</strong></div>
        </div>

        {loading ? (
          <div className="agent-monitor__inline">正在读取请求详情...</div>
        ) : detail ? (
          <>
            {usage && (
              <div className="agent-monitor__network-usage" aria-label="Network token usage">
                <span>input {formatTokens(usage.inputTokens)}</span>
                <span>output {formatTokens(usage.outputTokens)}</span>
                <span>cache create {formatTokens(usage.cacheCreationInputTokens)}</span>
                <span>cache read {formatTokens(usage.cacheReadInputTokens)}</span>
              </div>
            )}

            <div className="agent-monitor__subtabs">
              {networkTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={detailTab === tab.id ? 'active' : ''}
                  onClick={() => setDetailTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {detailTab === 'system' && (
              <section className="agent-monitor__network-section">
                <h4>System Prompt</h4>
                {requestSystem(detail.requestBody) ? (
                  <pre>{JSON.stringify(requestSystem(detail.requestBody), null, 2)}</pre>
                ) : (
                  <p>{selected.systemPreview || 'No system prompt captured.'}</p>
                )}
              </section>
            )}

            {detailTab === 'messages' && (
              <section className="agent-monitor__network-section">
                <h4>Messages</h4>
                {requestMessages(detail.requestBody).length > 0 ? (
                  <div className="agent-monitor__network-block-list">
                    {requestMessages(detail.requestBody).map((message, index) => {
                      const item = jsonObject(message)
                      return (
                        <details key={index} open={index >= requestMessages(detail.requestBody).length - 2}>
                          <summary>{String(item.role ?? 'message')} #{index + 1}</summary>
                          <pre>{JSON.stringify(message, null, 2)}</pre>
                        </details>
                      )
                    })}
                  </div>
                ) : (
                  <p>No messages captured.</p>
                )}
              </section>
            )}

            {detailTab === 'tools' && (
              <section className="agent-monitor__network-section">
                <h4>Tools</h4>
                {requestTools(detail.requestBody).length > 0 ? (
                  <div className="agent-monitor__network-block-list">
                    {requestTools(detail.requestBody).map((tool, index) => {
                      const item = jsonObject(tool)
                      return (
                        <details key={index}>
                          <summary>{String(item.name ?? `tool-${index + 1}`)}</summary>
                          <pre>{JSON.stringify(tool, null, 2)}</pre>
                        </details>
                      )
                    })}
                  </div>
                ) : (
                  <p>No tools captured.</p>
                )}
              </section>
            )}

            {detailTab === 'response' && (
              <section className="agent-monitor__network-section">
                <h4>Response{detail.responseBodyTruncated ? ' · truncated' : ''}</h4>
                {detail.responseBody && responseEvents(detail.responseBody).length > 0 ? (
                  <div className="agent-monitor__network-block-list">
                    {responseEvents(detail.responseBody).map((event, index) => (
                      <details key={index} open={index === responseEvents(detail.responseBody).length - 1}>
                        <summary>event #{index + 1}</summary>
                        <pre>{typeof event === 'string' ? event : JSON.stringify(event, null, 2)}</pre>
                      </details>
                    ))}
                  </div>
                ) : (
                  <pre>{detail.responseBody || JSON.stringify(detail.responseHeaders, null, 2)}</pre>
                )}
              </section>
            )}

            {detailTab === 'headers' && (
              <section className="agent-monitor__network-section">
                <h4>Headers</h4>
                <pre>{JSON.stringify({ request: detail.requestHeaders, response: detail.responseHeaders }, null, 2)}</pre>
              </section>
            )}

            {detailTab === 'raw' && (
              <section className="agent-monitor__network-section">
                <h4>Raw Request / Response</h4>
                <pre>{JSON.stringify({
                  summary: detail.summary,
                  requestBody: detail.requestBody,
                  responseBody: detail.responseBody,
                }, null, 2)}</pre>
              </section>
            )}
          </>
        ) : (
          <div className="agent-monitor__empty">选择一个请求查看原始 request / response。</div>
        )}
      </div>
    </div>
  )
}

function ConversationTab({ loading, error, messages }: { loading: boolean; error: string; messages: ChatMessage[] }) {
  if (loading) return <div className="agent-monitor__empty">正在解析对话历史...</div>
  if (error) return <div className="agent-monitor__empty">未找到可解析的 transcript：{error}</div>
  if (messages.length === 0) return <div className="agent-monitor__empty">暂无对话历史。</div>

  return (
    <div className="agent-monitor__conversation">
      {messages.map((message, index) => (
        <div key={`${message.role}:${message.timestamp}:${index}`} className={`agent-monitor__message agent-monitor__message--${message.role}`}>
          <span>{roleLabel(message.role)}</span>
          <p>{messagePreview(message)}</p>
          {'toolCalls' in message && message.toolCalls && message.toolCalls.length > 0 && (
            <div className="agent-monitor__tool-chips">
              {message.toolCalls.map((tool) => (
                <em key={`${tool.toolUseId || tool.toolName}:${tool.toolName}`}>{tool.toolName} · {tool.status}</em>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function TimelineTab({ items }: { items: MonitorTimelineItem[] }) {
  if (items.length === 0) return <div className="agent-monitor__empty">暂无工具或 hook 时间线。</div>

  return (
    <div className="agent-monitor__timeline">
      {items.map((item) => (
        <div key={item.id} className="agent-monitor__timeline-item">
          <time>{formatTime(item.timestampMs)}</time>
          <span>{timelineKindLabel(item.kind)}</span>
          <div>
            <strong>{item.title}</strong>
            {item.detail && <p>{item.detail}</p>}
          </div>
          <em>{item.status || (item.rawEventSeq != null ? `#${item.rawEventSeq}` : '')}</em>
        </div>
      ))}
    </div>
  )
}

function ApprovalsTab({
  permission,
  question,
  plan,
  onJump,
}: {
  permission?: DetailSession['pendingPermission']
  question?: DetailSession['pendingQuestion']
  plan: { title: string; content: string; permissions: string[] } | null
  onJump: () => void
}) {
  if (!permission && !question && !plan) {
    return <div className="agent-monitor__empty">当前 session 没有 pending approval、question 或 plan。</div>
  }

  return (
    <div className="agent-monitor__pending">
      {permission && (
        <section>
          <h4>Pending Permission</h4>
          <strong>{permission.toolName}</strong>
          <pre>{permission.toolInput || 'no input'}</pre>
        </section>
      )}
      {question && (
        <section>
          <h4>Pending Question</h4>
          <strong>{question.header || 'AskUserQuestion'}</strong>
          <p>{question.question}</p>
          {question.options.length > 0 && (
            <div className="agent-monitor__tool-chips">
              {question.options.map((option) => <em key={option}>{option}</em>)}
            </div>
          )}
        </section>
      )}
      {plan && (
        <section>
          <h4>Pending Plan</h4>
          <strong>{plan.title}</strong>
          <pre>{plan.content}</pre>
          {plan.permissions.length > 0 && (
            <div className="agent-monitor__tool-chips">
              {plan.permissions.map((permission) => <em key={permission}>{permission}</em>)}
            </div>
          )}
        </section>
      )}
      <button type="button" onClick={onJump}>跳转到对应终端处理</button>
    </div>
  )
}

function RawEventsTab({ events }: { events: MonitorSessionDetail['rawEvents'] }) {
  if (events.length === 0) return <div className="agent-monitor__empty">暂无 raw hook event。</div>

  return (
    <div className="agent-monitor__raw">
      {events.slice().reverse().map((event) => (
        <details key={event.seq} className="agent-monitor__raw-item">
          <summary>
            <span>{formatTime(event.timestampMs)}</span>
            <strong>{event.eventName}</strong>
            <em>#{event.seq}</em>
          </summary>
          <pre>{JSON.stringify(event.raw, null, 2)}</pre>
        </details>
      ))}
    </div>
  )
}
