import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentStatusSnapshot, RateLimitInfo, UsageRateWindow } from '../../types/agent'
import { rateLimitWindowGroups, rateLimitWindowLabel } from '../../utils/rateLimitDisplay'
import './AgentPresenceStrip.css'

const DISPLAY_ORDER = ['codex', 'claude-code', 'opencode', 'antigravity']

function totalTokens(status: AgentStatusSnapshot): number {
  const { input, output, cacheRead, cacheCreate } = status.tokens
  return input + output + cacheRead + cacheCreate
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

function formatRateLimitLines(rateLimits: RateLimitInfo | undefined, now: number) {
  if (!rateLimits) return []
  const groups = rateLimitWindowGroups(rateLimits)
  const isStacked = rateLimits.provider?.toLowerCase() === 'antigravity' && groups.length > 1
  const displayGroups = isStacked
    ? groups
    : [{ id: 'all', title: '', windows: groups.flatMap((group) => group.windows) }]

  return displayGroups.map((group) => {
    const quota = group.windows.map((window) => {
      const title = rateLimitWindowLabel(window, group.title || undefined)
      const remaining = windowRemainingPercent(window)
      return remaining === undefined ? `${title} —` : `${title} ${Math.round(remaining)}%`
    }).join(' · ')
    const reset = group.windows
      .map((window) => {
        const value = formatResetCountdown(window.resetsAt, now) || window.remainingLabel?.trim()
        if (!value) return undefined
        return `${rateLimitWindowLabel(window, group.title || undefined)} ${value}`
      })
      .filter((value): value is string => Boolean(value))
      .join(' · ')
    return {
      quota: group.title ? `${group.title} ${quota}` : quota,
      reset: group.title && reset ? `${group.title} ${reset}` : reset,
    }
  }).filter((line) => Boolean(line.quota || line.reset))
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

  const rows = Object.values(statuses).sort((a, b) => {
    const aIndex = DISPLAY_ORDER.indexOf(a.agent)
    const bIndex = DISPLAY_ORDER.indexOf(b.agent)
    if (aIndex !== bIndex) {
      if (aIndex < 0) return 1
      if (bIndex < 0) return -1
      return aIndex - bIndex
    }
    return a.label.localeCompare(b.label)
  })

  if (rows.length === 0) return null

  return (
    <div className="agent-presence-strip" data-testid="agent-presence-strip">
      {rows.map((status) => {
        const rateLimits = usageSnapshots[status.agent] ?? status.rateLimits ?? undefined
        const rateLimitLines = formatRateLimitLines(rateLimits, now)
        const quotaLines = rateLimitLines.map((line) => line.quota).filter(Boolean)
        const resetLines = rateLimitLines.map((line) => line.reset).filter((line): line is string => Boolean(line))
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
            {quotaLines.length > 0 && <span className="agent-presence-strip__meta agent-presence-strip__meta--quota">{quotaLines.map((quota) => <span className="agent-presence-strip__quota-line" key={quota}>{t('notch.agentQuota', { defaultValue: '额度剩余 {{value}}', value: quota })}</span>)}</span>}
            {resetLines.length > 0 && <span className="agent-presence-strip__meta">{resetLines.map((resetValue) => <span className="agent-presence-strip__quota-line" key={resetValue}>{t('notch.agentReset', { defaultValue: '重置 {{value}}', value: resetValue })}</span>)}</span>}
            {quotaLines.length === 0 && resetLines.length === 0 && tokens > 0 && <span className="agent-presence-strip__meta">{t('notch.agentTokens', { defaultValue: 'Token {{value}}', value: tokens.toLocaleString() })}</span>}
            {!hasRecord && <span className="agent-presence-strip__meta">{t('notch.agentNoRecord', { defaultValue: '暂无记录' })}</span>}
          </div>
        )
      })}
    </div>
  )
}
