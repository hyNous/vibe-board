import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import '../i18n'
import { CollapsedBar } from '../components/notch/CollapsedBar'
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
})
