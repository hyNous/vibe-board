import type { AgentRunStatus, SessionPhase } from './agent'

export type TaskRunStatus = SessionPhase | AgentRunStatus | (string & {})

export interface TaskEventRecord {
  id: string
  taskId: string
  runId: string
  timestampMs: number
  kind: string
  eventType: string
  title: string
  detail?: string | null
  status?: TaskRunStatus | null
  payloadJson?: string | null
  createdAt: string
}

export interface AgentRunRecord {
  id: string
  taskId: string
  sessionId: string
  parentRunId?: string | null
  agent: string
  role: string
  dispatchedTask?: string | null
  title: string
  status: TaskRunStatus
  startedAt: number
  completedAt?: number | null
  pid?: number | null
  exitCode?: number | null
  children?: AgentRunRecord[]
  events?: TaskEventRecord[]
  createdAt: string
  updatedAt?: string
}

export interface TaskRecord {
  id: string
  traceId: string
  project: string
  title: string
  status: TaskRunStatus
  runs?: AgentRunRecord[]
  createdAt: string
  updatedAt?: string
}
