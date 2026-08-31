import { useCallback, useEffect, useMemo, useState } from 'react'
import { CodexUsageSection } from './CodexUsageSection'
import { SwitchAppTabs } from './switch/SwitchAppTabs'
import { SwitchUsagePanel } from './switch/SwitchUsagePanel'
import { getNetworkMonitorRequests, type NetworkRequestSummary } from '../../../services/monitorApi'
import { isTauri } from '../../../services/tauriApi'
import { formatTokens } from '../../../utils/tokens'
import './SwitchSection.css'
import './UnifiedUsageSection.css'

type UsageView = 'overview' | 'quota' | 'token-trend' | 'cost' | 'breakdown'

const USAGE_VIEWS: Array<{ id: UsageView; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'quota', label: 'Quota' },
  { id: 'token-trend', label: 'Token Trend' },
  { id: 'cost', label: 'Cost' },
  { id: 'breakdown', label: 'Breakdown' },
]

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

  const loadRequests = useCallback(async () => {
    if (!isTauri()) return
    try {
      setError('')
      setRequests(await getNetworkMonitorRequests())
    } catch (err) {
      setError(String(err))
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

  return (
    <section className="unified-usage">
      <header className="agent-monitor__header">
        <div>
          <h2>Usage</h2>
          <p>统一查看 Codex quota、Token 趋势、API 费用和 Agent/Provider/Project/Task 分布。</p>
        </div>
        <button type="button" className="agent-monitor__refresh" onClick={() => void loadRequests()}>刷新用量</button>
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
            <div><span>Tokens Today</span><strong>{todayTokens(requests) > 0 ? formatTokens(todayTokens(requests)) : '未采集'}</strong><em>网络抓包来源</em></div>
            <div><span>Actual API Cost</span><strong>—</strong><em>官方 billing 尚未接入</em></div>
            <div><span>Equivalent API Cost</span><strong>—</strong><em>订阅等价估算尚未接入</em></div>
            <div><span>Active Providers</span><strong>{providers.size > 0 ? providers.size : '未采集'}</strong><em>当前请求来源</em></div>
          </div>
          <CodexUsageSection showHeader={false} />
        </>
      )}

      {view === 'quota' && <CodexUsageSection showHeader={false} />}
      {view === 'token-trend' && (
        <div className="unified-usage__panel">
          <p className="unified-usage__panel-note">Codex 当前以 Today / 7d / 30d 聚合展示；没有采集到的字段保持 Unknown。</p>
          <CodexUsageSection showHeader={false} />
        </div>
      )}
      {view === 'cost' && (
        <div className="unified-usage__panel">
          <div className="unified-usage__cost-note">
            <strong>Recorded API Cost</strong>
            <span>来自本地 usage_logs；官方实际账单与订阅等价成本仍分别显示为 Unknown。</span>
          </div>
          <SwitchAppTabs />
          <SwitchUsagePanel />
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
