import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusSnapshot, RateLimitInfo } from '../types/agent'
import type { UsageProviderStatus } from '../services/tauriApi'

// The Usage view reads three independent backend commands. Stub the module so
// the assertions below are about how the section aggregates and labels that
// data, not about the Tauri runtime.
const getAgentStatuses = vi.fn<() => Promise<AgentStatusSnapshot[]>>()
const getUsageSnapshots = vi.fn<() => Promise<RateLimitInfo[]>>()
const listUsageProviders = vi.fn<(refresh: boolean) => Promise<UsageProviderStatus[]>>()
const getCodexUsageSummary = vi.fn()

vi.mock('../services/tauriApi', () => ({
  isTauri: () => true,
  getAgentStatuses: () => getAgentStatuses(),
  getUsageSnapshots: () => getUsageSnapshots(),
  listUsageProviders: (refresh: boolean) => listUsageProviders(refresh),
  getCodexUsageSummary: () => getCodexUsageSummary(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'zh' },
  }),
}))

function provider(overrides: Partial<UsageProviderStatus> = {}): UsageProviderStatus {
  return {
    provider: 'codex',
    label: 'Codex',
    primary: true,
    enabled: true,
    available: true,
    catalogSupported: true,
    implementationStatus: 'active',
    source: null,
    detail: '',
    authStatus: 'authorized',
    authPath: null,
    canAuthorize: false,
    updatedAt: Date.now(),
    ...overrides,
  }
}

function agentStatus(overrides: Partial<AgentStatusSnapshot> = {}): AgentStatusSnapshot {
  return {
    agent: 'codex',
    label: 'Codex',
    primary: true,
    online: true,
    lastSeenAt: Date.now(),
    lastCompletedAt: null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    rateLimits: null,
    detail: null,
    ...overrides,
  }
}

async function renderUsage() {
  const { UnifiedUsageSection } = await import('../components/settings/sections/UnifiedUsageSection')
  return render(<UnifiedUsageSection />)
}

describe('UnifiedUsageSection token aggregation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getCodexUsageSummary.mockResolvedValue(null)
    listUsageProviders.mockResolvedValue([])
    getUsageSnapshots.mockResolvedValue([])
    getAgentStatuses.mockResolvedValue([])
  })

  it('sums the real token counts reported by each agent status snapshot', async () => {
    listUsageProviders.mockResolvedValue([provider()])
    getAgentStatuses.mockResolvedValue([
      agentStatus({
        agent: 'codex',
        tokens: { input: 1000, output: 500, cacheRead: 300, cacheCreate: 200 },
      }),
      agentStatus({
        agent: 'claude-code',
        label: 'Claude Code',
        primary: false,
        tokens: { input: 2000, output: 1000, cacheRead: 0, cacheCreate: 0 },
      }),
    ])

    await renderUsage()

    // 2,000 for Codex + 3,000 for Claude Code.
    expect(await screen.findByText('5.0K')).toBeInTheDocument()
    expect(screen.getByText('Last Session Tokens')).toBeInTheDocument()

    const codexRow = screen.getByRole('row', { name: /Codex/ })
    expect(within(codexRow).getByText('2.0K tok')).toBeInTheDocument()
    expect(within(codexRow).getByText('last session tokens')).toBeInTheDocument()
  })

  it('labels the total as one last session per agent rather than a cumulative total', async () => {
    getAgentStatuses.mockResolvedValue([
      agentStatus({ tokens: { input: 10, output: 0, cacheRead: 0, cacheCreate: 0 } }),
    ])

    await renderUsage()

    expect(await screen.findByText('每个 Agent 最近一次会话之和')).toBeInTheDocument()
    expect(
      screen.getByText(/Usage 列是该 Provider 下每个 Agent/),
    ).toBeInTheDocument()
    expect(screen.getByText(/不是当天或历史全部会话的累计/)).toBeInTheDocument()
  })

  it('falls back to quota instead of inventing a token number when no session reported tokens', async () => {
    listUsageProviders.mockResolvedValue([provider()])
    getUsageSnapshots.mockResolvedValue([{
      fiveHourUsage: 40,
      fiveHourRemaining: '3h',
      sevenDayUsage: 20,
      sevenDayRemaining: '5d',
      provider: 'codex',
      providerLabel: 'Codex',
      source: 'codex quota reader',
      updatedAt: Date.now(),
    }])
    getAgentStatuses.mockResolvedValue([agentStatus()])

    await renderUsage()

    expect(await screen.findByText('Host Quota Remaining')).toBeInTheDocument()
    expect(screen.queryByText('Last Session Tokens')).not.toBeInTheDocument()
    // Shown both in the headline tile and in the provider coverage row.
    expect(screen.getAllByText('5h 60% · 7d 80%').length).toBeGreaterThan(0)
  })

  it('shows Unknown rather than zero when neither tokens nor quota are available', async () => {
    listUsageProviders.mockResolvedValue([provider({ available: false, authStatus: 'missing' })])

    await renderUsage()

    expect(await screen.findByText('Unknown')).toBeInTheDocument()
    expect(screen.queryByText('Last Session Tokens')).not.toBeInTheDocument()
  })
})
