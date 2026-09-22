import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMonitorSection } from '../components/settings/sections/AgentMonitorSection'
import type { MonitorSessionSummary } from '../services/monitorApi'
import { useSessionStore } from '../stores/sessionStore'

const monitorMocks = vi.hoisted(() => ({
  getMonitorSessions: vi.fn(),
}))

vi.mock('../services/monitorApi', () => ({
  getMonitorSessions: monitorMocks.getMonitorSessions,
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
  })

  it('shows every active agent session from the live task list', async () => {
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
    expect(screen.getByText('每个 Agent 的会话单独显示；一个会话里的子任务不会重复计数。')).toBeInTheDocument()
  })

  it('keeps session ids and token counts out of the default view', async () => {
    render(<AgentMonitorSection />)

    await waitFor(() => expect(screen.getByTestId('live-task-list')).toBeInTheDocument())
    expect(screen.queryByText('session-1')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('live-task-details-session-1'))

    expect(screen.getByTestId('live-task-details-session-1-body')).toHaveTextContent('session-1')
  })

  it('does not render the removed task trace block', async () => {
    monitorMocks.getMonitorSessions.mockResolvedValue([summary])

    const { container } = render(<AgentMonitorSection />)

    await waitFor(() => expect(screen.getByTestId('live-task-list')).toBeInTheDocument())
    expect(screen.queryByText('持久化 Task Trace')).not.toBeInTheDocument()
    expect(screen.queryByText('Task Tree')).not.toBeInTheDocument()
    expect(screen.queryByText('Task status')).not.toBeInTheDocument()
    expect(container.querySelector('.agent-monitor__layout')).toBeNull()
  })
})
