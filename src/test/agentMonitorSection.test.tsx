import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMonitorSection } from '../components/settings/sections/AgentMonitorSection'
import type { MonitorSessionSummary } from '../services/monitorApi'
import type { RateLimitInfo, SessionState } from '../types/agent'
import { useSessionStore } from '../stores/sessionStore'
import { useSettingsToast } from '../stores/settingsToastStore'

const monitorMocks = vi.hoisted(() => ({
  getMonitorSessions: vi.fn(),
  jumpToTerminal: vi.fn(() => Promise.resolve()),
}))

vi.mock('../services/monitorApi', () => ({
  getMonitorSessions: monitorMocks.getMonitorSessions,
}))

vi.mock('../services/tauriApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/tauriApi')>(),
  jumpToTerminal: monitorMocks.jumpToTerminal,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; name?: string; count?: number; time?: string }) => {
      const value = options?.defaultValue ?? key
      return value
        .replace('{{name}}', options?.name ?? '')
        .replace('{{count}}', String(options?.count ?? ''))
        .replace('{{time}}', options?.time ?? '')
    },
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
  duration: 227,
  tokenTotal: 4200,
  lastToolName: 'Edit',
  lastToolTarget: 'src/App.tsx',
  lastToolStatus: 'running',
  subagentCount: 1,
  activeToolCount: 1,
  title: 'agentbro · monitor',
}

function liveSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: 'live-1',
    agentType: 'codex',
    project: 'vibe-board',
    terminal: 'Codex',
    phase: 'waiting_input',
    startedAt: Date.now(),
    duration: 0,
    tokens: { input: 100, output: 0, cacheRead: 0, cacheCreate: 0 },
    chatHistory: [],
    subagents: [],
    activeTools: [
      { toolUseId: 't1', toolName: 'Read', status: 'running', startedAt: 2 },
      { toolUseId: 't2', toolName: 'Bash', status: 'success', startedAt: 1 },
    ],
    sessionTitle: '修好看板',
    runState: {
      agent: 'codex',
      sessionId: 'live-1',
      status: 'waiting_input',
      phase: 'waiting_input',
      currentAction: '价格表缺 o4-mini，要跳过还是补上？',
      updatedAt: new Date().toISOString(),
    },
    ...overrides,
  }
}

function lowQuota(): Record<string, RateLimitInfo> {
  return {
    codex: {
      provider: 'codex',
      providerLabel: 'Codex',
      fiveHourUsage: 90,
      fiveHourRemaining: '1h',
      sevenDayUsage: 0,
      sevenDayRemaining: '6d',
      windows: [{ id: 'five_hour', title: '5h', usedPercent: 90 }],
    },
  }
}

describe('AgentMonitorSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSessionStore.setState({ sessions: {}, sessionList: [], activeSessionId: null, usageSnapshots: {} })
    useSettingsToast.setState({ text: '', visible: false })
    monitorMocks.getMonitorSessions.mockResolvedValue([summary])
  })

  it('draws one lane per active session and names the Agent that is waiting', async () => {
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
    expect(screen.getByText('2 个 Agent 在干活')).toBeInTheDocument()
    expect(screen.getByText('Claude 在等你回答。')).toBeInTheDocument()
  })

  it('shows the token count on each lane and keeps the raw session id out of view', async () => {
    render(<AgentMonitorSection />)

    await waitFor(() => expect(screen.getByTestId('live-task-list')).toBeInTheDocument())
    expect(screen.getByTestId('live-task-session-1')).toHaveTextContent('4.2K')
    expect(screen.queryByText('session-1')).not.toBeInTheDocument()
  })

  it('highlights the waiting lane and shows its question with recent activity', async () => {
    useSessionStore.setState({ sessionList: [liveSession()], sessions: { 'live-1': liveSession() } })
    monitorMocks.getMonitorSessions.mockResolvedValue([])

    render(<AgentMonitorSection />)

    const lane = await screen.findByTestId('live-task-live-1')
    expect(lane).toHaveClass('agent-monitor__lane--wait')
    expect(lane).toHaveTextContent('价格表缺 o4-mini，要跳过还是补上？')
    expect(lane).toHaveTextContent('Read')
    expect(lane).toHaveTextContent('修好看板')
  })

  it('recalls the terminal and reports the result with the island toast', async () => {
    render(<AgentMonitorSection />)

    const lane = await screen.findByTestId('live-task-session-1')
    fireEvent.click(lane)

    await waitFor(() => expect(monitorMocks.jumpToTerminal).toHaveBeenCalledWith('session-1'))
    expect(useSettingsToast.getState().text).toBe('已切到 Claude 所在的终端')
  })

  it('shows the empty state when no Agent is running', async () => {
    monitorMocks.getMonitorSessions.mockResolvedValue([])

    render(<AgentMonitorSection />)

    expect(await screen.findByText('灵动岛正在待命')).toBeInTheDocument()
  })

  it('shows the read-failure notice when sessions cannot be loaded', async () => {
    monitorMocks.getMonitorSessions.mockRejectedValue(new Error('boom'))

    render(<AgentMonitorSection />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('会话没能读取成功')
    expect(alert).toHaveTextContent('重试')

    fireEvent.click(within(alert).getByTestId('tasks-error-details'))
    expect(within(alert).getByTestId('tasks-error-details-body')).toHaveTextContent('boom')
  })

  it('warns below 25% of quota and jumps to the quota page', async () => {
    const onOpenUsage = vi.fn()
    useSessionStore.setState({ usageSnapshots: lowQuota() })

    render(<AgentMonitorSection onOpenUsage={onOpenUsage} />)

    await waitFor(() => expect(screen.getByTestId('live-task-list')).toBeInTheDocument())
    expect(screen.getByText('Codex 额度只剩')).toBeInTheDocument()
    expect(screen.getByText('10%')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '看额度' }))
    expect(onOpenUsage).toHaveBeenCalledTimes(1)
  })

  it('does not render the removed task trace block', async () => {
    const { container } = render(<AgentMonitorSection />)

    await waitFor(() => expect(screen.getByTestId('live-task-list')).toBeInTheDocument())
    expect(screen.queryByText('持久化 Task Trace')).not.toBeInTheDocument()
    expect(screen.queryByText('Task Tree')).not.toBeInTheDocument()
    expect(screen.queryByText('Task status')).not.toBeInTheDocument()
    expect(container.querySelector('.agent-monitor__layout')).toBeNull()
  })
})
