import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskBoard } from '../components/notch/TaskBoard'
import type { SessionState } from '../types/agent'

const activateSessionHost = vi.hoisted(() => vi.fn(() => Promise.resolve(true)))

vi.mock('../services/tauriApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/tauriApi')>(),
  activateSessionHost,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'notch.manualOpenCli': '请手动打开 CLI 查看执行进度',
      'notch.activateAgentFailed': '无法唤起 Agent，请手动查看执行进度',
      'notch.working': '工作中...',
      'notch.slogan': 'Vibe Coding看板',
    })[key] ?? key,
  }),
}))

function session(overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: 's1',
    agentType: 'codex',
    project: 'vibe-board',
    terminal: 'Codex',
    phase: 'processing',
    startedAt: Date.now(),
    duration: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    chatHistory: [],
    subagents: [],
    activeTools: [],
    sessionTitle: '修复同步任务状态',
    responseText: '这段模型回复不应出现在看板里',
    ...overrides,
  }
}

describe('TaskBoard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    activateSessionHost.mockResolvedValue(true)
  })

  it('shows every active Agent as a title-only task and activates its host', async () => {
    render(
      <TaskBoard
        sessions={[
          session(),
          session({ id: 's2', agentType: 'antigravity', sessionTitle: '整理额度显示' }),
        ]}
        statuses={{}}
        usageSnapshots={{}}
      />,
    )

    expect(screen.getByText('修复同步任务状态')).toBeInTheDocument()
    expect(screen.getByText('整理额度显示')).toBeInTheDocument()
    expect(screen.queryByText('这段模型回复不应出现在看板里')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('修复同步任务状态'))
    await waitFor(() => expect(activateSessionHost).toHaveBeenCalledWith('s1'))
  })

  it('tells CLI-only users to open their CLI manually', async () => {
    activateSessionHost.mockResolvedValue(false)
    render(<TaskBoard sessions={[session({ terminal: 'Windows Terminal' })]} statuses={{}} usageSnapshots={{}} />)

    fireEvent.click(screen.getByText('修复同步任务状态'))

    expect(await screen.findByRole('status')).toHaveTextContent('请手动打开 CLI 查看执行进度')
  })

  it('shows detected Agents and keeps Antigravity quota groups on separate lines', () => {
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }
    const { container } = render(
      <TaskBoard
        sessions={[]}
        statuses={{
          antigravity: { agent: 'antigravity', label: 'Antigravity', online: true, lastSeenAt: 1, tokens },
          custom: { agent: 'custom', label: 'Custom Agent', online: false, lastSeenAt: 1, tokens },
        }}
        usageSnapshots={{
          antigravity: {
            provider: 'antigravity',
            fiveHourUsage: 0,
            fiveHourRemaining: '',
            sevenDayUsage: 0,
            sevenDayRemaining: '',
            windows: [
              { id: 'gemini-5h', title: 'Gemini 5h', usedPercent: 20 },
              { id: 'office-5h', title: 'Claude/GPT 5h', usedPercent: 30 },
            ],
          },
        }}
      />,
    )

    expect(screen.getByText('Custom Agent')).toBeInTheDocument()
    expect(container.querySelectorAll('.agent-presence-strip__quota-line')).toHaveLength(2)
  })
})
