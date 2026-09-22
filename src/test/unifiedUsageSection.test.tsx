import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi, beforeAll } from 'vitest'
import unifiedUsageSource from '../components/settings/sections/UnifiedUsageSection.tsx?raw'
import usageProvidersPanelSource from '../components/settings/sections/UsageProvidersPanel.tsx?raw'
import type { UsageDashboard, UsageHistory, UsageHistoryScanStatus, UsageSnapshot } from '../services/tauriApi'

// The Usage view reads one normalized dashboard command. Stub the module so the
// assertions below are about how the section renders snapshot fields, not about
// the Tauri runtime. UsageProvidersPanel shares the same module.
const getUsageDashboard = vi.fn<() => Promise<UsageDashboard>>()
const listUsageProviders = vi.fn(() => Promise.resolve([] as UsageSnapshot[]))
const startUsageHistoryScan = vi.fn(() => Promise.resolve())
const getUsageHistoryScanStatus = vi.fn<() => Promise<UsageHistoryScanStatus>>()

vi.mock('../services/tauriApi', () => ({
  isTauri: () => true,
  getUsageDashboard: () => getUsageDashboard(),
  listUsageProviders: () => listUsageProviders(),
  startUsageHistoryScan: () => startUsageHistoryScan(),
  getUsageHistoryScanStatus: () => getUsageHistoryScanStatus(),
  getConfig: () => Promise.resolve({}),
  updateConfig: () => Promise.resolve(),
  authorizeUsageProvider: () => Promise.resolve(),
  openSystemPath: () => Promise.resolve(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: () => Promise.resolve(() => {}),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'en' },
  }),
}))

function idleScanStatus(): UsageHistoryScanStatus {
  return {
    scanning: false,
    filesTotal: 0,
    filesScanned: 0,
    filesParsed: 0,
    filesSkipped: 0,
    oversizedLines: 0,
    events: 0,
    error: null,
    startedAt: null,
    finishedAt: null,
  }
}

function emptyHistory(): UsageHistory {
  return {
    available: false,
    source: null,
    detail: '',
    sessionsScanned: null,
    tokenEvents: null,
    pricingEffectiveDate: null,
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

// Tests import these components lazily so the module mocks above apply. The
// first import transforms a large module graph; under a busy parallel run
// that alone can exceed the 5 s per-test timeout, and a timed-out import then
// renders into the next test. Warm the module cache once, outside any test.
beforeAll(async () => {
  await Promise.all([
    import('../components/settings/sections/UnifiedUsageSection'),
  ])
}, 60_000)

describe('UnifiedUsageSection rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listUsageProviders.mockResolvedValue([])
    getUsageDashboard.mockResolvedValue({ providers: [], computedAt: Date.now(), pricingEffectiveDate: null })
    getUsageHistoryScanStatus.mockResolvedValue(idleScanStatus())
    startUsageHistoryScan.mockResolvedValue()
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
      pricingEffectiveDate: null,
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

  it('switches the Usage & Cost period and shows tokens, requests, and estimated cost', async () => {
    const history: UsageHistory = {
      available: true,
      source: 'Codex local session logs',
      detail: 'Aggregated from 1 local session log(s)',
      sessionsScanned: 1,
      tokenEvents: 2,
      pricingEffectiveDate: '2025-10-15',
      periods: [
        {
          id: 'today',
          tokens: { input: 1000, output: 200, cacheRead: 100, cacheCreate: 0 },
          requests: 1,
          cost: { amount: 1.23, currency: 'USD', effectiveDate: '2025-09-15', verified: false, complete: true },
          models: [{
            model: 'gpt-5-codex',
            tokens: { input: 1000, output: 200, cacheRead: 100, cacheCreate: 0 },
            requests: 1,
            cost: { amount: 1.23, currency: 'USD', effectiveDate: '2025-09-15', verified: false, complete: true },
          }],
          unpricedModels: [],
        },
        {
          id: 'week',
          tokens: { input: 2000, output: 400, cacheRead: 200, cacheCreate: 0 },
          requests: 2,
          cost: { amount: 2.46, currency: 'USD', effectiveDate: '2025-09-15', verified: false, complete: true },
          models: [],
          unpricedModels: [],
        },
        {
          id: 'month',
          tokens: { input: 3000, output: 600, cacheRead: 300, cacheCreate: 0 },
          requests: 3,
          cost: { amount: 3.69, currency: 'USD', effectiveDate: '2025-09-15', verified: false, complete: true },
          models: [],
          unpricedModels: [],
        },
      ],
    }
    getUsageDashboard.mockResolvedValue({
      providers: [snapshotProvider({ history })],
      computedAt: Date.now(),
      pricingEffectiveDate: null,
    })

    await renderUsage()

    const cost = await screen.findByTestId('usage-cost')
    await within(cost).findByRole('row', { name: /Codex/ })
    // The provider row and its per-model row both carry the period totals.
    expect(within(cost).getAllByText('1.3K').length).toBeGreaterThanOrEqual(2)
    expect(within(cost).getAllByText(/\$1\.23/).length).toBeGreaterThanOrEqual(2)
    expect(within(cost).getAllByText('estimated').length).toBeGreaterThanOrEqual(2)
    expect(within(cost).getByText(/Codex local session logs/)).toBeInTheDocument()
    expect(within(cost).getByText(/Price table effective 2025-10-15/)).toBeInTheDocument()
    // Per-model breakdown for the priced model.
    const modelRow = within(cost).getByTestId('usage-model-gpt-5-codex')
    expect(within(modelRow).getByText('gpt-5-codex')).toBeInTheDocument()

    fireEvent.click(within(cost).getByRole('tab', { name: 'This Week' }))
    expect(within(cost).getByText('2.6K')).toBeInTheDocument()
    expect(within(cost).getByText(/\$2\.46/)).toBeInTheDocument()

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
      pricingEffectiveDate: '2025-10-15',
    })

    await renderUsage()

    const now = await screen.findByTestId('usage-now')
    const cost = screen.getByTestId('usage-cost')
    const nowRow = await within(now).findByRole('row', { name: /Codex/ })
    expect(within(nowRow).getAllByText('Unknown').length).toBeGreaterThanOrEqual(4)
    expect(within(nowRow).getByText('Waiting for data')).toBeInTheDocument()

    const costRow = await within(cost).findByRole('row', { name: /Codex/ })
    // Token columns and requests are Unknown; with no price the cost cell stays empty.
    expect(within(costRow).getAllByText('Unknown').length).toBeGreaterThanOrEqual(6)
    expect(within(costRow).getByLabelText('No public price; token usage only')).toHaveTextContent('—')
    expect(within(costRow).queryByText('0')).not.toBeInTheDocument()
    // The price-table effective date is visible even before any usage exists.
    expect(within(cost).getByText(/Price table effective 2025-10-15/)).toBeInTheDocument()
  })

  it('shows only token usage for models without a public price, never a zero amount', async () => {
    const history: UsageHistory = {
      available: true,
      source: 'Codex local session logs',
      detail: '',
      sessionsScanned: 1,
      tokenEvents: 2,
      pricingEffectiveDate: '2025-10-15',
      periods: [{
        id: 'today',
        tokens: { input: 1500, output: 220, cacheRead: 100, cacheCreate: 0 },
        requests: 2,
        cost: { amount: 2.25, currency: 'USD', effectiveDate: '2025-10-15', verified: false, complete: false },
        models: [
          {
            model: 'gpt-5-codex',
            tokens: { input: 1000, output: 200, cacheRead: 100, cacheCreate: 0 },
            requests: 1,
            cost: { amount: 2.25, currency: 'USD', effectiveDate: '2025-09-15', verified: false, complete: true },
          },
          {
            model: 'gpt-5.2-codex-unreleased',
            tokens: { input: 500, output: 20, cacheRead: 0, cacheCreate: 0 },
            requests: 1,
            cost: null,
          },
        ],
        unpricedModels: ['gpt-5.2-codex-unreleased'],
      }],
    }
    getUsageDashboard.mockResolvedValue({
      providers: [snapshotProvider({ history })],
      computedAt: Date.now(),
      pricingEffectiveDate: null,
    })

    await renderUsage()

    const cost = await screen.findByTestId('usage-cost')
    await within(cost).findByText(/Token usage only \(no public price\): gpt-5\.2-codex-unreleased/)
    // The period total is a lower bound because one model has no price entry.
    expect(within(cost).getByText(/≥ \$2\.25/)).toBeInTheDocument()
    const unknownModel = within(cost).getByTestId('usage-model-gpt-5.2-codex-unreleased')
    // Tokens are shown; the cost cell is empty rather than Unknown or $0.00.
    expect(within(unknownModel).getByText('500')).toBeInTheDocument()
    expect(within(unknownModel).getByLabelText('No public price; token usage only')).toHaveTextContent('—')
    expect(within(unknownModel).queryByText('Unknown')).not.toBeInTheDocument()
    expect(within(unknownModel).queryByText(/\$0\.00/)).not.toBeInTheDocument()
  })

  it('shows the background scan progress while usage history is being collected', async () => {
    getUsageHistoryScanStatus.mockResolvedValue({
      ...idleScanStatus(),
      scanning: true,
      filesTotal: 12,
      filesScanned: 4,
    })
    getUsageDashboard.mockResolvedValue({
      providers: [snapshotProvider()],
      computedAt: Date.now(),
      pricingEffectiveDate: null,
    })

    await renderUsage()

    const progress = await screen.findByTestId('usage-scan-progress')
    expect(progress).toHaveTextContent('Collecting usage history')
    expect(progress).toHaveTextContent('4/12')
    expect(startUsageHistoryScan).toHaveBeenCalled()
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
