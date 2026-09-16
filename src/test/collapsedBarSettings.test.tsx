import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CollapsedBar } from '../components/notch/CollapsedBar'
import type { SessionState } from '../types/agent'

const tauriMocks = vi.hoisted(() => ({
  openSettingsWindow: vi.fn(() => Promise.resolve()),
  setSoundEnabled: vi.fn(() => Promise.resolve()),
}))

vi.mock('../services/tauriApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tauriApi')>()
  return {
    ...actual,
    openSettingsWindow: tauriMocks.openSettingsWindow,
    setSoundEnabled: tauriMocks.setSoundEnabled,
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => {
      const translations: Record<string, string> = {
        'notch.needsApproval': 'Needs approval',
        'notch.waitingInput': 'Waiting for input',
        'notch.tool.writing': 'Writing',
      }
      return translations[key] ?? options?.defaultValue ?? key
    },
  }),
}))

function session(overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: 's1',
    agentType: 'codex',
    project: 'agentbro',
    terminal: 'Terminal',
    phase: 'processing',
    startedAt: Date.now() - 10_000,
    duration: 10_000,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    chatHistory: [],
    subagents: [],
    activeTools: [],
    ...overrides,
  }
}

describe('collapsed bar settings button', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tauriMocks.openSettingsWindow.mockResolvedValue(undefined)
  })

  it('collapses the island before opening native settings from the expanded header gear', async () => {
    const onCollapse = vi.fn()
    const { container } = render(
      <CollapsedBar sessions={[]} panelState="expanded" onCollapse={onCollapse} />,
    )

    const settingsButton = container.querySelector<HTMLButtonElement>(
      '.collapsed-bar__status-row button[title="notch.settings"]',
    )
    expect(settingsButton).toBeInTheDocument()

    fireEvent.click(settingsButton!)

    expect(onCollapse).toHaveBeenCalledOnce()
    await waitFor(() => expect(tauriMocks.openSettingsWindow).toHaveBeenCalledTimes(1))
  })

  it('shows only the executing Agent name in the collapsed island without quota, counters, or gear', () => {
    const { container } = render(
      <CollapsedBar sessions={[session()]} panelState="collapsed" onCollapse={vi.fn()} />,
    )

    expect(container.querySelector('.collapsed-bar__agent-name')).toHaveTextContent('Codex')
    expect(container.querySelector('.collapsed-bar__icon-btn')).toBeNull()
    expect(container.querySelector('.collapsed-bar__counter-pill')).toBeNull()
    expect(container.querySelector('.collapsed-bar__status-row')).toBeNull()
  })

  it('keeps the collapsed island as icon-only when no session is executing', () => {
    const { container } = render(
      <CollapsedBar sessions={[]} panelState="collapsed" onCollapse={vi.fn()} />,
    )

    expect(container.querySelector('.collapsed-bar__agent-name')).toBeNull()
    expect(screen.getByLabelText('Vibe Board')).toBeInTheDocument()
    expect(container.querySelector('.collapsed-bar__icon-btn')).toBeNull()
  })

  it('omits waiting details and collapsed gear in the collapsed island when waiting for approval', () => {
    const { container } = render(
      <CollapsedBar
        sessions={[session({
          phase: 'waiting_approval',
          pendingPermission: {
            toolName: 'Write',
            toolInput: JSON.stringify({ file_path: '/Users/demo/project/src/auth.ts' }),
          },
        })]}
        panelState="collapsed"
        onCollapse={vi.fn()}
      />,
    )

    expect(screen.queryByText('agentbro')).not.toBeInTheDocument()
    expect(screen.queryByText('Needs approval: Writing')).not.toBeInTheDocument()
    expect(screen.queryByText('auth.ts')).not.toBeInTheDocument()
    expect(container.querySelector('.collapsed-bar__icon-btn')).toBeNull()
    expect(screen.getByLabelText('Vibe Board')).toBeInTheDocument()
  })

  it('omits waiting details and collapsed gear in the collapsed island when waiting for input', () => {
    const { container } = render(
      <CollapsedBar
        sessions={[session({
          phase: 'waiting_input',
          pendingQuestion: {
            question: 'Which implementation should I use?',
            options: ['A', 'B'],
          },
        })]}
        panelState="collapsed"
        onCollapse={vi.fn()}
      />,
    )

    expect(screen.queryByText('agentbro')).not.toBeInTheDocument()
    expect(screen.queryByText('Waiting for input')).not.toBeInTheDocument()
    expect(screen.queryByText('Which implementation should I use?')).not.toBeInTheDocument()
    expect(container.querySelector('.collapsed-bar__icon-btn')).toBeNull()
    expect(screen.getByLabelText('Vibe Board')).toBeInTheDocument()
  })
})
