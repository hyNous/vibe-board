import { useCallback, useEffect, useMemo, useState } from 'react'
import { CodexUsageSection } from './CodexUsageSection'
import { getAgentStatuses, getUsageSnapshots, isTauri, listUsageProviders, type UsageProviderStatus } from '../../../services/tauriApi'
import type { AgentStatusSnapshot, RateLimitInfo } from '../../../types/agent'
import { formatTokens } from '../../../utils/tokens'
import './UnifiedUsageSection.css'

type UsageView = 'overview' | 'quota' | 'token-trend'

const USAGE_VIEWS: Array<{ id: UsageView; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'quota', label: 'Quota' },
  { id: 'token-trend', label: 'Token Usage' },
]

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

function usageStatusLabel(status: UsageProviderStatus | null): string {
  if (!status) return '未采集'
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
  primary: boolean
  quota: RateLimitInfo | null
  tokens: number
  tokenUpdatedAt: number | null
}

function ProviderCoverage({
  statuses,
  snapshots,
  agentStatuses,
  loading,
  error,
}: {
  statuses: UsageProviderStatus[]
  snapshots: RateLimitInfo[]
  agentStatuses: AgentStatusSnapshot[]
  loading: boolean
  error: string
}) {
  const rows = useMemo<ProviderCoverageStats[]>(() => PROVIDER_COVERAGE.map((provider) => {
    const status = statuses.find((item) => provider.statusProviders.includes(item.provider)) ?? null
    const quota = findQuotaSnapshot(snapshots, provider.id)
    const matchingAgents = agentStatuses.filter((item) => coverageIdForProvider(item.agent) === provider.id)
    // `AgentStatusSnapshot.tokens` is overwritten with the agent's most recent
    // session each time that session reports, so this sums one last-known
    // session per agent — never an all-session or per-day total.
    const tokens = matchingAgents.reduce((total, item) => total + item.tokens.input + item.tokens.output + item.tokens.cacheRead + item.tokens.cacheCreate, 0)
    const tokenUpdatedAt = matchingAgents.reduce<number | null>(
      (latest, item) => latest == null || item.lastSeenAt > latest ? item.lastSeenAt : latest,
      null,
    )
    return {
      id: provider.id,
      label: provider.label,
      status,
      primary: status?.primary ?? false,
      quota,
      tokens,
      tokenUpdatedAt,
    }
  }).sort((a, b) => Number(b.primary) - Number(a.primary)), [agentStatuses, snapshots, statuses])

  return (
    <section className="unified-usage__provider-card">
      <div className="unified-usage__provider-head">
        <div>
          <h3>Provider Coverage</h3>
          <p>
            每个 Provider 独立显示真实 token 或 quota。Usage 列是该 Provider 下每个 Agent
            <strong>最近一次会话</strong>的 token 之和，不是当天或历史全部会话的累计；安装插件并启动宿主 Agent
            后，宿主会标记为“宿主”，子 Agent 数据保持不变。
          </p>
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
              const updatedAt = [row.status?.updatedAt ?? null, row.quota?.updatedAt ?? null, row.tokenUpdatedAt]
                .filter((value): value is number => value != null)
                .reduce<number | null>((latest, value) => latest == null || value > latest ? value : latest, null)
              const detail = row.status?.detail
                ?? (row.id === 'other' ? '未匹配到已支持 Provider 的请求会归入 Other。' : '尚未发现本地用量或 quota 数据。')
              const usage = row.tokens > 0 ? `${formatTokens(row.tokens)} tok` : usageStatusLabel(row.status)
              const quota = formatQuotaRemaining(row.quota) || usageStatusLabel(row.status)
              return (
                <tr key={row.id}>
                  <td>
                    <strong>{row.label}</strong>
                    {row.primary && <span className="unified-usage__provider-badge">宿主</span>}
                  </td>
                  <td>{usage}</td>
                  <td>{quota || 'Unknown'}</td>
                  <td>{row.quota?.source ?? row.status?.source ?? (row.tokens > 0 ? 'last session tokens' : '—')}</td>
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

export function UnifiedUsageSection() {
  const [view, setView] = useState<UsageView>('overview')
  const [providerStatuses, setProviderStatuses] = useState<UsageProviderStatus[]>([])
  const [providerError, setProviderError] = useState('')
  const [providerLoading, setProviderLoading] = useState(false)
  const [quotaSnapshots, setQuotaSnapshots] = useState<RateLimitInfo[]>([])
  const [agentStatuses, setAgentStatuses] = useState<AgentStatusSnapshot[]>([])

  const loadUsage = useCallback(async () => {
    if (!isTauri()) {
      setProviderStatuses([])
      setQuotaSnapshots([])
      setAgentStatuses([])
      return
    }
    setProviderLoading(true)
    setProviderError('')
    try {
      const [providerResult, quotaResult, agentResult] = await Promise.allSettled([
        listUsageProviders(false),
        getUsageSnapshots(),
        getAgentStatuses(),
      ])
      if (providerResult.status === 'fulfilled') setProviderStatuses(providerResult.value)
      else setProviderError(String(providerResult.reason))
      setQuotaSnapshots(quotaResult.status === 'fulfilled' ? quotaResult.value : [])
      setAgentStatuses(agentResult.status === 'fulfilled' ? agentResult.value : [])
    } finally {
      setProviderLoading(false)
    }
  }, [])

  useEffect(() => {
    const id = window.setTimeout(() => {
      void loadUsage()
    }, 0)
    return () => window.clearTimeout(id)
  }, [loadUsage])

  const availableProviders = providerStatuses.filter((status) => status.available).length
  // Sum of each agent's last known session, not a daily or all-session total.
  const lastSessionTokenTotal = agentStatuses.reduce(
    (total, status) => total + status.tokens.input + status.tokens.output + status.tokens.cacheRead + status.tokens.cacheCreate,
    0,
  )
  const quotaSummary = quotaSnapshots
    .map((snapshot) => {
      const label = snapshot.providerLabel ?? snapshot.provider ?? 'Provider'
      const remaining = formatQuotaRemaining(snapshot)
      return remaining ? `${label} ${remaining}` : ''
    })
    .filter(Boolean)
    .join(' / ')
  const primaryProvider = providerStatuses.find((status) => status.primary) ?? null
  const primaryQuotaSummary = primaryProvider
    ? quotaSnapshots
      .filter((snapshot) => coverageIdForProvider(snapshot.provider ?? snapshot.providerLabel ?? '') === coverageIdForProvider(primaryProvider.provider))
      .map((snapshot) => formatQuotaRemaining(snapshot))
      .filter(Boolean)
      .join(' / ')
    : ''
  const headlineQuota = primaryQuotaSummary || quotaSummary

  return (
    <section className="unified-usage">
      <header className="agent-monitor__header">
        <div>
          <h2>Usage</h2>
          <p>统一查看每个 Agent 最近一次会话的真实 token 与当前 quota；没有真实数据时保持 Unknown。</p>
        </div>
        <button type="button" className="agent-monitor__refresh" disabled={providerLoading} onClick={() => void loadUsage()}>刷新用量</button>
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

      {providerError && <div className="unified-usage__error">Provider 状态读取失败：{providerError}</div>}

      {view === 'overview' && (
        <>
          <div className="unified-usage__summary">
            <div><span>{lastSessionTokenTotal > 0 ? 'Last Session Tokens' : primaryProvider ? 'Host Quota Remaining' : 'Quota Remaining'}</span><strong>{lastSessionTokenTotal > 0 ? formatTokens(lastSessionTokenTotal) : headlineQuota || 'Unknown'}</strong><em>{lastSessionTokenTotal > 0 ? '每个 Agent 最近一次会话之和' : primaryProvider?.label ?? 'provider usage reader'}</em></div>
            <div><span>Active Providers</span><strong>{providerStatuses.length > 0 ? `${availableProviders} / ${providerStatuses.length}` : '未采集'}</strong><em>可用 Provider / 已登记</em></div>
            <div><span>Plugin Host</span><strong>{primaryProvider?.label ?? '未绑定'}</strong><em>{primaryProvider ? '最近一次宿主会话' : '启动已安装插件的 Agent 后自动绑定'}</em></div>
          </div>
          <ProviderCoverage statuses={providerStatuses} snapshots={quotaSnapshots} agentStatuses={agentStatuses} loading={providerLoading} error={providerError} />
          <CodexUsageSection showHeader={false} />
        </>
      )}

      {view === 'quota' && (
        <>
          <ProviderCoverage statuses={providerStatuses} snapshots={quotaSnapshots} agentStatuses={agentStatuses} loading={providerLoading} error={providerError} />
          <CodexUsageSection showHeader={false} />
        </>
      )}
      {view === 'token-trend' && (
        <div className="unified-usage__panel">
          <p className="unified-usage__panel-note">能读取 token 时展示真实 token：Codex 用量来自本地 rollout 聚合，其他 Agent 来自 Hook 会话累计；没有 token 时只展示 Provider quota 剩余值。</p>
          <CodexUsageSection showHeader={false} />
        </div>
      )}
    </section>
  )
}
