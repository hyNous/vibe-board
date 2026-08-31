import { useCallback, useEffect, useState } from 'react'
import { useSwitchStore } from '../../../../stores/switchStore'
import type { UsageSummary, ProviderUsage, ModelUsage } from '../../../../services/switchApi'
import { switchApi } from '../../../../services/switchApi'
import { formatTokens } from '../../../../utils/tokens'

const PERIOD_OPTIONS = [
  { label: 'Today', days: 1 },
  { label: '7 天', days: 7 },
  { label: '30 天', days: 30 },
]

function formatRecordedAt(timestamp?: number | null): string {
  if (!timestamp) return ''
  const date = new Date(timestamp * 1000)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function SwitchUsagePanel() {
  const { activeAppType } = useSwitchStore()
  const [days, setDays] = useState(30)
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [byProvider, setByProvider] = useState<ProviderUsage[]>([])
  const [byModel, setByModel] = useState<ModelUsage[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const loadData = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [s, p, m] = await Promise.all([
        switchApi.getUsageSummary(activeAppType, days),
        switchApi.getUsageByProvider(activeAppType, days),
        switchApi.getUsageByModel(activeAppType, days),
      ])
      setSummary(s)
      setByProvider(p)
      setByModel(m)
    } catch (err) {
      setError(String(err))
    }
    setLoading(false)
  }, [activeAppType, days])

  useEffect(() => {
    const id = window.setTimeout(() => {
      void loadData()
    }, 0)
    return () => window.clearTimeout(id)
  }, [loadData])

  const hasUsage = summary != null && summary.total_requests > 0

  return (
    <div>
      <div className="switch-usage-panel__header">
        <h3>用量统计</h3>
        <div className="switch-usage-period">
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.days}
              type="button"
              className={`switch-app-tab${days === opt.days ? ' switch-app-tab--active' : ''}`}
              onClick={() => setDays(opt.days)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {loading && <div className="switch-loading">加载中...</div>}
      {error && <div className="switch-error">用量读取失败：{error}</div>}

      {!loading && summary && (
        <>
          <div className="switch-usage-summary">
            <div className="switch-usage-stat">
              <span className="switch-usage-stat__value">{hasUsage ? formatTokens(summary.total_input_tokens + summary.total_output_tokens) : '—'}</span>
              <span className="switch-usage-stat__label">Total Tokens</span>
            </div>
            <div className="switch-usage-stat">
              <span className="switch-usage-stat__value">{summary.total_requests.toLocaleString()}</span>
              <span className="switch-usage-stat__label">Requests</span>
            </div>
            <div className="switch-usage-stat">
              <span className="switch-usage-stat__value">{hasUsage ? formatTokens(summary.total_input_tokens) : '—'}</span>
              <span className="switch-usage-stat__label">Input Tokens</span>
            </div>
            <div className="switch-usage-stat">
              <span className="switch-usage-stat__value">{hasUsage ? formatTokens(summary.total_output_tokens) : '—'}</span>
              <span className="switch-usage-stat__label">Output Tokens</span>
            </div>
          </div>
          {summary.last_recorded_at && (
            <div className="switch-usage-panel__freshness">
              Last recorded: {formatRecordedAt(summary.last_recorded_at)} · local network monitor · token usage
            </div>
          )}

          {byModel.length > 0 && (
            <div className="switch-usage-table">
              <h4>按模型</h4>
              <table>
                <thead>
                  <tr>
                    <th>模型</th>
                    <th>请求数</th>
                    <th>输入</th>
                    <th>输出</th>
                  </tr>
                </thead>
                <tbody>
                  {byModel.map((m) => (
                    <tr key={m.model_id}>
                      <td>{m.model_id}</td>
                      <td>{m.request_count}</td>
                      <td>{formatTokens(m.input_tokens)}</td>
                      <td>{formatTokens(m.output_tokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {byProvider.length > 0 && (
            <div className="switch-usage-table">
              <h4>按供应商</h4>
              <table>
                <thead>
                  <tr>
                    <th>供应商</th>
                    <th>请求数</th>
                    <th>输入</th>
                    <th>输出</th>
                  </tr>
                </thead>
                <tbody>
                  {byProvider.map((p) => (
                    <tr key={p.provider_id}>
                      <td>{p.provider_id}</td>
                      <td>{p.request_count}</td>
                      <td>{formatTokens(p.input_tokens)}</td>
                      <td>{formatTokens(p.output_tokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {summary.total_requests === 0 && (
            <div className="switch-empty">
              暂无用量数据。使用供应商后将自动记录。
            </div>
          )}
        </>
      )}
    </div>
  )
}
