import { Fragment, useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { UsageProvidersPanel } from './UsageProvidersPanel'
import {
  getUsageDashboard,
  getUsageHistoryScanStatus,
  isTauri,
  startUsageHistoryScan,
  type UsageCost,
  type UsageDashboard,
  type UsageHistoryScanStatus,
  type UsagePeriod,
  type UsageSnapshot,
  type UsageTokens,
} from '../../../services/tauriApi'
import type { UsageRateWindow } from '../../../types/agent'
import { formatTokens, formatUsageCost } from '../../../utils/tokens'
import './UnifiedUsageSection.css'

type UsagePeriodId = 'today' | 'week' | 'month'

const USAGE_PERIODS: Array<{ id: UsagePeriodId; labelKey: string; defaultLabel: string }> = [
  { id: 'today', labelKey: 'settings.usagePage.periodToday', defaultLabel: 'Today' },
  { id: 'week', labelKey: 'settings.usagePage.periodWeek', defaultLabel: 'This Week' },
  { id: 'month', labelKey: 'settings.usagePage.periodMonth', defaultLabel: 'This Month' },
]

function readableError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message)
  }
  return String(error)
}

function windowRemainingLabel(window: UsageRateWindow): string {
  const remaining = window.remainingPercent ?? 100 - window.usedPercent
  if (!Number.isFinite(remaining)) return ''
  return `${window.title} ${Math.round(Math.max(0, Math.min(100, remaining)))}%`
}

function remainingText(snapshot: UsageSnapshot, unknown: string): string {
  const parts = snapshot.windows.map(windowRemainingLabel).filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : unknown
}

function formatResetTime(resetsAt: string | null | undefined): string {
  if (!resetsAt) return ''
  const date = new Date(resetsAt)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function resetText(snapshot: UsageSnapshot, unknown: string): string {
  const parts = snapshot.windows
    .map((window) => {
      const reset = formatResetTime(window.resetsAt)
      if (reset) return `${window.title} ${reset}`
      if (window.remainingLabel) return `${window.title} ${window.remainingLabel}`
      return ''
    })
    .filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : unknown
}

type Translate = (key: string, options?: { defaultValue?: string; count?: number }) => string

function formatFreshness(t: Translate, timestamp: number | null): string {
  const unknown = t('settings.usagePage.unknown', { defaultValue: 'Unknown' })
  if (!timestamp) return unknown
  const age = Math.max(0, Date.now() - timestamp)
  if (age < 60_000) return t('settings.usagePage.justNow', { defaultValue: 'Just now' })
  if (age < 3_600_000) {
    return t('settings.usagePage.minutesAgo', { defaultValue: '{{count}} min ago', count: Math.floor(age / 60_000) })
      .replace('{{count}}', String(Math.floor(age / 60_000)))
  }
  if (age < 86_400_000) {
    return t('settings.usagePage.hoursAgo', { defaultValue: '{{count}} h ago', count: Math.floor(age / 3_600_000) })
      .replace('{{count}}', String(Math.floor(age / 3_600_000)))
  }
  return t('settings.usagePage.daysAgo', { defaultValue: '{{count}} d ago', count: Math.floor(age / 86_400_000) })
    .replace('{{count}}', String(Math.floor(age / 86_400_000)))
}

function stateLabel(t: Translate, snapshot: UsageSnapshot): string {
  if (snapshot.state === 'ok') return t('settings.connected', { defaultValue: 'Connected' })
  if (snapshot.state === 'disabled') return t('settings.disabled', { defaultValue: 'Disabled' })
  if (snapshot.networkSupported && !snapshot.networkAuthorized) {
    return t('settings.usageNetworkNeedsAuthorization', { defaultValue: '未授权联网查询' })
  }
  switch (snapshot.state) {
    case 'unauthorized':
      return t('settings.needsAuth', { defaultValue: 'Needs authorization' })
    case 'failed':
      return t('settings.usagePage.stateFailed', { defaultValue: 'Failed' })
    case 'unsupported':
      return t('settings.usagePage.stateUnsupported', { defaultValue: 'Not integrated' })
    default:
      return t('settings.waitingData', { defaultValue: 'Waiting for data' })
  }
}

function periodEntry(snapshot: UsageSnapshot, period: UsagePeriodId): UsagePeriod | null {
  return snapshot.history.periods.find((entry) => entry.id === period) ?? null
}

function tokenTotal(tokens: UsageTokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreate
}

function MetricValue({ value, unknown }: { value: number | null | undefined; unknown: string }) {
  return <>{value == null ? unknown : formatTokens(value)}</>
}

/**
 * Every equivalent cost is an estimate: the amount comes from the built-in
 * price table and `≥` marks a lower bound (some models are unpriced). Without
 * a price the cell stays empty: only token usage is shown, never a 0 amount.
 */
function CostValue({ cost, label, noPrice }: { cost: UsageCost | null; label: string; noPrice: string }) {
  if (!cost) return <span className="unified-usage__cost-none" title={noPrice} aria-label={noPrice}>—</span>
  return (
    <>
      {cost.complete ? '' : '≥ '}
      {formatUsageCost(cost.amount, cost.currency)}
      <span className="unified-usage__cost-estimate" title={label}>
        {' '}
        {label}
      </span>
    </>
  )
}

export function UnifiedUsageSection() {
  const { t } = useTranslation()
  const unknown = t('settings.usagePage.unknown', { defaultValue: 'Unknown' })
  const [dashboard, setDashboard] = useState<UsageDashboard | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [period, setPeriod] = useState<UsagePeriodId>('today')
  const [scan, setScan] = useState<UsageHistoryScanStatus | null>(null)

  const loadUsage = useCallback(async () => {
    if (!isTauri()) {
      setDashboard(null)
      return
    }
    setLoading(true)
    setError('')
    try {
      setDashboard(await getUsageDashboard())
    } catch (err) {
      setError(readableError(err))
    } finally {
      setLoading(false)
    }
  }, [])

  const startScan = useCallback(async () => {
    if (!isTauri()) return
    try {
      await startUsageHistoryScan()
    } catch (err) {
      setError(readableError(err))
    }
  }, [])

  useEffect(() => {
    const id = window.setTimeout(() => {
      void loadUsage()
    }, 0)
    return () => window.clearTimeout(id)
  }, [loadUsage])

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    let unlisten: (() => void) | undefined

    getUsageHistoryScanStatus()
      .then((status) => {
        if (!cancelled) setScan(status)
      })
      .catch((err) => console.error('[usage] scan status:', err))

    import('@tauri-apps/api/event')
      .then(({ listen }) => listen<UsageHistoryScanStatus>('usage-history-scan', (event) => {
        setScan(event.payload)
        if (!event.payload.scanning) void loadUsage()
      }))
      .then((stop) => {
        if (cancelled) stop()
        else unlisten = stop
      })
      .catch((err) => console.error('[usage] listen usage-history-scan:', err))

    void startScan()

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [loadUsage, startScan])

  const providers = dashboard?.providers ?? []
  const pricingEffectiveDate = dashboard?.pricingEffectiveDate
    ?? providers
      .map((provider) => provider.history.pricingEffectiveDate)
      .find((date): date is string => Boolean(date))
  const costLabel = t('settings.usagePage.estimatedShort', { defaultValue: 'estimated' })
  const noPrice = t('settings.usagePage.noPrice', { defaultValue: 'No public price; token usage only' })

  return (
    <section className="unified-usage">
      <header className="agent-monitor__header">
        <div>
          <h2>{t('settings.usage', { defaultValue: 'Usage' })}</h2>
          <p>{t('settings.usagePage.subtitle', { defaultValue: 'Remaining quota and local token usage per provider; missing values stay Unknown.' })}</p>
        </div>
        <button
          type="button"
          className="agent-monitor__refresh"
          disabled={loading}
          onClick={() => {
            void loadUsage()
            void startScan()
          }}
        >
          {t('settings.refresh', { defaultValue: 'Refresh' })}
        </button>
      </header>

      {error && <div className="unified-usage__error">{error}</div>}

      <section className="unified-usage__provider-card" data-testid="usage-now">
        <div className="unified-usage__provider-head">
          <div>
            <h3>{t('settings.usagePage.nowTitle', { defaultValue: 'Now' })}</h3>
            <p>{t('settings.usagePage.nowDesc', { defaultValue: 'Remaining quota, reset time, source, and freshness reported by each provider.' })}</p>
          </div>
          {loading && (
            <span className="unified-usage__provider-loading">
              {providers.some((provider) => provider.networkSupported && provider.networkAuthorized)
                ? t('settings.usageNetworkQuerying', { defaultValue: '正在查询…' })
                : t('settings.detecting', { defaultValue: 'Checking...' })}
            </span>
          )}
        </div>
        {providers.length === 0 ? (
          <div className="hook-empty">{t('settings.usagePage.noProviders', { defaultValue: 'No usage provider data is available yet.' })}</div>
        ) : (
          <div className="unified-usage__provider-table-wrap">
            <table className="unified-usage__provider-table">
              <thead>
                <tr>
                  <th>{t('settings.usagePage.provider', { defaultValue: 'Provider' })}</th>
                  <th>{t('settings.usagePage.remaining', { defaultValue: 'Remaining' })}</th>
                  <th>{t('settings.usagePage.resetAt', { defaultValue: 'Resets' })}</th>
                  <th>{t('settings.usagePage.source', { defaultValue: 'Source' })}</th>
                  <th>{t('settings.usagePage.freshness', { defaultValue: 'Freshness' })}</th>
                  <th>{t('settings.usagePage.status', { defaultValue: 'Status' })}</th>
                </tr>
              </thead>
              <tbody>
                {providers.map((snapshot) => (
                  <tr key={snapshot.provider}>
                    <td><strong>{snapshot.label}</strong></td>
                    <td>{remainingText(snapshot, unknown)}</td>
                    <td>{resetText(snapshot, unknown)}</td>
                    <td>{snapshot.source ?? unknown}</td>
                    <td>{formatFreshness(t, snapshot.fetchedAt)}</td>
                    <td>
                      <strong>{stateLabel(t, snapshot)}</strong>
                      {snapshot.detail && <span className="unified-usage__detail">{snapshot.detail}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="unified-usage__provider-card" data-testid="usage-cost">
        <div className="unified-usage__provider-head">
          <div>
            <h3>{t('settings.usagePage.usageCostTitle', { defaultValue: 'Usage & Cost' })}</h3>
            <p>{t('settings.usagePage.usageCostDesc', { defaultValue: 'Token usage from local session logs, with estimated equivalent cost.' })}</p>
          </div>
          <div className="unified-usage__cost-head">
            {scan?.scanning && (
              <span className="unified-usage__provider-loading" data-testid="usage-scan-progress">
                {t('settings.usagePage.scanning', { defaultValue: 'Collecting usage history…' })}
                {scan.filesTotal > 0 ? ` ${scan.filesScanned}/${scan.filesTotal}` : ''}
              </span>
            )}
            <div className="unified-usage__tabs unified-usage__tabs--inline" role="tablist" aria-label={t('settings.usagePage.usageCostTitle', { defaultValue: 'Usage & Cost' })}>
              {USAGE_PERIODS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={period === item.id}
                  className={period === item.id ? 'unified-usage__tab unified-usage__tab--active' : 'unified-usage__tab'}
                  onClick={() => setPeriod(item.id)}
                >
                  {t(item.labelKey, { defaultValue: item.defaultLabel })}
                </button>
              ))}
            </div>
          </div>
        </div>
        {scan?.error && (
          <div className="unified-usage__provider-error" data-testid="usage-scan-error">
            {t('settings.usagePage.scanFailed', { defaultValue: 'Usage history scan failed' })}: {scan.error}
          </div>
        )}
        <div className="unified-usage__provider-table-wrap">
          <table className="unified-usage__provider-table">
            <thead>
              <tr>
                <th>{t('settings.usagePage.provider', { defaultValue: 'Provider' })}</th>
                <th>{t('settings.usagePage.tokens', { defaultValue: 'Tokens' })}</th>
                <th>{t('settings.usagePage.input', { defaultValue: 'Input' })}</th>
                <th>{t('settings.usagePage.output', { defaultValue: 'Output' })}</th>
                <th>{t('settings.usagePage.cacheRead', { defaultValue: 'Cache read' })}</th>
                <th>{t('settings.usagePage.cacheWrite', { defaultValue: 'Cache write' })}</th>
                <th>{t('settings.usagePage.requests', { defaultValue: 'Requests' })}</th>
                <th>{t('settings.usagePage.costEstimatedHeader', { defaultValue: 'Estimated cost' })}</th>
              </tr>
            </thead>
            <tbody>
              {providers.map((snapshot) => {
                const entry = periodEntry(snapshot, period)
                const tokens = entry?.tokens ?? null
                const historyDetail = [
                  snapshot.history.source,
                  snapshot.history.detail,
                  snapshot.history.sessionsScanned != null
                    ? t('settings.usagePage.sessionsScanned', { defaultValue: '{{count}} session file(s) scanned', count: snapshot.history.sessionsScanned })
                      .replace('{{count}}', String(snapshot.history.sessionsScanned))
                    : null,
                  snapshot.history.tokenEvents != null
                    ? t('settings.usagePage.tokenEvents', { defaultValue: '{{count}} usage events', count: snapshot.history.tokenEvents })
                      .replace('{{count}}', String(snapshot.history.tokenEvents))
                    : null,
                ].filter(Boolean).join(' · ')
                return (
                  <Fragment key={snapshot.provider}>
                    <tr>
                      <td>
                        <strong>{snapshot.label}</strong>
                        {historyDetail && <span className="unified-usage__detail">{historyDetail}</span>}
                        {entry && entry.unpricedModels.length > 0 && (
                          <span className="unified-usage__detail">
                            {t('settings.usagePage.unpricedModels', { defaultValue: 'Token usage only (no public price)' })}: {entry.unpricedModels.join(', ')}
                          </span>
                        )}
                      </td>
                      <td><MetricValue value={tokens ? tokenTotal(tokens) : null} unknown={unknown} /></td>
                      <td><MetricValue value={tokens?.input} unknown={unknown} /></td>
                      <td><MetricValue value={tokens?.output} unknown={unknown} /></td>
                      <td><MetricValue value={tokens?.cacheRead} unknown={unknown} /></td>
                      <td><MetricValue value={tokens?.cacheCreate} unknown={unknown} /></td>
                      <td>{entry?.requests == null ? unknown : entry.requests}</td>
                      <td><CostValue cost={entry?.cost ?? null} label={costLabel} noPrice={noPrice} /></td>
                    </tr>
                    {entry?.models.map((model) => (
                      <tr
                        key={`${snapshot.provider}:${model.model}`}
                        className="unified-usage__model-row"
                        data-testid={`usage-model-${model.model}`}
                      >
                        <td><span className="unified-usage__model-name">{model.model}</span></td>
                        <td><MetricValue value={tokenTotal(model.tokens)} unknown={unknown} /></td>
                        <td><MetricValue value={model.tokens.input} unknown={unknown} /></td>
                        <td><MetricValue value={model.tokens.output} unknown={unknown} /></td>
                        <td><MetricValue value={model.tokens.cacheRead} unknown={unknown} /></td>
                        <td><MetricValue value={model.tokens.cacheCreate} unknown={unknown} /></td>
                        <td>{model.requests}</td>
                        <td><CostValue cost={model.cost} label={costLabel} noPrice={noPrice} /></td>
                      </tr>
                    ))}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="unified-usage__cost-note">
          <strong>{t('settings.usagePage.estimated', { defaultValue: 'Estimated' })}</strong>
          <span>
            {t('settings.usagePage.costNote', {
              defaultValue: 'Amounts are estimated from local session logs and the built-in price table; models without a public price show token usage only.',
            })}
            {pricingEffectiveDate
              ? ` ${t('settings.usagePage.priceEffective', { defaultValue: 'Price table effective' })} ${pricingEffectiveDate}.`
              : ''}
          </span>
        </p>
      </section>

      <UsageProvidersPanel />
    </section>
  )
}
