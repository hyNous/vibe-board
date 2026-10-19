import { Fragment, useCallback, useEffect, useState } from 'react'
import { isListedUsageProvider, useSettingsLive } from '../../../stores/settingsLiveStore'
import { useTranslation } from 'react-i18next'
import { UsageProvidersPanel } from './UsageProvidersPanel'
import { Segmented } from '../Segmented'
import { SettingDetails } from '../SettingDetails'
import {
  getUsageHistoryScanStatus,
  isTauri,
  startUsageHistoryScan,
  type UsageCost,
  type UsageHistoryScanStatus,
  type UsagePeriod,
  type UsageSnapshot,
  type UsageTokens,
} from '../../../services/tauriApi'
import type { UsageRateWindow } from '../../../types/agent'
import { formatTokens, formatUsageCost } from '../../../utils/tokens'
import './UnifiedUsageSection.css'

type UsagePeriodId = 'today' | 'week' | 'month'

// 额度低于这个百分比时，额度条转成珊瑚红。
const LOW_QUOTA_PERCENT = 25

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

function windowRemainingPercent(window: UsageRateWindow): number | undefined {
  const raw = typeof window.remainingPercent === 'number' && Number.isFinite(window.remainingPercent)
    ? window.remainingPercent
    : typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent)
      ? 100 - window.usedPercent
      : undefined
  if (raw === undefined) return undefined
  return Math.max(0, Math.min(100, raw))
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

// 一条额度条只画一个百分比：取各窗口里最紧张的那个。
function primaryRemaining(snapshot: UsageSnapshot): number | null {
  const values = snapshot.windows
    .map(windowRemainingPercent)
    .filter((value): value is number => value !== undefined)
  return values.length > 0 ? Math.min(...values) : null
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

// 状态点只用允许的颜色：黑白灰、运行中亮蓝、珊瑚红。
function stateDotModifier(snapshot: UsageSnapshot): string {
  if (snapshot.state === 'ok') return 'usage-quota__dot--ok'
  if (snapshot.state === 'failed') return 'usage-quota__dot--failed'
  return 'usage-quota__dot--idle'
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
  if (!cost) return <span className="usage-table__cost-none" title={noPrice} aria-label={noPrice}>—</span>
  return (
    <>
      {cost.complete ? '' : '≥ '}
      {formatUsageCost(cost.amount, cost.currency)}
      <span className="usage-table__cost-estimate" title={label}>
        {' '}
        {label}
      </span>
    </>
  )
}

export function UnifiedUsageSection() {
  const { t } = useTranslation()
  const unknown = t('settings.usagePage.unknown', { defaultValue: '未知' })
  // 额度由设置窗口在后台持续刷新（settingsLiveStore），切回这页时直接显示上次的结果。
  const dashboard = useSettingsLive((state) => state.usageDashboard)
  const loading = useSettingsLive((state) => state.usageLoading)
  const usageError = useSettingsLive((state) => state.usageError)
  const loadUsage = useSettingsLive((state) => state.refreshUsage)
  const [scanError, setError] = useState('')
  const error = scanError || (usageError ? readableError(usageError) : '')
  const [period, setPeriod] = useState<UsagePeriodId>('today')
  const [scan, setScan] = useState<UsageHistoryScanStatus | null>(null)

  const startScan = useCallback(async () => {
    if (!isTauri()) return
    try {
      await startUsageHistoryScan()
    } catch (err) {
      setError(readableError(err))
    }
  }, [])

  useEffect(() => {
    // 先显示已有结果，同时补一次刷新。
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

  // 只列出本机检测到、且 Vibe Board 真能读到额度的工具。
  const providers = (dashboard?.providers ?? []).filter(isListedUsageProvider)
  const pricingEffectiveDate = dashboard?.pricingEffectiveDate
    ?? providers
      .map((provider) => provider.history.pricingEffectiveDate)
      .find((date): date is string => Boolean(date))
  const costLabel = t('settings.usagePage.estimatedShort', { defaultValue: '估算' })
  const noPrice = t('settings.usagePage.noPrice', { defaultValue: '没有公开价格，只统计 token' })

  return (
    <section className="unified-usage">
      <header className="unified-usage__head">
        <div>
          <h1 className="unified-usage__title">
            {t('settings.usagePage.title', { defaultValue: '额度与用量' })}
          </h1>
          <p>
            {t('settings.usagePage.subtitle', {
              defaultValue: '看看每个工具还能用多少、最近用掉了多少。这里只做统计，不改动任何东西。',
            })}
          </p>
        </div>
        <div className="unified-usage__acts">
          <button
            type="button"
            className="vb-btn"
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
        </div>
      </header>

      {error && (
        <div className="unified-usage__error" role="alert">
          <span>
            {t('settings.usagePage.loadFailed', { defaultValue: '额度没能读取成功，请稍后点「刷新」重试。' })}
          </span>
          <SettingDetails testId="usage-error-details">{error}</SettingDetails>
        </div>
      )}

      <section className="unified-usage__block" data-testid="usage-now">
        <div className="unified-usage__group-title">
          <span>{t('settings.usagePage.nowTitle', { defaultValue: '现在还能用多少' })}</span>
          {loading && (
            <em className="unified-usage__querying">
              {providers.some((provider) => provider.networkSupported && provider.networkAuthorized)
                ? t('settings.usageNetworkQuerying', { defaultValue: '正在查询…' })
                : t('settings.detecting', { defaultValue: '正在检查…' })}
            </em>
          )}
        </div>
        <div className="unified-usage__panel">
          {providers.length === 0 ? (
            <div className="unified-usage__empty">
              {t('settings.usagePage.noProviders', {
                defaultValue: '还没有可显示的数据。开启某个工具的查询后，这里会出现它的额度。',
              })}
            </div>
          ) : (
            <table className="usage-quota">
              <tbody>
                {providers.map((snapshot) => {
                  const remaining = primaryRemaining(snapshot)
                  const low = remaining !== null && remaining < LOW_QUOTA_PERCENT
                  return (
                    <tr className="usage-quota__row" key={snapshot.provider}>
                      <td className="usage-quota__name">
                        <b>{snapshot.label}</b>
                        <span className="usage-quota__state">
                          <i className={`usage-quota__dot ${stateDotModifier(snapshot)}`} aria-hidden="true" />
                          <span>{stateLabel(t, snapshot)}</span>
                        </span>
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
                      <td className="usage-quota__meter">
                        {remaining !== null && (
                          <span className={`usage-quota__track${low ? ' usage-quota__track--low' : ''}`}>
                            <span style={{ width: `${remaining}%` }} />
                          </span>
                        )}
                        <span className={remaining !== null ? 'usage-quota__windows' : 'usage-quota__na'}>
                          {remainingText(snapshot, unknown)}
                        </span>
                      </td>
                      <td className={`usage-quota__big${remaining === null ? ' usage-quota__big--dim' : ''}`}>
                        {remaining !== null
                          ? <>{Math.round(remaining)}<small>%</small></>
                          : <span className="usage-quota__na">—</span>}
                      </td>
                      <td className="usage-quota__when">
                        <span>{resetText(snapshot, unknown)}</span>
                        <small>{formatFreshness(t, snapshot.fetchedAt)}</small>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <UsageProvidersPanel />

      <section className="unified-usage__block unified-usage__cost" data-testid="usage-cost">
        <div className="unified-usage__tabs-row">
          <div className="unified-usage__group-title">
            <span>{t('settings.usagePage.usedTitle', { defaultValue: '用掉了多少' })}</span>
          </div>
          <div className="unified-usage__cost-actions">
            {scan?.scanning && (
              <span className="unified-usage__querying" data-testid="usage-scan-progress">
                {t('settings.usagePage.scanning', { defaultValue: '正在统计用量…' })}
              </span>
            )}
            <Segmented
              value={period}
              ariaLabel={t('settings.usagePage.usageCostTitle', { defaultValue: '用量与花费' })}
              options={USAGE_PERIODS.map((item) => ({
                value: item.id,
                label: t(item.labelKey, { defaultValue: item.defaultLabel }),
              }))}
              onChange={setPeriod}
            />
          </div>
        </div>

        {scan?.error && (
          <div className="unified-usage__error" data-testid="usage-scan-error">
            <span>{t('settings.usagePage.scanFailed', { defaultValue: '用量统计没能完成，请稍后重试。' })}</span>
            <SettingDetails testId="usage-scan-error-details">{scan.error}</SettingDetails>
          </div>
        )}

        <div className="unified-usage__panel unified-usage__panel--table">
          <table className="usage-table">
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
                      <td className="usage-table__provider">
                        <b>{snapshot.label}</b>
                        {historyDetail && (
                          <SettingDetails testId={`usage-history-details-${snapshot.provider}`}>
                            <p>{historyDetail}</p>
                          </SettingDetails>
                        )}
                        {entry && entry.unpricedModels.length > 0 && (
                          <span className="usage-table__detail">
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
                      <td className="usage-table__cost">
                        <CostValue cost={entry?.cost ?? null} label={costLabel} noPrice={noPrice} />
                      </td>
                    </tr>
                    {entry?.models.map((model) => (
                      <tr
                        key={`${snapshot.provider}:${model.model}`}
                        className="usage-table__model-row"
                        data-testid={`usage-model-${model.model}`}
                      >
                        <td><span className="usage-table__model-name">{model.model}</span></td>
                        <td><MetricValue value={tokenTotal(model.tokens)} unknown={unknown} /></td>
                        <td><MetricValue value={model.tokens.input} unknown={unknown} /></td>
                        <td><MetricValue value={model.tokens.output} unknown={unknown} /></td>
                        <td><MetricValue value={model.tokens.cacheRead} unknown={unknown} /></td>
                        <td><MetricValue value={model.tokens.cacheCreate} unknown={unknown} /></td>
                        <td>{model.requests}</td>
                        <td className="usage-table__cost">
                          <CostValue cost={model.cost} label={costLabel} noPrice={noPrice} />
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>

        <p className="unified-usage__foot-note">
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
    </section>
  )
}
