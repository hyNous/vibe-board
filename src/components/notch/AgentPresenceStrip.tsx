import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentStatusSnapshot, RateLimitInfo, UsageRateWindow } from '../../types/agent'
import './AgentPresenceStrip.css'

const DISPLAY_ORDER = ['codex', 'claude-code', 'opencode', 'antigravity']

function totalTokens(status: AgentStatusSnapshot): number {
  const { input, output, cacheRead, cacheCreate } = status.tokens
  return input + output + cacheRead + cacheCreate
}

function rateLimitWindows(rateLimits: RateLimitInfo | undefined): UsageRateWindow[] {
  if (!rateLimits) return []
  if (rateLimits.windows && rateLimits.windows.length > 0) return rateLimits.windows
  return [
    {
      id: 'five_hour',
      title: '5h',
      usedPercent: rateLimits.fiveHourUsage,
      remainingPercent: Math.max(0, 100 - rateLimits.fiveHourUsage),
      remainingLabel: rateLimits.fiveHourRemaining,
      windowMinutes: 300,
    },
    {
      id: 'seven_day',
      title: '7d',
      usedPercent: rateLimits.sevenDayUsage,
      remainingPercent: Math.max(0, 100 - rateLimits.sevenDayUsage),
      remainingLabel: rateLimits.sevenDayRemaining,
      windowMinutes: 10_080,
    },
  ]
}

function windowRemainingPercent(window: UsageRateWindow): number | undefined {
  if (typeof window.remainingPercent === 'number' && Number.isFinite(window.remainingPercent)) {
    return Math.max(0, Math.min(100, window.remainingPercent))
  }
  if (typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent)) {
    return Math.max(0, Math.min(100, 100 - window.usedPercent))
  }
  return undefined
}

function formatResetCountdown(resetsAt: string | null | undefined, now: number): string | undefined {
  const reset = resetsAt ? Date.parse(resetsAt) : Number.NaN
  if (!Number.isFinite(reset) || reset <= now) return undefined

  const minutes = Math.ceil((reset - now) / 60000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h${rest}m` : `${hours}h`
}

function formatRateLimitQuota(rateLimits: RateLimitInfo | undefined): string | undefined {
  const values = rateLimitWindows(rateLimits).map((window) => {
    const title = window.title?.trim() || window.id
    const remaining = windowRemainingPercent(window)
    return remaining === undefined ? `${title} —` : `${title} ${Math.round(remaining)}%`
  })
  return values.length > 0 ? values.join(' · ') : undefined
}

function formatRateLimitResets(rateLimits: RateLimitInfo | undefined, now: number): string | undefined {
  const values = rateLimitWindows(rateLimits)
    .map((window) => {
      const reset = formatResetCountdown(window.resetsAt, now) || window.remainingLabel?.trim()
      if (!reset) return undefined
      return `${window.title?.trim() || window.id} ${reset}`
    })
    .filter((value): value is string => Boolean(value))
  return values.length > 0 ? values.join(' · ') : undefined
}

export function AgentPresenceStrip({
  statuses,
  usageSnapshots,
}: {
  statuses: Record<string, AgentStatusSnapshot>
  usageSnapshots: Record<string, RateLimitInfo>
}) {
  const { t } = useTranslation()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const rows = DISPLAY_ORDER
    .map((agent) => statuses[agent])
    .filter((status): status is AgentStatusSnapshot => Boolean(status))

  if (rows.length === 0) return null

  return (
    <div className="agent-presence-strip" data-testid="agent-presence-strip">
      {rows.map((status) => {
        const rateLimits = usageSnapshots[status.agent] ?? status.rateLimits ?? undefined
        const quota = formatRateLimitQuota(rateLimits)
        const reset = formatRateLimitResets(rateLimits, now)
        const tokens = totalTokens(status)
        const hasRecord = status.lastSeenAt > 0 || Boolean(rateLimits) || tokens > 0
        return (
          <div className="agent-presence-strip__row" key={status.agent}>
            <span className={`agent-presence-strip__dot ${status.online ? 'agent-presence-strip__dot--online' : ''}`} />
            <span className="agent-presence-strip__name">{status.label}</span>
            <span className="agent-presence-strip__state">
              {status.online
                ? t('notch.agentOnline', { defaultValue: '在线' })
                : t('notch.agentOffline', { defaultValue: '离线' })}
            </span>
            {quota && <span className="agent-presence-strip__meta agent-presence-strip__meta--quota" title={rateLimits?.source}>{t('notch.agentQuota', { defaultValue: '额度剩余 {{value}}', value: quota })}</span>}
            {reset && <span className="agent-presence-strip__meta">{t('notch.agentReset', { defaultValue: '重置 {{value}}', value: reset })}</span>}
            {!quota && !reset && tokens > 0 && <span className="agent-presence-strip__meta">{t('notch.agentTokens', { defaultValue: 'Token {{value}}', value: tokens.toLocaleString() })}</span>}
            {!hasRecord && <span className="agent-presence-strip__meta">{t('notch.agentNoRecord', { defaultValue: '暂无记录' })}</span>}
          </div>
        )
      })}
    </div>
  )
}
