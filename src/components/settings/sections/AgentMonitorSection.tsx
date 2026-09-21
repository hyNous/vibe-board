import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  getMonitorSessions,
  getTaskTraces,
  type AgentRunRecord,
  type MonitorSessionSummary,
  type TaskEventRecord,
  type TaskRecord,
} from '../../../services/monitorApi'
import { selectSessionList, useSessionStore } from '../../../stores/sessionStore'
import { useConfigStore } from '../../../stores/configStore'
import type { SessionState, TokenUsage } from '../../../types/agent'
import { formatDurationShort } from '../../../utils/time'
import { getSessionTaskDurationSeconds } from '../../../utils/sessionDisplay'
import { formatTokens } from '../../../utils/tokens'
import './AgentMonitorSection.css'

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

function totalTokens(tokens: TokenUsage | undefined) {
  if (!tokens) return 0
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreate
}

type TaskFilter = 'all' | 'active' | 'completed' | 'failed'

const COMPLETED_STATUSES = new Set(['done', 'completed'])
const FAILED_STATUSES = new Set(['error', 'failed', 'failure', 'interrupted', 'cancelled'])
const BLOCKING_STATUSES = new Set([
  'waiting',
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
    subagentCount: session.subagents.length,
    activeToolCount: session.activeTools.filter((tool) => tool.status === 'running').length,
    title: session.sessionTitle ?? null,
  }
}

const LIVE_TASK_PHASES = new Set(['processing', 'compacting', 'waiting_input'])

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function AgentMonitorSection() {
  const liveSessions = useSessionStore(selectSessionList)
  const codexAppServerLive = useSessionStore((state) => state.codexAppServerLive)
  const sessionRefreshIntervalSeconds = useConfigStore((state) => state.sessionRefreshIntervalSeconds)
  const [sessions, setSessions] = useState<MonitorSessionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [tasksLoading, setTasksLoading] = useState(false)
  const [tasksError, setTasksError] = useState('')
  const [taskFilter, setTaskFilter] = useState<TaskFilter>('active')
  const configuredRefreshMs = Math.max(1, Math.min(30, sessionRefreshIntervalSeconds)) * 1000

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
  const liveTaskSessions = useMemo(() => sessions
    .filter((session) => LIVE_TASK_PHASES.has(session.phase))
    .sort((a, b) => b.startedAt - a.startedAt), [sessions])
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

  const loadSessions = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true)
    setError('')
    try {
      const remoteSessions = await getMonitorSessions()
      const nextSessions = Array.from(new Map(
        [...remoteSessions, ...liveSessions.map(summaryFromSession)]
          .map((session) => [session.id, session] as const),
      ).values())
      setSessions(nextSessions)
    } catch (err) {
      setError(String(err))
      setSessions(liveSessions.map(summaryFromSession))
    } finally {
      setLoading(false)
    }
  }, [liveSessions])

  useEffect(() => {
    void loadSessions(true)
    void loadTasks(true)
  }, [loadSessions, loadTasks])

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadSessions(false)
      void loadTasks(false)
    }, configuredRefreshMs)
    return () => window.clearInterval(timer)
  }, [configuredRefreshMs, loadSessions, loadTasks])

  return (
    <section className="agent-monitor">
      <header className="agent-monitor__header">
        <div>
          <h2>Tasks</h2>
          <p>上方实时任务来自当前 Agent session；下方 Task Trace 用于持久化链路与事件追踪，两者分开统计。Codex app-server：{codexAppServerLive ? '已连接' : '未连接'}。</p>
        </div>
        <div className="agent-monitor__header-actions">
          <button
            type="button"
            className="agent-monitor__refresh"
            onClick={() => {
              void loadSessions(true)
              void loadTasks(true)
            }}
          >
            重新加载
          </button>
        </div>
      </header>

      {tasksError && <div className="agent-monitor__notice">{tasksError}</div>}
      {error && <div className="agent-monitor__notice">会话读取失败，已回退到前端 sessionStore：{error}</div>}

      <section className="agent-monitor__live-tasks" data-testid="live-task-list" aria-label="当前实时任务">
        <div className="agent-monitor__live-tasks-header">
          <div>
            <h3>当前实时任务 <em>{liveTaskSessions.length}</em></h3>
            <p>宿主和其他 Agent 的独立 session 都会显示；嵌套 subagent 计入宿主的子任务数，不重复计数。</p>
          </div>
          <span>{codexAppServerLive ? 'Codex 已连接' : 'Codex 未连接'} · {sessions.length} 个已同步会话</span>
        </div>
        {loading && sessions.length === 0 ? (
          <div className="agent-monitor__empty">正在同步当前 Agent 会话...</div>
        ) : liveTaskSessions.length === 0 ? (
          <div className="agent-monitor__empty">
            {codexAppServerLive
              ? `当前没有正在运行或等待中的任务（已同步 ${sessions.length} 个会话）。`
              : '当前没有可用的 Codex 实时同步连接。若 Codex 正在处理，请先在设置 → 通用完成宿主/Hook 配置并重启 Vibe Board。'}
          </div>
        ) : (
          <div className="agent-monitor__live-task-list">
            {liveTaskSessions.map((session) => (
              <article key={session.id} className="agent-monitor__live-task-row" data-testid={`live-task-${session.id}`}>
                <span className="agent-monitor__live-task-agent">{agentLabel(session.agentType, session.engineLabel)}</span>
                <div className="agent-monitor__live-task-main">
                  <strong>{session.title || session.project || 'Unknown'}</strong>
                  <code title={session.id}>{session.id}</code>
                </div>
                <span className="agent-monitor__live-task-state">{phaseLabel(session.phase)}</span>
                <span className="agent-monitor__live-task-meta">
                  {formatDurationShort(session.duration)} · {formatTokens(session.tokenTotal)} tok · {session.subagentCount} sub
                </span>
              </article>
            ))}
          </div>
        )}
      </section>

      <div className="agent-monitor__task-trace-heading">
        <div>
          <h3>持久化 Task Trace</h3>
          <p>这里的数量包含历史/演示 Trace，不代表当前正在运行的 session 数量。</p>
        </div>
      </div>

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
            <div className="agent-monitor__empty">暂无持久化任务链路。</div>
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
