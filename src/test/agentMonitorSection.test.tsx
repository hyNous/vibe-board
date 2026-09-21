import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsApp } from '../components/settings'
import { AgentMonitorSection } from '../components/settings/sections/AgentMonitorSection'
import type { MonitorSessionSummary } from '../services/monitorApi'
import { useSessionStore } from '../stores/sessionStore'

const monitorMocks = vi.hoisted(() => ({
  getMonitorSessions: vi.fn(),
  getTaskTraces: vi.fn(),
}))

vi.mock('../services/monitorApi', () => ({
  getMonitorSessions: monitorMocks.getMonitorSessions,
  getTaskTraces: monitorMocks.getTaskTraces,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'zh' },
  }),
}))

const summary: MonitorSessionSummary = {
  id: 'session-1',
  agentType: 'claude-code',
  engineLabel: null,
  project: 'agentbro',
  cwd: '/Users/me/code/agentbro',
  terminal: 'iTerm',
  phase: 'waiting_input',
  startedAt: 1_700_000_000,
  duration: 125,
  tokenTotal: 4200,
  lastToolName: 'Edit',
  lastToolTarget: 'src/App.tsx',
  lastToolStatus: 'running',
  subagentCount: 1,
  activeToolCount: 1,
  title: 'agentbro · monitor',
}

describe('AgentMonitorSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSessionStore.setState({ sessions: {}, sessionList: [], activeSessionId: null })
    monitorMocks.getMonitorSessions.mockResolvedValue([summary])
    monitorMocks.getTaskTraces.mockResolvedValue([])
  })

  it('separates live sessions from persisted task traces and includes every active agent session', async () => {
    const antigravitySummary = {
      ...summary,
      id: 'session-antigravity',
      agentType: 'antigravity',
      phase: 'processing',
      title: 'Live Antigravity task',
    }
    monitorMocks.getMonitorSessions.mockResolvedValue([summary, antigravitySummary])

    render(<AgentMonitorSection />)

    await waitFor(() => expect(screen.getByTestId('live-task-list')).toBeInTheDocument())
    expect(screen.getByTestId('live-task-session-1')).toBeInTheDocument()
    expect(screen.getByTestId('live-task-session-antigravity')).toBeInTheDocument()
    expect(screen.getByText('Live Antigravity task')).toBeInTheDocument()
    expect(screen.getByText('每个 Agent 的独立 session 都会显示；嵌套 subagent 计入所属会话的子任务数，不重复计数。')).toBeInTheDocument()
    expect(monitorMocks.getTaskTraces).toHaveBeenCalled()
  })

  it('keeps unfinished modules out of the settings menu', async () => {
    monitorMocks.getMonitorSessions.mockResolvedValue([])

    render(<SettingsApp onClose={vi.fn()} />)

    expect(screen.queryByText('settings.agents')).not.toBeInTheDocument()
    expect(screen.queryByText('settings.agentMonitor')).not.toBeInTheDocument()
    expect(screen.queryByText('settings.switch')).not.toBeInTheDocument()
    expect(screen.queryByText('远程服务器')).not.toBeInTheDocument()
  })

  it('renders persisted task traces with nested runs and ordered events', async () => {
    const persistedTask = {
      id: 'task-demo-control-tower',
      traceId: 'trace-codex-orchestration-001',
      project: 'control-tower',
      title: 'Demo: Codex Orchestration',
      status: 'done',
      runs: [
        {
          id: 'run-demo-codex-root',
          taskId: 'task-demo-control-tower',
          sessionId: 'session-codex-root',
          parentRunId: null,
          agent: 'codex',
          role: 'orchestrator',
          dispatchedTask: 'Coordinate workspace changes',
          title: 'Codex Root Run',
          status: 'done',
          children: [
            {
              id: 'run-demo-dummy-child',
              taskId: 'task-demo-control-tower',
              sessionId: 'session-dummy-child',
              parentRunId: 'run-demo-codex-root',
              agent: 'dummy',
              role: 'worker',
              dispatchedTask: 'Execute component AST inspection',
              title: 'Dummy Child',
              status: 'done',
              children: [],
              events: [
                {
                  id: 'evt-3',
                  taskId: 'task-demo-control-tower',
                  runId: 'run-demo-dummy-child',
                  timestampMs: 1_700_000_001_500,
                  kind: 'session',
                  eventType: 'session.init',
                  title: 'Dummy Child Initialized',
                  detail: 'Child worker started under Codex root',
                  status: 'ready',
                  payloadJson: '{"agent":"dummy"}',
                  createdAt: '2026-05-17T00:00:01Z',
                },
                {
                  id: 'evt-4',
                  taskId: 'task-demo-control-tower',
                  runId: 'run-demo-dummy-child',
                  timestampMs: 1_700_000_002_500,
                  kind: 'tool',
                  eventType: 'tool.exec',
                  title: 'InspectAST: component graph',
                  detail: 'Analyzed component hierarchy',
                  status: 'done',
                  payloadJson: '{"tool":"InspectAST"}',
                  createdAt: '2026-05-17T00:00:02Z',
                },
                {
                  id: 'evt-5',
                  taskId: 'task-demo-control-tower',
                  runId: 'run-demo-dummy-child',
                  timestampMs: 1_700_000_003_500,
                  kind: 'session',
                  eventType: 'session.complete',
                  title: 'Dummy Child Complete',
                  detail: 'Finished sub-routine analysis',
                  status: 'done',
                  payloadJson: '{"result":"success"}',
                  createdAt: '2026-05-17T00:00:03Z',
                },
              ],
              createdAt: '2026-05-17T00:00:00Z',
            },
          ],
          events: [
            {
              id: 'evt-1',
              taskId: 'task-demo-control-tower',
              runId: 'run-demo-codex-root',
              timestampMs: 1_700_000_000_000,
              kind: 'session',
              eventType: 'session.init',
              title: 'Codex Session Initialized',
              detail: 'Root orchestration run started',
              status: 'ready',
              payloadJson: '{"role":"orchestrator"}',
              createdAt: '2026-05-17T00:00:00Z',
            },
            {
              id: 'evt-2',
              taskId: 'task-demo-control-tower',
              runId: 'run-demo-codex-root',
              timestampMs: 1_700_000_001_000,
              kind: 'subagent',
              eventType: 'subagent.dispatch',
              title: 'Dispatch Dummy Child',
              detail: 'Dispatched nested Dummy Child worker',
              status: 'processing',
              payloadJson: '{"target":"run-demo-dummy-child"}',
              createdAt: '2026-05-17T00:00:01Z',
            },
            {
              id: 'evt-6',
              taskId: 'task-demo-control-tower',
              runId: 'run-demo-codex-root',
              timestampMs: 1_700_000_004_000,
              kind: 'subagent',
              eventType: 'subagent.complete',
              title: 'Dummy Child Completed',
              detail: 'Dummy Child returned verification result',
              status: 'done',
              payloadJson: '{"status":"success"}',
              createdAt: '2026-05-17T00:00:04Z',
            },
            {
              id: 'evt-7',
              taskId: 'task-demo-control-tower',
              runId: 'run-demo-codex-root',
              timestampMs: 1_700_000_005_000,
              kind: 'session',
              eventType: 'session.complete',
              title: 'Codex Root Run Complete',
              detail: 'Finished orchestrating all workspace tasks',
              status: 'done',
              payloadJson: '{"status":"success"}',
              createdAt: '2026-05-17T00:00:05Z',
            },
          ],
          createdAt: '2026-05-17T00:00:00Z',
        },
      ],
      createdAt: '2026-05-17T00:00:00Z',
    }

    monitorMocks.getTaskTraces.mockResolvedValue([persistedTask])

    render(<AgentMonitorSection />)

    await waitFor(() => expect(screen.getAllByText('Codex Root Run').length).toBeGreaterThan(0))
    expect(screen.getByText('Dummy Child')).toBeInTheDocument()
    expect(screen.getByText(/control-tower/)).toBeInTheDocument()
    expect(screen.getByText(/trace-codex-orchestration-001/)).toBeInTheDocument()
    expect(screen.getByText('session-codex-root')).toBeInTheDocument()

    // Verify root run ordered events rendered in timeline
    await waitFor(() => expect(screen.getByText('Codex Session Initialized')).toBeInTheDocument())
    expect(screen.getByText('Dispatch Dummy Child')).toBeInTheDocument()
    expect(screen.getByText('Dummy Child Completed')).toBeInTheDocument()
    expect(screen.getByText('Codex Root Run Complete')).toBeInTheDocument()

    // Click nested Dummy Child and verify its ordered events
    fireEvent.click(screen.getByText('Dummy Child'))
    await waitFor(() => expect(screen.getByText('Dummy Child Initialized')).toBeInTheDocument())
    expect(screen.getByText('InspectAST: component graph')).toBeInTheDocument()
    expect(screen.getByText('Dummy Child Complete')).toBeInTheDocument()
    expect(screen.getByText('session-dummy-child')).toBeInTheDocument()
  })
})
