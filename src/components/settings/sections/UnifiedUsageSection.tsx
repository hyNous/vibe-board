import { useCallback, useEffect, useMemo, useState } from 'react'
import { CodexUsageSection } from './CodexUsageSection'
import { SwitchAppTabs } from './switch/SwitchAppTabs'
import { SwitchUsagePanel } from './switch/SwitchUsagePanel'
import { getNetworkMonitorRequests, type NetworkRequestSummary } from '../../../services/monitorApi'
import { getUsageSnapshots, isTauri, listUsageProviders, type UsageProviderStatus } from '../../../services/tauriApi'
import { switchApi, type SwitchAppType } from '../../../services/switchApi'
import type { RateLimitInfo } from '../../../types/agent'
import { formatTokens } from '../../../utils/tokens'
import './SwitchSection.css'
import './UnifiedUsageSection.css'

type UsageView = 'overview' | 'quota' | 'token-trend' | 'breakdown'

const USAGE_VIEWS: Array<{ id: UsageView; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'quota', label: 'Quota' },
  { id: 'token-trend', label: 'Token Usage' },
  { id: 'breakdown', label: 'Breakdown' },
]

const USAGE_APP_TYPES: SwitchAppType[] = ['claude', 'codex', 'gemini', 'opencode', 'hermes']

type CoverageId = 'codex' | 'claude' | 'gemini' | 'pi' | 'opencode' | 'other'

const PROVIDER_COVERAGE: Array<{ id: CoverageId; label: string; statusProviders: string[] }> = [
  { id: 'codex', label: 'Codex', statusProviders: ['codex'] },
  { id: 'claude', label: 'Claude', statusProviders: ['claude-code', 'claude'] },
  { id: 'gemini', label: 'Gemini', statusProviders: ['gemini-cli', 'gemini'] },
  { id: 'pi', label: 'Pi', statusProviders: ['pi'] },
  { id: 'opencode', label: 'OpenCode', statusProviders: ['opencode'] },
  { id: 'other', label: 'Other', statusProviders: [] },
]

function coverageIdForProvider(provider: string): CoverageId {
  const normalized = provider.trim().toLowerCase()
  if (normalized.includes('codex')) return 'codex'
  if (normalized.includes('claude') || normalized.includes('anthropic')) return 'claude'
  if (normalized.includes('gemini') || normalized.includes('google')) return 'gemini'
  if (normalized.includes('opencode')) return 'opencode'
  if (normalized === 'pi' || normalized.startsWith('pi-')) return 'pi'
  return 'other'
}

function formatQuotaRemaining(snapshot: RateLimitInfo | null): string {
  if (!snapshot) return ''
  const windows = snapshot.windows ?? []
  if (windows.length > 0) {
    return windows.map((window) => {
      const remaining = window.remainingPercent ?? (100 - window.usedPercent)
      return `${window.title} ${Math.round(Math.max(0, Math.min(100, remaining)))}%`
    }).join(' · ')
  }
  return [
    `5h ${Math.round(Math.max(0, Math.min(100, 100 - snapshot.fiveHourUsage)))}%`,
    `7d ${Math.round(Math.max(0, Math.min(100, 100 - snapshot.sevenDayUsage)))}%`,
  ].join(' · ')
}

function findQuotaSnapshot(snapshots: RateLimitInfo[], id: CoverageId): RateLimitInfo | null {
  return snapshots.find((snapshot) => coverageIdForProvider(snapshot.provider ?? snapshot.providerLabel ?? '') === id) ?? null
}

function formatFreshness(timestamp: number | null): string {
  if (!timestamp) return '未采集'
  const age = Math.max(0, Date.now() - timestamp)
  if (age < 60_000) return '刚刚'
  if (age < 3_600_000) return `${Math.floor(age / 60_000)} 分钟前`
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)} 小时前`
  return `${Math.floor(age / 86_400_000)} 天前`
}

function usageStatusLabel(status: UsageProviderStatus | null, requests: number): string {
  if (!status) return requests > 0 ? '已采集' : '未采集'
  if (!status.enabled) return '已停用'
  if (status.available) return '可用'
  if (status.authStatus === 'missing') return '待授权'
  if (status.implementationStatus === 'unsupported') return '未接入'
  if (status.implementationStatus === 'available') return '已发现'
  return '待数据'
}

type ProviderCoverageStats = {
  id: CoverageId
  label: string
  status: UsageProviderStatus | null
  quota: RateLimitInfo | null
  requests: number
  tokens: number
  latestRequestAt: number | null
}

function ProviderCoverage({
  requests,
  statuses,
  snapshots,
  loading,
  error,
}: {
  requests: NetworkRequestSummary[]
  statuses: UsageProviderStatus[]
  snapshots: RateLimitInfo[]
  loading: boolean
  error: string
}) {
  const rows = useMemo<ProviderCoverageStats[]>(() => PROVIDER_COVERAGE.map((provider) => {
    const status = statuses.find((item) => provider.statusProviders.includes(item.provider)) ?? null
    const providerRequests = requests.filter((request) => coverageIdForProvider(request.provider) === provider.id)
    const quota = findQuotaSnapshot(snapshots, provider.id)
    return {
      id: provider.id,
      label: provider.label,
      status,
      quota,
      requests: providerRequests.length,
      tokens: providerRequests.reduce((total, request) => total + requestTokens(request), 0),
      latestRequestAt: providerRequests.reduce<number | null>(
        (latest, request) => latest == null || request.timestampMs > latest ? request.timestampMs : latest,
        null,
      ),
    }
  }), [requests, snapshots, statuses])

  return (
    <section className="unified-usage__provider-card">
      <div className="unified-usage__provider-head">
        <div>
          <h3>Provider Coverage</h3>
          <p>每个 Provider 独立显示真实 token 或 quota；没有 reader 的项目保持“未接入”，不生成估算值。</p>
        </div>
        {loading && <span className="unified-usage__provider-loading">读取中...</span>}
      </div>
      {error && <div className="unified-usage__provider-error">Provider 状态读取失败：{error}</div>}
      <div className="unified-usage__provider-table-wrap">
        <table className="unified-usage__provider-table">
          <thead>
            <tr><th>Provider</th><th>Usage</th><th>Quota</th><th>Source</th><th>Freshness</th><th>说明</th></tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const updatedAt = [row.status?.updatedAt ?? null, row.quota?.updatedAt ?? null, row.latestRequestAt]
                .filter((value): value is number => value != null)
                .reduce<number | null>((latest, value) => latest == null || value > latest ? value : latest, null)
              const detail = row.status?.detail
                ?? (row.id === 'other' ? '未匹配到已支持 Provider 的请求会归入 Other。' : '尚未发现本地用量或 quota 数据。')
              const quota = formatQuotaRemaining(row.quota) || usageStatusLabel(row.status, row.requests)
              return (
                <tr key={row.id}>
                  <td><strong>{row.label}</strong></td>
                  <td>{row.requests > 0 ? `${row.requests} · ${formatTokens(row.tokens)}` : '未采集'}</td>
                  <td>{quota || 'Unknown'}</td>
                  <td>{row.quota?.source ?? row.status?.source ?? (row.requests > 0 ? 'network monitor' : '—')}</td>
                  <td>{formatFreshness(updatedAt)}</td>
                  <td title={detail}>{detail}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function requestTokens(request: NetworkRequestSummary) {
  if (request.usageSummary?.totalTokens != null) return request.usageSummary.totalTokens
  const usage = request.usage ?? {}
  const number = (key: string) => typeof usage[key] === 'number' ? usage[key] as number : 0
  return number('input_tokens') + number('output_tokens') + number('cache_creation_input_tokens') + number('cache_read_input_tokens')
}

function todayTokens(requests: NetworkRequestSummary[]) {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  return requests
    .filter((request) => request.timestampMs >= start.getTime())
    .reduce((total, request) => total + requestTokens(request), 0)
}

function groupRequests(requests: NetworkRequestSummary[], keyFor: (request: NetworkRequestSummary) => string) {
  const groups = new Map<string, { key: string; requests: number; tokens: number }>()
  for (const request of requests) {
    const key = keyFor(request)
    const group = groups.get(key) ?? { key, requests: 0, tokens: 0 }
    group.requests += 1
    group.tokens += requestTokens(request)
    groups.set(key, group)
  }
  return Array.from(groups.values()).sort((a, b) => b.tokens - a.tokens || b.requests - a.requests)
}

function BreakdownTable({ title, rows }: { title: string; rows: Array<{ key: string; requests: number; tokens: number }> }) {
  return (
    <section className="unified-usage__breakdown-card">
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <p>暂无可用数据。</p>
      ) : (
        <table>
          <thead>
            <tr><th>维度</th><th>请求</th><th>Token</th></tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td>{row.key}</td>
                <td>{row.requests}</td>
                <td>{formatTokens(row.tokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

function UsageBreakdown({ requests }: { requests: NetworkRequestSummary[] }) {
  const dimensions = [
    ['By Agent', (request: NetworkRequestSummary) => request.requestType || 'Unknown'],
    ['By Provider', (request: NetworkRequestSummary) => request.provider || 'Unknown'],
    ['By Model', (request: NetworkRequestSummary) => request.model || 'Unknown'],
    ['By Project', (request: NetworkRequestSummary) => request.project || '未关联项目'],
    ['By Task', () => '未关联任务'],
  ] as Array<[string, (request: NetworkRequestSummary) => string]>

  return (
    <>
      <div className="unified-usage__source-note">
        Breakdown 使用本地网络抓包中的真实 request/usage；Task 只有在事件带任务关联时才会细分，当前未关联的请求会明确归入“未关联任务”。
      </div>
      <div className="unified-usage__breakdown-grid">
        {dimensions.map(([title, keyFor]) => <BreakdownTable key={title} title={title} rows={groupRequests(requests, keyFor)} />)}
      </div>
    </>
  )
}

export function UnifiedUsageSection() {
  const [view, setView] = useState<UsageView>('overview')
  const [requests, setRequests] = useState<NetworkRequestSummary[]>([])
  const [error, setError] = useState('')
  const [providerStatuses, setProviderStatuses] = useState<UsageProviderStatus[]>([])
  const [providerError, setProviderError] = useState('')
  const [providerLoading, setProviderLoading] = useState(false)
  const [todayUsage, setTodayUsage] = useState<{ tokens: number } | null>(null)
  const [quotaSnapshots, setQuotaSnapshots] = useState<RateLimitInfo[]>([])

  const loadRequests = useCallback(async () => {
    if (!isTauri()) {
      setRequests([])
      setProviderStatuses([])
      setTodayUsage(null)
      setQuotaSnapshots([])
      return
    }
    setProviderLoading(true)
    setError('')
    setProviderError('')
    try {
      const [networkResult, providerResult, usageResult, quotaResult] = await Promise.allSettled([
        getNetworkMonitorRequests(),
        listUsageProviders(false),
        Promise.all(USAGE_APP_TYPES.map((appType) => switchApi.getUsageSummary(appType, 1))),
        getUsageSnapshots(),
      ])
      if (networkResult.status === 'fulfilled') setRequests(networkResult.value)
      else setError(String(networkResult.reason))
      if (providerResult.status === 'fulfilled') setProviderStatuses(providerResult.value)
      else setProviderError(String(providerResult.reason))
      if (usageResult.status === 'fulfilled') {
        setTodayUsage({
          tokens: usageResult.value.reduce((total, summary) => total + summary.total_input_tokens + summary.total_output_tokens, 0),
        })
      } else {
        setTodayUsage(null)
      }
      setQuotaSnapshots(quotaResult.status === 'fulfilled' ? quotaResult.value : [])
    } finally {
      setProviderLoading(false)
    }
  }, [])

  useEffect(() => {
    const id = window.setTimeout(() => {
      void loadRequests()
    }, 0)
    return () => window.clearTimeout(id)
  }, [loadRequests])

  const providers = useMemo(
    () => new Set(requests.map((request) => request.provider).filter(Boolean)),
    [requests],
  )
  const liveTokens = todayTokens(requests)
  const persistedTokens = todayUsage?.tokens ?? 0
  const tokensToday = persistedTokens > 0 ? persistedTokens : liveTokens
  const quotaSummary = quotaSnapshots
    .map((snapshot) => {
      const label = snapshot.providerLabel ?? snapshot.provider ?? 'Provider'
      const remaining = formatQuotaRemaining(snapshot)
      return remaining ? `${label} ${remaining}` : ''
    })
    .filter(Boolean)
    .join(' / ')

  return (
    <section className="unified-usage">
      <header className="agent-monitor__header">
        <div>
          <h2>Usage</h2>
          <p>统一查看 Provider token 用量与当前 quota；没有真实数据时保持 Unknown。</p>
        </div>
        <button type="button" className="agent-monitor__refresh" disabled={providerLoading} onClick={() => void loadRequests()}>刷新用量</button>
      </header>

      <div className="unified-usage__tabs" role="tablist" aria-label="Usage views">
        {USAGE_VIEWS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={view === item.id}
            className={view === item.id ? 'unified-usage__tab unified-usage__tab--active' : 'unified-usage__tab'}
            onClick={() => setView(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {error && <div className="unified-usage__error">网络用量读取失败：{error}</div>}

      {view === 'overview' && (
        <>
          <div className="unified-usage__summary">
            <div><span>{tokensToday > 0 ? 'Tokens Today' : 'Quota Remaining'}</span><strong>{tokensToday > 0 ? formatTokens(tokensToday) : quotaSummary || 'Unknown'}</strong><em>{tokensToday > 0 ? (persistedTokens > 0 ? 'local usage_logs' : 'network monitor') : 'provider usage reader'}</em></div>
            <div><span>Active Providers</span><strong>{providers.size > 0 ? providers.size : '未采集'}</strong><em>当前请求来源</em></div>
          </div>
          <ProviderCoverage requests={requests} statuses={providerStatuses} snapshots={quotaSnapshots} loading={providerLoading} error={providerError} />
          <CodexUsageSection showHeader={false} />
        </>
      )}

      {view === 'quota' && (
        <>
          <ProviderCoverage requests={requests} statuses={providerStatuses} snapshots={quotaSnapshots} loading={providerLoading} error={providerError} />
          <CodexUsageSection showHeader={false} />
        </>
      )}
      {view === 'token-trend' && (
        <div className="unified-usage__panel">
          <p className="unified-usage__panel-note">能读取 token 时展示真实 token；没有 token 时只展示 Provider quota 剩余值。</p>
          <SwitchAppTabs />
          <SwitchUsagePanel />
          <CodexUsageSection showHeader={false} />
        </div>
      )}
      {view === 'breakdown' && (
        <div className="unified-usage__panel">
          <SwitchAppTabs />
          <UsageBreakdown requests={requests} />
        </div>
      )}
    </section>
  )
}
