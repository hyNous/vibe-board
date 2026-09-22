import { Fragment, useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { UsageProvidersPanel } from './UsageProvidersPanel'
import { SettingDetails } from '../SettingDetails'
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
  { id: 'today', labelKey: 'settings.usagePage.periodToday', defaultLabel: '今天' },
  { id: 'week', labelKey: 'settings.usagePage.periodWeek', defaultLabel: '本周' },
  { id: 'month', labelKey: 'settings.usagePage.periodMonth', defaultLabel: '本月' },
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
  const unknown = t('settings.usagePage.unknown', { defaultValue: '未知' })
  if (!timestamp) return unknown
  const age = Math.max(0, Date.now() - timestamp)
  if (age < 60_000) return t('settings.usagePage.justNow', { defaultValue: '刚刚' })
  if (age < 3_600_000) {
    return t('settings.usagePage.minutesAgo', { defaultValue: '{{count}} 分钟前', count: Math.floor(age / 60_000) })
      .replace('{{count}}', String(Math.floor(age / 60_000)))
  }
  if (age < 86_400_000) {
    return t('settings.usagePage.hoursAgo', { defaultValue: '{{count}} 小时前', count: Math.floor(age / 3_600_000) })
      .replace('{{count}}', String(Math.floor(age / 3_600_000)))
  }
  return t('settings.usagePage.daysAgo', { defaultValue: '{{count}} 天前', count: Math.floor(age / 86_400_000) })
    .replace('{{count}}', String(Math.floor(age / 86_400_000)))
}

function stateLabel(t: Translate, snapshot: UsageSnapshot): string {
  if (snapshot.state === 'ok') return t('settings.usagePage.stateOk', { defaultValue: '已获取' })
  if (snapshot.state === 'disabled') return t('settings.usagePage.stateOff', { defaultValue: '已关闭查询' })
  if (snapshot.networkSupported && !snapshot.networkAuthorized) {
    return t('settings.usagePage.stateNotAuthorized', { defaultValue: '未开启联网查询' })
  }
  switch (snapshot.state) {
    case 'unauthorized':
      return t('settings.usagePage.stateNeedsLogin', { defaultValue: '需要先登录' })
    case 'failed':
      return t('settings.usagePage.stateFailed', { defaultValue: '查询失败，稍后重试' })
    case 'unsupported':
      return t('settings.usagePage.stateUnsupported', { defaultValue: '暂不支持查询' })
    default:
      return t('settings.usagePage.stateWaiting', { defaultValue: '正在查询' })
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
  const unknown = t('settings.usagePage.unknown', { defaultValue: '未知' })
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
  const costLabel = t('settings.usagePage.estimatedShort', { defaultValue: '估算' })
  const noPrice = t('settings.usagePage.noPrice', { defaultValue: '没有公开价格，只统计 token' })

  return (
    <section className="unified-usage">
      <header className="agent-monitor__header">
        <div>
          <h2>{t('settings.usage', { defaultValue: 'Usage' })}</h2>
          <p>{t('settings.usagePage.subtitle', { defaultValue: '看看每个工具还能用多少、最近用掉了多少。这里只做统计，不改动任何东西。' })}</p>
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
          {loading
            ? t('settings.refreshing', { defaultValue: '正在刷新…' })
            : t('settings.refresh', { defaultValue: '刷新' })}
        </button>
      </header>

      {error && (
        <div className="unified-usage__error" role="alert">
          <div>{t('settings.usagePage.loadFailed', { defaultValue: '额度没能读取成功，请稍后点「刷新」重试。' })}</div>
          <SettingDetails testId="usage-error-details">{error}</SettingDetails>
        </div>
      )}

      <section className="unified-usage__provider-card" data-testid="usage-now">
        <div className="unified-usage__provider-head">
          <div>
            <h3>{t('settings.usagePage.nowTitle', { defaultValue: '现在还能用多少' })}</h3>
            <p>{t('settings.usagePage.nowDesc', { defaultValue: '每个工具的剩余额度、恢复时间，以及数据是什么时候取的。' })}</p>
          </div>
          {loading && (
            <span className="unified-usage__provider-loading">
              {providers.some((provider) => provider.networkSupported && provider.networkAuthorized)
                ? t('settings.usageNetworkQuerying', { defaultValue: '正在查询…' })
                : t('settings.detecting', { defaultValue: '正在检查…' })}
            </span>
          )}
        </div>
        {providers.length === 0 ? (
          <div className="hook-empty">{t('settings.usagePage.noProviders', { defaultValue: '还没有可显示的数据。开启某个工具的查询后，这里会出现它的额度。' })}</div>
        ) : (
          <div className="unified-usage__provider-table-wrap">
            <table className="unified-usage__provider-table">
              <thead>
                <tr>
                  <th>{t('settings.usagePage.provider', { defaultValue: '工具' })}</th>
                  <th>{t('settings.usagePage.remaining', { defaultValue: '剩余额度' })}</th>
                  <th>{t('settings.usagePage.resetAt', { defaultValue: '恢复时间' })}</th>
                  <th>{t('settings.usagePage.freshness', { defaultValue: '更新时间' })}</th>
                  <th>{t('settings.usagePage.status', { defaultValue: '状态' })}</th>
                </tr>
              </thead>
              <tbody>
                {providers.map((snapshot) => (
                  <tr key={snapshot.provider}>
                    <td>
                      <strong>{snapshot.label}</strong>
                      <SettingDetails testId={`usage-provider-details-${snapshot.provider}`}>
                        <div className="setting-details__row">
                          <span>{t('settings.usagePage.source', { defaultValue: '数据来源' })}</span>
                          <code>{snapshot.source ?? unknown}</code>
                        </div>
                        {snapshot.detail && (
                          <div className="setting-details__row">
                            <span>{t('settings.usagePage.rawDetail', { defaultValue: '原始说明' })}</span>
                            <code>{snapshot.detail}</code>
                          </div>
                        )}
                      </SettingDetails>
                    </td>
                    <td>{remainingText(snapshot, unknown)}</td>
                    <td>{resetText(snapshot, unknown)}</td>
                    <td>{formatFreshness(t, snapshot.fetchedAt)}</td>
                    <td>
                      <strong>{stateLabel(t, snapshot)}</strong>
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
            <h3>{t('settings.usagePage.usageCostTitle', { defaultValue: '用量与花费' })}</h3>
            <p>{t('settings.usagePage.usageCostDesc', { defaultValue: '按今天 / 本周 / 本月统计用掉的 token，并给出估算花费。' })}</p>
          </div>
          <div className="unified-usage__cost-head">
            {scan?.scanning && (
              <span className="unified-usage__provider-loading" data-testid="usage-scan-progress">
                {t('settings.usagePage.scanning', { defaultValue: '正在统计用量…' })}
              </span>
            )}
            <div className="unified-usage__tabs unified-usage__tabs--inline" role="tablist" aria-label={t('settings.usagePage.usageCostTitle', { defaultValue: '用量与花费' })}>
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
            <div>{t('settings.usagePage.scanFailed', { defaultValue: '用量统计没能完成，请稍后重试。' })}</div>
            <SettingDetails testId="usage-scan-error-details">{scan.error}</SettingDetails>
          </div>
        )}
        <div className="unified-usage__provider-table-wrap">
          <table className="unified-usage__provider-table">
            <thead>
              <tr>
                <th>{t('settings.usagePage.provider', { defaultValue: '工具' })}</th>
                <th>{t('settings.usagePage.tokens', { defaultValue: 'Token' })}</th>
                <th>{t('settings.usagePage.input', { defaultValue: '输入' })}</th>
                <th>{t('settings.usagePage.output', { defaultValue: '输出' })}</th>
                <th>{t('settings.usagePage.cacheRead', { defaultValue: '缓存读取' })}</th>
                <th>{t('settings.usagePage.cacheWrite', { defaultValue: '缓存写入' })}</th>
                <th>{t('settings.usagePage.requests', { defaultValue: '请求数' })}</th>
                <th>{t('settings.usagePage.costEstimatedHeader', { defaultValue: '估算花费' })}</th>
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
                    ? t('settings.usagePage.sessionsScanned', { defaultValue: '已扫描 {{count}} 个会话文件', count: snapshot.history.sessionsScanned })
                      .replace('{{count}}', String(snapshot.history.sessionsScanned))
                    : null,
                  snapshot.history.tokenEvents != null
                    ? t('settings.usagePage.tokenEvents', { defaultValue: '{{count}} 条用量记录', count: snapshot.history.tokenEvents })
                      .replace('{{count}}', String(snapshot.history.tokenEvents))
                    : null,
                ].filter(Boolean).join(' · ')
                return (
                  <Fragment key={snapshot.provider}>
                    <tr>
                      <td>
                        <strong>{snapshot.label}</strong>
                        {historyDetail && (
                          <SettingDetails testId={`usage-history-details-${snapshot.provider}`}>
                            <p>{historyDetail}</p>
                          </SettingDetails>
                        )}
                        {entry && entry.unpricedModels.length > 0 && (
                          <span className="unified-usage__detail">
                            {t('settings.usagePage.unpricedModels', { defaultValue: '只统计 token（没有公开价格）' })}: {entry.unpricedModels.join(', ')}
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
          <strong>{t('settings.usagePage.estimated', { defaultValue: '估算' })}</strong>
          <span>
            {t('settings.usagePage.costNote', {
              defaultValue: '金额按本地会话记录和内置价格表估算，仅供参考；没有公开价格的模型只统计 token，不显示金额。',
            })}
            {pricingEffectiveDate
              ? ` ${t('settings.usagePage.priceEffective', { defaultValue: '价格表生效日期' })} ${pricingEffectiveDate}。`
              : ''}
          </span>
        </p>
      </section>

      <UsageProvidersPanel />
    </section>
  )
}
