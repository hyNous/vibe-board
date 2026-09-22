import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import unifiedUsageSource from '../components/settings/sections/UnifiedUsageSection.tsx?raw'
import usageProvidersPanelSource from '../components/settings/sections/UsageProvidersPanel.tsx?raw'
import type { UsageDashboard, UsageHistory, UsageSnapshot } from '../services/tauriApi'

// The Usage view reads one normalized dashboard command. Stub the module so the
// assertions below are about how the section renders snapshot fields, not about
// the Tauri runtime. UsageProvidersPanel shares the same module.
const getUsageDashboard = vi.fn<() => Promise<UsageDashboard>>()
const listUsageProviders = vi.fn(() => Promise.resolve([] as UsageSnapshot[]))

vi.mock('../services/tauriApi', () => ({
  isTauri: () => true,
  getUsageDashboard: () => getUsageDashboard(),
  listUsageProviders: () => listUsageProviders(),
  getConfig: () => Promise.resolve({}),
  updateConfig: () => Promise.resolve(),
  authorizeUsageProvider: () => Promise.resolve(),
  openSystemPath: () => Promise.resolve(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'en' },
  }),
}))

function emptyHistory(): UsageHistory {
  return {
    available: false,
    source: null,
    detail: '',
    sessionsScanned: null,
    tokenEvents: null,
    periods: [],
  }
}

function snapshotProvider(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    provider: 'codex',
    label: 'Codex',
    state: 'ok',
    detail: 'Codex account rate limits found.',
    source: 'codex-jsonl',
    fetchedAt: Date.now() - 30_000,
    windows: [],
    history: emptyHistory(),
    enabled: true,
    catalogSupported: true,
    implementationStatus: 'active',
    settingsOrder: 0,
    authStatus: 'authorized',
    authPath: null,
    canAuthorize: false,
    ...overrides,
  }
}

async function renderUsage() {
  const { UnifiedUsageSection } = await import('../components/settings/sections/UnifiedUsageSection')
  return render(<UnifiedUsageSection />)
}

describe('UnifiedUsageSection rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listUsageProviders.mockResolvedValue([])
    getUsageDashboard.mockResolvedValue({ providers: [], computedAt: Date.now() })
  })

  it('renders the Now block purely from normalized snapshot fields', async () => {
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString()
    getUsageDashboard.mockResolvedValue({
      providers: [snapshotProvider({
        windows: [{
          id: 'five_hour',
          title: '5h',
          usedPercent: 40,
          remainingPercent: 60,
          remainingLabel: '3h',
          resetsAt,
          windowMinutes: 300,
        }],
      })],
      computedAt: Date.now(),
    })

    await renderUsage()

    const now = await screen.findByTestId('usage-now')
    const row = await within(now).findByRole('row', { name: /Codex/ })
    expect(within(row).getByText('5h 60%')).toBeInTheDocument()
    expect(within(row).getAllByText(/^5h /).length).toBeGreaterThanOrEqual(2)
    expect(within(row).getByText('codex-jsonl')).toBeInTheDocument()
    expect(within(row).getByText('Just now')).toBeInTheDocument()
    expect(within(row).getByText('Connected')).toBeInTheDocument()
  })

  it('switches the Usage & Cost period and shows the token breakdown', async () => {
    const history: UsageHistory = {
      available: true,
      source: 'Codex local session logs',
      detail: 'Aggregated from 1 Codex session file(s) with token events',
      sessionsScanned: 1,
      tokenEvents: 2,
      periods: [
        { id: 'today', tokens: { input: 1000, output: 200, cacheRead: 100, cacheCreate: 0 }, sessions: 1 },
        { id: 'week', tokens: { input: 2000, output: 400, cacheRead: 200, cacheCreate: 0 }, sessions: 2 },
        { id: 'month', tokens: { input: 3000, output: 600, cacheRead: 300, cacheCreate: 0 }, sessions: 3 },
      ],
    }
    getUsageDashboard.mockResolvedValue({
      providers: [snapshotProvider({ history })],
      computedAt: Date.now(),
    })

    await renderUsage()

    const cost = await screen.findByTestId('usage-cost')
    expect(await within(cost).findByText('1.3K')).toBeInTheDocument()
    expect(within(cost).getByText(/Codex local session logs/)).toBeInTheDocument()

    fireEvent.click(within(cost).getByRole('tab', { name: 'This Week' }))
    expect(within(cost).getByText('2.6K')).toBeInTheDocument()

    fireEvent.click(within(cost).getByRole('tab', { name: 'This Month' }))
    expect(within(cost).getByText('3.9K')).toBeInTheDocument()
  })

  it('shows Unknown instead of zero when quota and history are missing', async () => {
    getUsageDashboard.mockResolvedValue({
      providers: [snapshotProvider({
        state: 'unavailable',
        source: null,
        fetchedAt: null,
        windows: [],
        history: emptyHistory(),
      })],
      computedAt: Date.now(),
    })

    await renderUsage()

    const now = await screen.findByTestId('usage-now')
    const cost = screen.getByTestId('usage-cost')
    const nowRow = await within(now).findByRole('row', { name: /Codex/ })
    expect(within(nowRow).getAllByText('Unknown').length).toBeGreaterThanOrEqual(4)
    expect(within(nowRow).getByText('Waiting for data')).toBeInTheDocument()

    const costRow = await within(cost).findByRole('row', { name: /Codex/ })
    expect(within(costRow).getAllByText('Unknown').length).toBeGreaterThanOrEqual(7)
    expect(within(costRow).queryByText('0')).not.toBeInTheDocument()
  })

  it('keeps provider-specific branching out of the usage page components', () => {
    const providerNames = /\b(codex|claude|anthropic|gemini|opencode|antigravity|copilot|cursor|deepseek|kimi|kiro|qoder|qwen|droid|stepfun|hermes|codebuddy)\b/i
    const sources: Array<[string, string]> = [
      ['UnifiedUsageSection.tsx', unifiedUsageSource],
      ['UsageProvidersPanel.tsx', usageProvidersPanelSource],
    ]
    for (const [file, source] of sources) {
      expect(source, file).not.toMatch(providerNames)
    }
  })
})
