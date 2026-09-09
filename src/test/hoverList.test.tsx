import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HoverList } from '../components/notch/HoverList'
import { useConfigStore } from '../stores/configStore'
import { useSessionStore } from '../stores/sessionStore'
import type { SessionState } from '../types/agent'

const tauriMocks = vi.hoisted(() => ({
  respondAutoApprove: vi.fn(() => Promise.resolve()),
  respondPermission: vi.fn(() => Promise.resolve()),
  respondPlan: vi.fn(() => Promise.resolve()),
  respondQuestion: vi.fn(() => Promise.resolve()),
}))

vi.mock('../services/tauriApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tauriApi')>()
  return {
    ...actual,
    respondAutoApprove: tauriMocks.respondAutoApprove,
    respondPermission: tauriMocks.respondPermission,
    respondPlan: tauriMocks.respondPlan,
    respondQuestion: tauriMocks.respondQuestion,
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | { defaultValue?: string }) => {
      const translations: Record<string, string> = {
        'notch.tool.compactingContext': '压缩上下文',
      }
      if (translations[key]) return translations[key]
      if (typeof fallback === 'string') return fallback
      return fallback?.defaultValue ?? key
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
    sessionTitle: 'Fix island interactions',
    lastUserMessage: 'Please fix the island',
    pid: 1234,
    ...overrides,
  }
}

describe('HoverList interactions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSessionStore.setState({ activeOverlay: null })
    useConfigStore.setState({ hoverSpeed: 'instant', maxVisibleSessions: 5, showCacheTTL: false })
  })

  it('opens session detail from the session row', () => {
    const onSessionClick = vi.fn()
    render(<HoverList sessions={[session()]} onSessionClick={onSessionClick} />)

    fireEvent.click(screen.getByText('agentbro · Fix island interactions'))

    expect(onSessionClick).toHaveBeenCalledWith('s1')
  })

  it('falls back to the real prompt when a Codex title is environment context', () => {
    render(
      <HoverList
        sessions={[session({
          sessionTitle: '<environment_context>\n  <cwd>/tmp/agentbro</cwd>\n</environment_context>',
          lastUserMessage: 'Build Vibe Board landing page',
        })]}
        onSessionClick={vi.fn()}
      />,
    )

    expect(screen.getByText('agentbro · Build Vibe Board landing page')).toBeInTheDocument()
    expect(screen.queryByText(/environment_context/)).not.toBeInTheDocument()
  })

  it('keeps Unknown project labels when the backend cannot infer a project', () => {
    render(
      <HoverList
        sessions={[session({
          project: 'Unknown',
          sessionTitle: '@skill:expert-manager 帮我创建一个内容创作专家',
          lastUserMessage: '@skill:expert-manager 帮我创建一个内容创作专家',
        })]}
        onSessionClick={vi.fn()}
      />,
    )

    expect(document.querySelector('.hover-list__session-title')).toHaveTextContent('Unknown · @skill:expert-manager 帮我创建一个内容创作专家')
  })

  it('opens session detail on mouse down so hover state cannot swallow the click', () => {
    const onSessionClick = vi.fn()
    render(<HoverList sessions={[session()]} onSessionClick={onSessionClick} />)

    fireEvent.mouseDown(screen.getByText('agentbro · Fix island interactions'), { button: 0 })

    expect(onSessionClick).toHaveBeenCalledWith('s1')
  })

  it('ignores right-click without opening the session', () => {
    const onSessionClick = vi.fn()
    render(<HoverList sessions={[session({ cwd: '/tmp/agentbro' })]} onSessionClick={onSessionClick} />)

    fireEvent.contextMenu(screen.getByText('agentbro · Fix island interactions'))

    expect(onSessionClick).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('renders only the conversation title for ordinary sessions', () => {
    const now = Date.now()
    render(
      <HoverList
        sessions={[session({
          lastUserMessage: 'Next task please',
          lastUserMessageAt: now,
          responseText: 'Detailed model response',
          lastToolName: 'Edit',
          lastToolTarget: 'src/App.tsx +1 -1',
          model: 'gpt-5.6',
          subagents: [{
            agentId: 'old-agent',
            name: 'old-work',
            agentType: 'explorer',
            description: 'Explore old task',
            startedAt: now - 8_000,
            completedAt: now - 5_000,
            status: 'completed',
            tools: [],
            lastAssistantMessage: 'Old work complete.',
          }],
        })]}
        onSessionClick={vi.fn()}
      />,
    )

    expect(screen.getByText('agentbro · Fix island interactions')).toBeInTheDocument()
    expect(screen.queryByText('Next task please')).not.toBeInTheDocument()
    expect(screen.queryByText('Detailed model response')).not.toBeInTheDocument()
    expect(screen.queryByText('gpt-5.6')).not.toBeInTheDocument()
    expect(screen.queryByText('src/App.tsx')).not.toBeInTheDocument()
    expect(screen.queryByText('Subagents (1)')).not.toBeInTheDocument()
    expect(screen.queryByText('@old-work')).not.toBeInTheDocument()
  })

  it('hides jump for recovered sessions without terminal metadata', () => {
    render(
      <HoverList
        sessions={[session({ terminal: '', pid: undefined, tty: undefined, termBundleId: undefined })]}
        onSessionClick={vi.fn()}
        onJumpToTerminal={vi.fn()}
      />,
    )

    expect(screen.queryByRole('button', { name: 'notch.jumpToTerminal' })).not.toBeInTheDocument()
  })

  it('uses a subdued dot for inactive sessions', () => {
    const { container } = render(
      <HoverList
        sessions={[session({
          phase: 'idle',
          idleSince: Date.now() - 60_000,
        })]}
        onSessionClick={vi.fn()}
      />,
    )

    expect(container.querySelector('.hover-list__expired-dot')).toBeInTheDocument()
    expect(container.querySelector('.mascot-image')).not.toBeInTheDocument()
  })

  it('keeps bare tty values out of the session list badges', () => {
    render(
      <HoverList
        sessions={[session({ terminal: '/dev/ttys001', termBundleId: undefined })]}
        onSessionClick={vi.fn()}
      />,
    )

    expect(screen.queryByText('/dev/ttys001')).not.toBeInTheDocument()
    expect(document.querySelector('.hover-list__terminal-badge')).not.toBeInTheDocument()
  })

  it('supports keyboard navigation and Enter jump like the island panel', () => {
    const onSessionClick = vi.fn()
    const onJumpToTerminal = vi.fn()
    render(
      <HoverList
        sessions={[
          session({ id: 's1', phase: 'idle', sessionTitle: 'Idle session' }),
          session({ id: 's2', phase: 'waiting_approval', sessionTitle: 'Approval needed' }),
          session({ id: 's3', phase: 'processing', sessionTitle: 'Working session' }),
        ]}
        onSessionClick={onSessionClick}
        onJumpToTerminal={onJumpToTerminal}
      />,
    )

    fireEvent.keyDown(window, { key: 'ArrowDown' })
    fireEvent.keyDown(window, { key: 'Enter' })

    expect(onJumpToTerminal).toHaveBeenCalledWith('s2')
    expect(onSessionClick).not.toHaveBeenCalled()
  })

  it('routes inline permission actions without opening the row', () => {
    const onSessionClick = vi.fn()
    render(
      <HoverList
        sessions={[session({
          agentType: 'claude-code',
          phase: 'waiting_approval',
          pendingPermission: { toolName: 'Bash', toolInput: 'pnpm test' },
        })]}
        onSessionClick={onSessionClick}
      />,
    )

    const permissionCard = document.querySelector('.hover-list__inline-perm') as HTMLElement
    fireEvent.click(within(permissionCard).getByRole('button', { name: '允许一次' }))
    fireEvent.click(within(permissionCard).getByRole('button', { name: /始终允许/ }))
    fireEvent.click(within(permissionCard).getByRole('button', { name: '自动批准' }))
    fireEvent.click(within(permissionCard).getByRole('button', { name: '拒绝' }))

    expect(tauriMocks.respondPermission).toHaveBeenNthCalledWith(1, 's1', true)
    expect(tauriMocks.respondPermission).toHaveBeenNthCalledWith(2, 's1', true, true)
    expect(tauriMocks.respondAutoApprove).toHaveBeenCalledWith('s1')
    expect(tauriMocks.respondPermission).toHaveBeenNthCalledWith(3, 's1', false)
    expect(onSessionClick).not.toHaveBeenCalled()
  })

  it('hides unsupported persistent permission actions for Codex hooks', () => {
    render(
      <HoverList
        sessions={[session({
          agentType: 'codex',
          phase: 'waiting_approval',
          pendingPermission: { toolName: 'Bash', toolInput: 'pnpm test' },
        })]}
        onSessionClick={vi.fn()}
      />,
    )

    const permissionCard = document.querySelector('.hover-list__inline-perm') as HTMLElement
    expect(within(permissionCard).getByRole('button', { name: '允许一次' })).toBeInTheDocument()
    expect(within(permissionCard).getByRole('button', { name: '拒绝' })).toBeInTheDocument()
    expect(within(permissionCard).queryByRole('button', { name: /始终允许/ })).not.toBeInTheDocument()
    expect(within(permissionCard).queryByRole('button', { name: '自动批准' })).not.toBeInTheDocument()
  })

  it('shows write permission content in the inline authorization card', () => {
    render(
      <HoverList
        sessions={[session({
          phase: 'waiting_approval',
          pendingPermission: {
            toolName: 'Write',
            toolInput: JSON.stringify({
              file_path: '/Users/demo/github/empty/package.json',
              content: '{\n  "name": "agentbro-auth",\n  "version": "1.0.0",\n  "private": true,\n  "type": "module"\n}',
            }),
          },
        })]}
        onSessionClick={vi.fn()}
      />,
    )

    expect(screen.getByText('.../github/empty/package.json')).toHaveClass('hover-list__inline-perm-path')
    expect(screen.getByText('new file')).toHaveClass('hover-list__inline-perm-new-badge')
    expect(screen.getByText(/"name": "agentbro-auth"/)).toHaveClass('hover-list__inline-perm-code')
    expect(screen.queryByText('/Users/demo/github/empty/package.json')).not.toBeInTheDocument()
  })

  it('shows permission overlay content inline when returning to the session list', () => {
    useSessionStore.setState({
      activeOverlay: {
        id: 'permission-s1-overlay',
        sessionId: 's1',
        type: 'permission',
        data: {
          toolName: 'Write',
          toolInput: JSON.stringify({
            file_path: '/Users/demo/github/empty/package.json',
            content: '{\n  "name": "overlay-auth",\n  "private": true\n}',
          }),
        },
        createdAt: Date.now(),
      },
    })

    render(
      <HoverList
        sessions={[session({ phase: 'processing', pendingPermission: undefined })]}
        onSessionClick={vi.fn()}
      />,
    )

    expect(screen.getByText('.../github/empty/package.json')).toHaveClass('hover-list__inline-perm-path')
    expect(screen.getByText(/"name": "overlay-auth"/)).toHaveClass('hover-list__inline-perm-code')
    expect(screen.getByRole('button', { name: '允许一次' })).toBeInTheDocument()
  })

  it('gives inline plan previews more readable content and subdued permission text', () => {
    const longPlan = `${'SwitchProviderEditor.tsx '.repeat(12)}final-visible-fragment`
    render(
      <HoverList
        sessions={[session({
          phase: 'waiting_approval',
          planTitle: 'Agent Switch UI 中文化 + 交互重设计',
          planContent: longPlan,
          planPermissions: ['Bash: run cargo check', 'Bash: run pnpm dev'],
        })]}
        onSessionClick={vi.fn()}
      />,
    )

    expect(document.querySelector('.hover-list__inline-plan-content')?.textContent).toContain('final-visible-fragment')
    expect(screen.getByText('请求的权限:')).toHaveClass('hover-list__inline-plan-perms-label')
    expect(screen.getAllByText('Bash')[0]).toHaveClass('hover-list__inline-plan-perm-tool')
    expect(screen.getByText(/run cargo check/)).toBeInTheDocument()
  })

  it('renders inline plan markdown and uses plan-specific action styles', () => {
    render(
      <HoverList
        sessions={[session({
          phase: 'waiting_approval',
          planTitle: 'Implementation plan',
          planContent: '### Steps\n1. **Render Markdown**\n\n```ts\nconst ok = true\n```',
        })]}
        onSessionClick={vi.fn()}
      />,
    )

    expect(screen.getByRole('heading', { level: 3, name: 'Steps' })).toBeInTheDocument()
    expect(screen.getByText('Render Markdown').tagName).toBe('STRONG')
    expect(screen.getByText('const ok = true')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send Feedback' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Manual Review' })).toHaveClass('hover-list__inline-plan-btn--feedback')
    expect(screen.getByRole('button', { name: 'Accept Edits' })).toHaveClass('hover-list__inline-plan-btn--accept')
    expect(screen.getByRole('button', { name: 'Auto' })).toHaveClass('hover-list__inline-plan-btn--auto')
  })

  it('keeps inline plan previews visible when the active plan overlay is folded into the list', () => {
    useSessionStore.setState({
      activeOverlay: {
        id: 'plan-s1-overlay',
        sessionId: 's1',
        type: 'plan',
        data: {
          planTitle: 'Implementation plan',
          planContent: '1. Keep the list visible',
          requestedPermissions: ['Bash: run tests'],
        },
        createdAt: Date.now(),
      },
    })

    render(
      <HoverList
        sessions={[session({
          phase: 'waiting_approval',
          planTitle: 'Implementation plan',
          planContent: '1. Keep the list visible',
          planPermissions: ['Bash: run tests'],
        })]}
        onSessionClick={vi.fn()}
      />,
    )

    expect(document.querySelector('.hover-list__inline-plan')?.textContent).toContain('Implementation plan')
    expect(document.querySelector('.hover-list__inline-plan')?.textContent).toContain('Keep the list visible')
    expect(screen.getByText('Bash')).toHaveClass('hover-list__inline-plan-perm-tool')
  })

  it('renders the generic authorization card from pendingPermission with a diff preview', () => {
    render(
      <HoverList
        sessions={[session({
          phase: 'waiting_approval',
          pendingPermission: {
            toolName: 'Edit',
            toolInput: JSON.stringify({ file_path: 'src/i18n/locales/zh.json' }),
            diff: {
              filePath: 'src/i18n/locales/zh.json',
              lines: [
                { type: 'remove', lineNumber: 7, content: '"noSessionsHint": "在终端中启动 Claude Code。"' },
                { type: 'add', lineNumber: 7, content: '"noSessionsHint": "在终端中启动 AI Agent。"' },
              ],
            },
          },
        })]}
        onSessionClick={vi.fn()}
      />,
    )

    expect(screen.getByText('Edit')).toBeInTheDocument()
    expect(screen.getByText('src/i18n/locales/zh.json')).toBeInTheDocument()
    expect(screen.getByText('+1')).toBeInTheDocument()
    expect(screen.getByText('-1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '允许一次' })).toBeInTheDocument()
  })

  it('renders terminal-routed approval notices with a jump action', () => {
    const onJumpToTerminal = vi.fn()
    const onSessionClick = vi.fn()
    render(
      <HoverList
        sessions={[session({
          phase: 'waiting_approval',
          description: 'Continue in Terminal to approve this command.',
          notice: {
            kind: 'terminal_approval',
            title: 'Continue in Terminal',
            detail: 'Approval is delegated to the active tab',
            actionLabel: 'Go to Terminal',
          },
        })]}
        onSessionClick={onSessionClick}
        onJumpToTerminal={onJumpToTerminal}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Go to Terminal' }))

    expect(screen.getByText('Continue in Terminal')).toBeInTheDocument()
    expect(screen.getByText('Approval is delegated to the active tab')).toBeInTheDocument()
    expect(onJumpToTerminal).toHaveBeenCalledWith('s1')
    expect(onSessionClick).not.toHaveBeenCalled()
  })

  it('renders setup and trust notices without replacing deep session rows', () => {
    render(
      <HoverList
        sessions={[
          session({
            id: 'restart',
            phase: 'idle',
            sessionTitle: 'Restart required',
            notice: {
              kind: 'restart',
              title: 'Restart your sessions',
              detail: 'Hooks just installed - restart running sessions to connect',
            },
          }),
          session({
            id: 'trust',
            phase: 'waiting_approval',
            sessionTitle: 'Codex trust',
            notice: {
              kind: 'trust',
              title: 'Codex updated - confirm authorization',
              detail: 'Confirm once to keep approvals working',
            },
          }),
        ]}
        onSessionClick={vi.fn()}
      />,
    )

    expect(screen.getByText('Restart your sessions')).toBeInTheDocument()
    expect(screen.getByText('Codex updated - confirm authorization')).toBeInTheDocument()
    expect(screen.getByText('Hooks just installed - restart running sessions to connect')).toBeInTheDocument()
  })

  it('routes inline question options without opening the row', async () => {
    const onSessionClick = vi.fn()
    render(
      <HoverList
        sessions={[session({
          phase: 'waiting_input',
          pendingQuestion: { question: 'Pick a target', options: ['Preview', 'Ship'] },
        })]}
        onSessionClick={onSessionClick}
      />,
    )

    fireEvent.mouseDown(screen.getByText('Ship').closest('button')!)

    expect(tauriMocks.respondQuestion).toHaveBeenCalledWith('s1', 'Ship')
    expect(onSessionClick).not.toHaveBeenCalled()
  })

  it('renders inline question options as compact question cards with descriptions', () => {
    render(
      <HoverList
        sessions={[session({
          phase: 'waiting_input',
          pendingQuestion: {
            question: 'Pick a view',
            options: ['Overlay', 'Detail', 'Compact'],
            descriptions: ['Floating prompt', 'Expanded detail', 'Dense summary'],
          },
        })]}
        onSessionClick={vi.fn()}
      />,
    )

    const detailOption = screen.getByText('Detail').closest('button')
    expect(detailOption).toHaveClass('hover-list__inline-question-opt')
    expect(detailOption?.querySelector('.hover-list__inline-question-opt-index')?.textContent).toBe('2')
    expect(screen.getByText('Expanded detail')).toHaveClass('hover-list__inline-question-opt-desc')
  })

  it('routes inline multi-select question answers as joined text', () => {
    render(
      <HoverList
        sessions={[session({
          phase: 'waiting_input',
          pendingQuestion: {
            question: 'Pick targets',
            options: ['Preview', 'Docs', 'Production'],
            multiSelect: true,
          },
        })]}
        onSessionClick={vi.fn()}
      />,
    )

    fireEvent.mouseDown(screen.getByText('Preview').closest('button')!)
    fireEvent.mouseDown(screen.getByText('Production').closest('button')!)
    fireEvent.mouseDown(screen.getByRole('button', { name: '确认 (2)' }))

    expect(tauriMocks.respondQuestion).toHaveBeenCalledWith('s1', 'Preview, Production')
  })

  it('routes inline multi-question answers as JSON', () => {
    render(
      <HoverList
        sessions={[session({
          phase: 'waiting_input',
          pendingQuestion: {
            question: '[Deploy] Choose options',
            options: ['Preview', 'Ship'],
            questions: [
              {
                question: 'Which target?',
                options: [{ label: 'Preview' }, { label: 'Ship' }],
                multiSelect: true,
              },
              {
                question: 'Notify channel?',
                options: [{ label: 'Yes' }, { label: 'No' }],
              },
            ],
          },
        })]}
        onSessionClick={vi.fn()}
      />,
    )

    fireEvent.mouseDown(screen.getByText('Preview').closest('button')!)
    fireEvent.mouseDown(screen.getByText('Ship').closest('button')!)
    fireEvent.mouseDown(screen.getByText('No').closest('button')!)
    fireEvent.mouseDown(screen.getByRole('button', { name: '✓ 提交所有回答' }))

    expect(tauriMocks.respondQuestion).toHaveBeenCalledWith(
      's1',
      JSON.stringify({
        'Which target?': 'Preview, Ship',
        'Notify channel?': 'No',
      }),
    )
  })

  it('routes inline plan actions without opening the row', () => {
    const onSessionClick = vi.fn()
    render(
      <HoverList
        sessions={[session({
          phase: 'waiting_approval',
          planTitle: 'Implementation plan',
          planContent: '1. Fix the island',
        })]}
        onSessionClick={onSessionClick}
      />,
    )

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Accept Edits' }))

    expect(tauriMocks.respondPlan).toHaveBeenCalledWith('s1', 'acceptEdits', undefined)
    expect(onSessionClick).not.toHaveBeenCalled()
  })

  it('sends inline plan feedback from the input row without opening the row', () => {
    const onSessionClick = vi.fn()
    render(
      <HoverList
        sessions={[session({
          phase: 'waiting_approval',
          planTitle: 'Implementation plan',
          planContent: '1. Fix the island',
        })]}
        onSessionClick={onSessionClick}
      />,
    )

    const input = screen.getByPlaceholderText('Tell Claude what to change...')
    fireEvent.mouseDown(input)
    fireEvent.change(input, { target: { value: 'Please revise the scope' } })
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Send Feedback' }))

    expect(tauriMocks.respondPlan).toHaveBeenCalledWith('s1', 'feedback', 'Please revise the scope')
    expect(onSessionClick).not.toHaveBeenCalled()
  })

})
