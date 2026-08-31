import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsApp } from '../components/settings'
import { AgentMonitorSection } from '../components/settings/sections/AgentMonitorSection'
import type { MonitorSessionDetail, MonitorSessionSummary } from '../services/monitorApi'
import { useSessionStore } from '../stores/sessionStore'

const monitorMocks = vi.hoisted(() => ({
  getMonitorSessions: vi.fn(),
  getMonitorSessionDetail: vi.fn(),
  getMonitorTimeline: vi.fn(),
  getNetworkMonitorStatus: vi.fn(),
  getClaudeWrapperStatus: vi.fn(),
  installClaudeWrapper: vi.fn(),
  removeClaudeWrapper: vi.fn(),
  setNetworkMonitorEnabled: vi.fn(),
  getNetworkMonitorRequests: vi.fn(),
  getNetworkMonitorRequestDetail: vi.fn(),
  createDemoTaskTrace: vi.fn(),
  getTaskTraces: vi.fn(),
  getTaskTraceDetail: vi.fn(),
}))

const tauriMocks = vi.hoisted(() => ({
  getChatHistoryTail: vi.fn(),
  jumpToTerminal: vi.fn(() => Promise.resolve()),
  openSystemPath: vi.fn(() => Promise.resolve()),
}))

vi.mock('../services/monitorApi', () => ({
  getMonitorSessions: monitorMocks.getMonitorSessions,
  getMonitorSessionDetail: monitorMocks.getMonitorSessionDetail,
  getMonitorTimeline: monitorMocks.getMonitorTimeline,
  getNetworkMonitorStatus: monitorMocks.getNetworkMonitorStatus,
  getClaudeWrapperStatus: monitorMocks.getClaudeWrapperStatus,
  installClaudeWrapper: monitorMocks.installClaudeWrapper,
  removeClaudeWrapper: monitorMocks.removeClaudeWrapper,
  setNetworkMonitorEnabled: monitorMocks.setNetworkMonitorEnabled,
  getNetworkMonitorRequests: monitorMocks.getNetworkMonitorRequests,
  getNetworkMonitorRequestDetail: monitorMocks.getNetworkMonitorRequestDetail,
  createDemoTaskTrace: monitorMocks.createDemoTaskTrace,
  getTaskTraces: monitorMocks.getTaskTraces,
  getTaskTraceDetail: monitorMocks.getTaskTraceDetail,
}))

vi.mock('../services/tauriApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tauriApi')>()
  return {
    ...actual,
    getChatHistoryTail: tauriMocks.getChatHistoryTail,
    jumpToTerminal: tauriMocks.jumpToTerminal,
    openSystemPath: tauriMocks.openSystemPath,
  }
})

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
  phase: 'waiting_approval',
  startedAt: 1_700_000_000,
  duration: 125,
  tokenTotal: 4200,
  lastToolName: 'Edit',
  lastToolTarget: 'src/App.tsx',
  lastToolStatus: 'running',
  waitingUser: true,
  pendingKind: 'permission',
  subagentCount: 1,
  activeToolCount: 1,
  title: 'agentbro · monitor',
}

const detail = {
  session: {
    id: 'session-1',
    agentType: 'claude-code',
    engineLabel: null,
    engineConfigRoot: null,
    project: 'agentbro',
    cwd: '/Users/me/code/agentbro',
    terminal: 'iTerm',
    termProgram: null,
    phase: 'waiting_approval',
    startedAt: 1_700_000_000,
    duration: 125,
    tokens: { input: 2000, output: 1200, cacheRead: 900, cacheCreate: 100 },
    rateLimits: { fiveHourUsage: 23, fiveHourRemaining: '4h', sevenDayUsage: 12, sevenDayRemaining: '6d' },
    statusLineText: null,
    contextWindow: { totalInputTokens: 2000, totalOutputTokens: 1200, contextWindowSize: 200000, usedPercentage: 2 },
    lastMainAgentAt: null,
    cacheTtlMs: null,
    pendingPermission: { toolName: 'Edit', toolInput: '{"file":"src/App.tsx"}', diff: null, options: null },
    pendingQuestion: null,
    pendingPlan: null,
    lastToolName: 'Edit',
    lastToolTarget: 'src/App.tsx',
    lastToolStatus: 'running',
    description: null,
    sessionTitle: 'agentbro · monitor',
    pid: 1234,
    tty: '/dev/ttys001',
    termBundleId: null,
    weztermPane: null,
    zellijPaneId: null,
    zellijSessionName: null,
    cmuxSurfaceId: null,
    cmuxWorkspaceId: null,
    subagents: [{
      agentId: 'sub-1',
      name: null,
      agentType: 'explorer',
      description: 'Inspect monitor wiring',
      transcriptPath: null,
      agentTranscriptPath: null,
      lastAssistantMessage: null,
      startedAt: 1_700_000_030,
      completedAt: null,
      status: 'running',
      tools: ['Read'],
    }],
    activeTools: [{
      toolUseId: 'tool-1',
      toolName: 'Edit',
      status: 'running',
      startedAt: 1_700_000_050,
      completedAt: null,
      error: null,
    }],
    tasks: [],
    isYoloMode: false,
    model: null,
    lastUserMessage: null,
    lastResponse: null,
    lastThought: null,
  },
  timeline: [{
    id: 'tool:session-1:tool-1',
    timestampMs: 1_700_000_050_000,
    kind: 'tool',
    title: 'Edit',
    detail: 'running',
    status: 'running',
    toolName: 'Edit',
    rawEventSeq: null,
  }],
  rawEvents: [{
    seq: 7,
    timestampMs: 1_700_000_051_000,
    sessionId: 'session-1',
    agent: 'claude-code',
    eventName: 'PreToolUse',
    raw: { event: 'PreToolUse', session_id: 'session-1', tool_name: 'Edit' },
  }],
  transcriptPath: '/Users/me/.claude/projects/agentbro/session-1.jsonl',
} as MonitorSessionDetail

describe('AgentMonitorSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSessionStore.setState({ sessions: {}, sessionList: [], activeSessionId: null })
    monitorMocks.getMonitorSessions.mockResolvedValue([summary])
    monitorMocks.getMonitorSessionDetail.mockResolvedValue(detail)
    monitorMocks.getMonitorTimeline.mockResolvedValue(detail.timeline)
    monitorMocks.getNetworkMonitorStatus.mockResolvedValue({
      enabled: false,
      proxyUrl: null,
      upstreamBaseUrl: 'https://api.anthropic.com',
      requestCount: 0,
      activeRequestCount: 0,
    })
    monitorMocks.getClaudeWrapperStatus.mockResolvedValue({
      installed: false,
      shimPath: '/Users/me/.agentbro/bin/claude',
      pathHintInstalled: false,
      shellConfigPath: '/Users/me/.zshrc',
    })
    monitorMocks.installClaudeWrapper.mockResolvedValue({
      installed: true,
      shimPath: '/Users/me/.agentbro/bin/claude',
      pathHintInstalled: true,
      shellConfigPath: '/Users/me/.zshrc',
    })
    monitorMocks.removeClaudeWrapper.mockResolvedValue({
      installed: false,
      shimPath: '/Users/me/.agentbro/bin/claude',
      pathHintInstalled: false,
      shellConfigPath: '/Users/me/.zshrc',
    })
    monitorMocks.setNetworkMonitorEnabled.mockResolvedValue({
      enabled: false,
      proxyUrl: null,
      upstreamBaseUrl: 'https://api.anthropic.com',
      requestCount: 0,
      activeRequestCount: 0,
    })
    monitorMocks.getNetworkMonitorRequests.mockResolvedValue([])
    monitorMocks.getNetworkMonitorRequestDetail.mockResolvedValue(null)
    monitorMocks.getTaskTraces.mockResolvedValue([])
    tauriMocks.getChatHistoryTail.mockResolvedValue({
      messages: [
        {
          id: 'msg-1',
          role: 'user',
          timestamp: '2026-05-17T00:00:00Z',
          blocks: [{ type: 'text', text: '请检查监控模块' }],
        },
      ],
      hasMore: false,
      firstMessageId: 'msg-1',
      totalCount: 1,
      transcriptPath: '/Users/me/.claude/projects/agentbro/session-1.jsonl',
    })
  })

  it('shows monitor sessions and loads detail tabs', async () => {
    render(<AgentMonitorSection />)

    await waitFor(() => expect(screen.getAllByText('agentbro · monitor').length).toBeGreaterThan(0))
    expect(screen.getAllByText('Edit').length).toBeGreaterThan(0)
    expect(screen.getByText('权限')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: '打开 JSON' })).toBeEnabled())

    fireEvent.click(screen.getByRole('button', { name: '打开 JSON' }))
    await waitFor(() => expect(tauriMocks.openSystemPath).toHaveBeenCalledWith('/Users/me/.claude/projects/agentbro/session-1.jsonl'))

    fireEvent.click(screen.getByRole('button', { name: '打开目录' }))
    await waitFor(() => expect(tauriMocks.openSystemPath).toHaveBeenCalledWith('/Users/me/.claude/projects/agentbro'))

    fireEvent.click(screen.getByRole('button', { name: '工具时间线' }))
    await waitFor(() => expect(screen.getAllByText('running').length).toBeGreaterThan(0))

    fireEvent.click(screen.getByRole('button', { name: '对话' }))
    await waitFor(() => expect(screen.getByText('请检查监控模块')).toBeInTheDocument())
    expect(tauriMocks.getChatHistoryTail).toHaveBeenCalledWith('session-1', { limit: 200 })

    fireEvent.click(screen.getByRole('button', { name: 'Raw 事件' }))
    await waitFor(() => expect(screen.getByText('PreToolUse')).toBeInTheDocument())
  })

  it('keeps native request monitoring off by default until manually enabled', async () => {
    monitorMocks.setNetworkMonitorEnabled.mockResolvedValue({
      enabled: true,
      proxyUrl: 'http://127.0.0.1:4567',
      upstreamBaseUrl: 'https://api.anthropic.com',
      requestCount: 0,
      activeRequestCount: 0,
    })

    render(<AgentMonitorSection activeView="access" />)

    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false'))
    expect(screen.getByText('关闭')).toBeInTheDocument()
    expect(screen.getByText('Claude 命令无感接入')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(monitorMocks.setNetworkMonitorEnabled).toHaveBeenCalledWith(true, 'https://api.anthropic.com'))
    expect(await screen.findByText('已开启')).toBeInTheDocument()
    expect(screen.getByText('ANTHROPIC_BASE_URL=http://127.0.0.1:4567 claude')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '安装接入' }))
    await waitFor(() => expect(monitorMocks.installClaudeWrapper).toHaveBeenCalled())
    expect(await screen.findByText('移除接入')).toBeInTheDocument()
  })

  it('renders classified network request detail tabs', async () => {
    monitorMocks.getNetworkMonitorStatus.mockResolvedValue({
      enabled: true,
      proxyUrl: 'http://127.0.0.1:4567',
      upstreamBaseUrl: 'https://api.anthropic.com',
      requestCount: 1,
      activeRequestCount: 0,
    })
    monitorMocks.getNetworkMonitorRequests.mockResolvedValue([{
      id: 'req-1',
      timestampMs: 1_700_000_052_000,
      provider: 'anthropic',
      method: 'POST',
      url: '/v1/messages',
      upstreamUrl: 'https://api.anthropic.com/v1/messages',
      sessionId: null,
      project: null,
      model: 'claude-sonnet-4',
      status: 200,
      durationMs: 321,
      requestBytes: 1234,
      responseBytes: 2345,
      isStream: true,
      mainAgent: true,
      requestType: 'MainAgent',
      requestSubType: null,
      messageCount: 2,
      toolCount: 1,
      systemPreview: 'You are Claude Code.',
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 40,
      },
      usageSummary: {
        inputTokens: 100,
        outputTokens: 20,
        cacheCreationInputTokens: 10,
        cacheReadInputTokens: 40,
        totalTokens: 170,
        cacheHitRate: 80,
      },
      error: null,
      inProgress: false,
    }])
    monitorMocks.getNetworkMonitorRequestDetail.mockResolvedValue({
      summary: {
        id: 'req-1',
        timestampMs: 1_700_000_052_000,
        provider: 'anthropic',
        method: 'POST',
        url: '/v1/messages',
        upstreamUrl: 'https://api.anthropic.com/v1/messages',
        sessionId: null,
        project: null,
        model: 'claude-sonnet-4',
        status: 200,
        durationMs: 321,
        requestBytes: 1234,
        responseBytes: 2345,
        isStream: true,
        mainAgent: true,
        requestType: 'MainAgent',
        requestSubType: null,
        messageCount: 2,
        toolCount: 1,
        systemPreview: 'You are Claude Code.',
        usage: null,
        usageSummary: null,
        error: null,
        inProgress: false,
      },
      requestHeaders: { authorization: '****' },
      requestBody: {
        model: 'claude-sonnet-4',
        system: [{ type: 'text', text: 'You are Claude Code.' }],
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'Edit', description: 'edit files' }],
      },
      responseHeaders: { 'content-type': 'text/event-stream' },
      responseBody: 'data: {"type":"message_delta","usage":{"output_tokens":20}}\n',
      responseBodyTruncated: false,
      streamEventCount: 1,
    })

    render(<AgentMonitorSection activeView="capture" />)

    await waitFor(() => expect(screen.getByText('已开启')).toBeInTheDocument())
    await waitFor(() => expect(screen.getAllByText('MainAgent').length).toBeGreaterThan(0))
    expect(await screen.findByText('cache read 40')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Tools' }))
    await waitFor(() => expect(screen.getAllByText('Edit').length).toBeGreaterThan(0))

    fireEvent.click(screen.getByRole('button', { name: 'Response' }))
    expect(await screen.findByText('event #1')).toBeInTheDocument()
  })

  it('keeps unfinished modules out of the settings menu', async () => {
    monitorMocks.getMonitorSessions.mockResolvedValue([])
    monitorMocks.getMonitorSessionDetail.mockResolvedValue(null)

    render(<SettingsApp onClose={vi.fn()} />)

    expect(screen.queryByText('settings.agents')).not.toBeInTheDocument()
    expect(screen.queryByText('settings.agentMonitor')).not.toBeInTheDocument()
    expect(screen.queryByText('settings.switch')).not.toBeInTheDocument()
  })

  it('creates demo task trace and displays Codex root run with nested Dummy Child and ordered events', async () => {
    const demoTask = {
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

    monitorMocks.getTaskTraces.mockResolvedValue([demoTask])
    monitorMocks.createDemoTaskTrace.mockImplementation(async () => {
      monitorMocks.getTaskTraces.mockResolvedValue([demoTask])
      return demoTask
    })

    render(<AgentMonitorSection activeView="tasks" />)

    const createBtn = screen.getByTestId('create-demo-task-trace-btn')
    expect(createBtn).toBeInTheDocument()

    fireEvent.click(createBtn)

    await waitFor(() => expect(monitorMocks.createDemoTaskTrace).toHaveBeenCalled())
    await waitFor(() => expect(screen.getAllByText('Codex Root Run').length).toBeGreaterThan(0))
    expect(screen.getByText('Demo Task Trace 已创建：包含 Codex 根任务与嵌套的 Dummy Child 子任务。')).toBeInTheDocument()
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
