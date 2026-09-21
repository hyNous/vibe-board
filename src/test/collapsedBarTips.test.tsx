import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { CollapsedBar } from '../components/notch/CollapsedBar'
import { RateLimitBar } from '../components/notch/RateLimitBar'
import { useConfigStore } from '../stores/configStore'
import type { SessionState } from '../types/agent'

function session(overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: 's1',
    agentType: 'claude-code',
    project: 'project',
    terminal: 'iTerm',
    phase: 'idle',
    startedAt: Date.now(),
    duration: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    chatHistory: [],
    subagents: [],
    activeTools: [],
    ...overrides,
  }
}

function expectUsageSegment(
  container: HTMLElement,
  index: number,
  windowTitle: string,
  usagePercent: number,
  remainingLabel: string,
  level: 'green' | 'amber' | 'red',
) {
  const segments = container.querySelectorAll('.rate-limit__segment')
  const segment = segments[index] as HTMLElement | undefined
  expect(segment).toBeInTheDocument()
  expect(segment).toHaveTextContent(`${windowTitle}${usagePercent}%${remainingLabel}`)
  expect(segment).toHaveClass(`rate-limit__segment--${level}`)
  expect(segment?.querySelector('.rate-limit__usage')).toHaveTextContent(`${usagePercent}%`)
}

describe('CollapsedBar idle tips', () => {
  beforeEach(() => {
    useConfigStore.setState({ tipsEnabled: true, showToolStatus: true, showUsageQuota: true, usageQueryEnabled: true })
  })

  it('shows tips in the expanded header when idle', () => {
    render(<CollapsedBar sessions={[]} panelState="expanded" onCollapse={() => {}} />)

    expect(screen.getByText('Tips:')).toBeInTheDocument()
  })

  it('hides tips when the setting is disabled', () => {
    useConfigStore.setState({ tipsEnabled: false })

    render(<CollapsedBar sessions={[session()]} panelState="expanded" onCollapse={() => {}} />)

    expect(screen.queryByText('Tips:')).not.toBeInTheDocument()
  })

  it('shows only the Vibe Board icon and omits tips/empty text in closed collapsed and micro states when idle', () => {
    const { container: collapsedContainer } = render(
      <CollapsedBar sessions={[]} panelState="collapsed" onCollapse={() => {}} focusFilteredEmpty />,
    )
    expect(collapsedContainer.querySelector('.collapsed-bar__idle-logo')).toBeInTheDocument()
    expect(screen.queryByText('Tips:')).not.toBeInTheDocument()
    expect(screen.queryByText('notch.noSessionInFocus')).not.toBeInTheDocument()
    expect(collapsedContainer.querySelector('.collapsed-bar__count')).toBeNull()
    expect(collapsedContainer.querySelector('.collapsed-bar__icon-btn')).toBeNull()

    const { container: microContainer } = render(
      <CollapsedBar sessions={[]} panelState="collapsed" isMicro onCollapse={() => {}} focusFilteredEmpty />,
    )
    expect(microContainer.querySelector('.collapsed-bar__idle-logo')).toBeInTheDocument()
    expect(microContainer.querySelector('.collapsed-bar__micro-count')).toBeNull()
  })

  it('counts unfinished task sessions in WAIT', () => {
    const { container } = render(
      <CollapsedBar
        sessions={[
          session({ tasks: [{ id: '1', name: 'Finish parity', status: 'pending' }] }),
        ]}
        panelState="hover"
        onCollapse={() => {}}
      />,
    )

    expect(container.querySelector('.collapsed-bar__counter-pill--wait')?.textContent).toBe('WAIT1')
  })

  it('shows 5h and 7d usage in the expanded header when usage quota is enabled', () => {
    const { container } = render(
      <CollapsedBar
        sessions={[session()]}
        panelState="expanded"
        rateLimits={{
          fiveHourUsage: 36,
          fiveHourRemaining: '1h1m',
          sevenDayUsage: 50,
          sevenDayRemaining: '5d8h',
        }}
        onCollapse={() => {}}
      />,
    )

    expectUsageSegment(container, 0, '5h', 36, '1h1m', 'green')
    expectUsageSegment(container, 1, '7d', 50, '5d8h', 'amber')
    expect(container.querySelector('.collapsed-bar__counter-pills')).not.toBeInTheDocument()
  })

  it('stacks Antigravity model quota groups into separate rows', () => {
    const { container } = render(
      <RateLimitBar
        rateLimits={{
          provider: 'antigravity',
          providerLabel: 'Antigravity',
          fiveHourUsage: 23,
          fiveHourRemaining: '77%',
          sevenDayUsage: 20,
          sevenDayRemaining: '80%',
          windows: [
            { id: 'gemini-weekly', title: 'Gemini 7d', usedPercent: 20, remainingPercent: 80, remainingLabel: '80%' },
            { id: 'gemini-5h', title: 'Gemini 5h', usedPercent: 23, remainingPercent: 77, remainingLabel: '77%' },
            { id: 'office-weekly', title: 'Office 7d', usedPercent: 10, remainingPercent: 90, remainingLabel: '90%' },
            { id: 'office-5h', title: 'Office 5h', usedPercent: 5, remainingPercent: 95, remainingLabel: '95%' },
          ],
        }}
      />,
    )

    expect(container.querySelector('.rate-limit--stacked')).toBeInTheDocument()
    expect(container.querySelectorAll('.rate-limit__group')).toHaveLength(2)
    expect(container.querySelectorAll('.rate-limit__segment')).toHaveLength(4)
    expect(container.querySelector('.rate-limit__group')?.textContent).toContain('Gemini')
    expect(container.querySelectorAll('.rate-limit__group')[1]?.textContent).toContain('Office')
  })

  it('uses the lead agent provider snapshot before the global fallback', () => {
    const { container } = render(
      <CollapsedBar
        sessions={[session({ agentType: 'codex' })]}
        panelState="expanded"
        rateLimits={{
          fiveHourUsage: 5,
          fiveHourRemaining: '4h',
          sevenDayUsage: 6,
          sevenDayRemaining: '6d',
        }}
        usageSnapshots={{
          codex: {
            provider: 'codex',
            providerLabel: 'Codex',
            source: 'codex-jsonl',
            fiveHourUsage: 66,
            fiveHourRemaining: '31m',
            sevenDayUsage: 22,
            sevenDayRemaining: '4d',
            windows: [
              { id: 'five_hour', title: '5h', usedPercent: 66, remainingLabel: '31m' },
              { id: 'seven_day', title: '7d', usedPercent: 22, remainingLabel: '4d' },
            ],
          },
          'claude-code': {
            provider: 'claude-code',
            providerLabel: 'Claude',
            fiveHourUsage: 11,
            fiveHourRemaining: '3h',
            sevenDayUsage: 12,
            sevenDayRemaining: '5d',
          },
        }}
        onCollapse={() => {}}
      />,
    )

    expectUsageSegment(container, 0, '5h', 66, '31m', 'amber')
    expectUsageSegment(container, 1, '7d', 22, '4d', 'green')
    expect(screen.queryByText('5h 5% 4h')).not.toBeInTheDocument()
  })

  it('does not show another provider snapshot for the active agent', () => {
    const { container } = render(
      <CollapsedBar
        sessions={[session({ agentType: 'codex' })]}
        panelState="hover"
        rateLimits={{
          provider: 'claude-code',
          providerLabel: 'Claude',
          fiveHourUsage: 88,
          fiveHourRemaining: '2m',
          sevenDayUsage: 44,
          sevenDayRemaining: '5d',
        }}
        onCollapse={() => {}}
      />,
    )

    expect(container.querySelector('.collapsed-bar__counter-pills')).toBeInTheDocument()
    expect(screen.queryByText('5h 88% 2m')).not.toBeInTheDocument()
  })

  it('falls back to another visible session provider snapshot when the lead provider has no usage data', () => {
    const { container } = render(
      <CollapsedBar
        sessions={[
          session({ id: 'claude', agentType: 'claude-code', phase: 'waiting_input' }),
          session({ id: 'codex', agentType: 'codex', phase: 'processing' }),
        ]}
        panelState="expanded"
        usageSnapshots={{
          codex: {
            provider: 'codex',
            providerLabel: 'Codex',
            source: 'codex-jsonl',
            fiveHourUsage: 41,
            fiveHourRemaining: '2h',
            sevenDayUsage: 18,
            sevenDayRemaining: '6d',
            windows: [
              { id: 'five_hour', title: '5h', usedPercent: 41, remainingLabel: '2h' },
              { id: 'seven_day', title: '7d', usedPercent: 18, remainingLabel: '6d' },
            ],
          },
        }}
        onCollapse={() => {}}
      />,
    )

    expectUsageSegment(container, 0, '5h', 41, '2h', 'green')
    expectUsageSegment(container, 1, '7d', 18, '6d', 'green')
  })

  it('keeps ALL ACT WAIT in the expanded header when usage quota is disabled', () => {
    useConfigStore.setState({ showUsageQuota: false })

    const { container } = render(
      <CollapsedBar
        sessions={[session({ phase: 'processing' })]}
        panelState="hover"
        rateLimits={{
          fiveHourUsage: 36,
          fiveHourRemaining: '1h1m',
          sevenDayUsage: 50,
          sevenDayRemaining: '5d8h',
        }}
        onCollapse={() => {}}
      />,
    )

    expect(container.querySelector('.collapsed-bar__counter-pills')).toBeInTheDocument()
    expect(screen.getByText('ALL')).toBeInTheDocument()
    expect(screen.getByText('ACT')).toBeInTheDocument()
    expect(screen.getByText('WAIT')).toBeInTheDocument()
    expect(screen.queryByText('5h 36% 1h1m')).not.toBeInTheDocument()
  })

  it('keeps ALL ACT WAIT when usage querying is disabled', () => {
    useConfigStore.setState({ usageQueryEnabled: false, showUsageQuota: true })

    const { container } = render(
      <CollapsedBar
        sessions={[session({ phase: 'processing' })]}
        panelState="hover"
        rateLimits={{
          fiveHourUsage: 36,
          fiveHourRemaining: '1h1m',
          sevenDayUsage: 50,
          sevenDayRemaining: '5d8h',
        }}
        onCollapse={() => {}}
      />,
    )

    expect(container.querySelector('.collapsed-bar__counter-pills')).toBeInTheDocument()
    expect(screen.queryByText('5h 36% 1h1m')).not.toBeInTheDocument()
  })

  it('omits alerts, error badges, and counts in the collapsed bar when erroring', () => {
    const { container } = render(
      <CollapsedBar
        sessions={[
          session({ id: 'error', phase: 'error', description: 'Tool failed' }),
        ]}
        panelState="collapsed"
        onCollapse={() => {}}
      />,
    )

    expect(container.querySelector('.collapsed-bar__alert-badge')).toBeNull()
    expect(container.querySelector('.collapsed-bar__error-badge')).toBeNull()
    expect(container.querySelector('.collapsed-bar__count')).toBeNull()
    expect(screen.getByLabelText('Vibe Board')).toBeInTheDocument()
  })

  it('identifies the executing Agent and omits task titles in collapsed and micro states during active work', () => {
    const { unmount } = render(
      <CollapsedBar
        sessions={[
          session({
            agentType: 'claude-code',
            project: 'vibe-board',
            sessionTitle: '修复悬浮窗动画',
            phase: 'processing',
            description: 'Processing user input',
            lastToolName: 'Edit',
            lastToolTarget: 'OverlayFeedbackPanel.tsx +68 -41',
          }),
        ]}
        panelState="collapsed"
        onCollapse={() => {}}
      />,
    )

    expect(screen.getByLabelText('Claude')).toBeInTheDocument()
    expect(screen.queryByText('vibe-board · 修复悬浮窗动画')).not.toBeInTheDocument()
    expect(screen.queryByText('Processing user input')).not.toBeInTheDocument()
    expect(screen.queryByText('notch.tool.editing')).not.toBeInTheDocument()
    expect(screen.queryByText('OverlayFeedbackPanel.tsx')).not.toBeInTheDocument()

    unmount()

    render(
      <CollapsedBar
        sessions={[
          session({
            agentType: 'codex',
            project: 'vibe-board',
            sessionTitle: 'Fix desktop activation',
            phase: 'processing',
          }),
        ]}
        panelState="collapsed"
        isMicro
        onCollapse={() => {}}
      />,
    )

    expect(screen.getByLabelText('Codex')).toBeInTheDocument()
    expect(screen.queryByText('vibe-board · Fix desktop activation')).not.toBeInTheDocument()
  })
})
