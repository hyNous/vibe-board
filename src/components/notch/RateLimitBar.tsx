/* RateLimitBar — Compact API rate limit display */
import { useTranslation } from 'react-i18next'
import type { RateLimitInfo } from '../../types/agent'
import { rateLimitWindowGroups, rateLimitWindowLabel, rateLimitWindows } from '../../utils/rateLimitDisplay'
import './RateLimitBar.css'

interface RateLimitBarProps {
  rateLimits?: RateLimitInfo
}

function usageClass(pct: number): string {
  if (pct >= 80) return 'rate-limit__segment--red'
  if (pct >= 50) return 'rate-limit__segment--amber'
  return 'rate-limit__segment--green'
}

export function RateLimitBar({ rateLimits }: RateLimitBarProps) {
  const { t } = useTranslation()
  if (!rateLimits) return null

  const windows = rateLimitWindows(rateLimits).slice(0, 2)
  const groups = rateLimitWindowGroups(rateLimits)
  const stacked = rateLimits.provider?.toLowerCase() === 'antigravity' && groups.length > 1
  const titleWindows = stacked ? groups.flatMap((group) => group.windows) : windows

  const source = rateLimits.providerLabel || rateLimits.provider || t('settings.usage', { defaultValue: '使用额度' })
  const title = `${source}: ${titleWindows.map((window) => {
    const used = t('notch.rateLimitUsed', { defaultValue: '已用 {{percent}}%', percent: Math.round(window.usedPercent) })
    const remaining = window.remainingLabel
      ? `，${t('notch.rateLimitRemaining', { defaultValue: '剩余 {{value}}', value: window.remainingLabel })}`
      : ''
    return `${window.title} ${used}${remaining}`
  }).join('；')}`

  const renderSegment = (window: typeof titleWindows[number], index: number, groupTitle?: string) => (
    <span key={`${groupTitle || 'window'}:${window.id}`} className={`rate-limit__segment ${usageClass(window.usedPercent)}`}>
      {index > 0 && <span className="rate-limit__divider">|</span>}
      <span className="rate-limit__window">{rateLimitWindowLabel(window, groupTitle)}</span>
      <span className="rate-limit__usage">{Math.round(window.usedPercent)}%</span>
      {window.remainingLabel && <span className="rate-limit__remaining">{window.remainingLabel}</span>}
    </span>
  )

  return (
    <div className={`rate-limit${stacked ? ' rate-limit--stacked' : ''}`} title={title}>
      {stacked
        ? groups.map((group) => (
          <span className="rate-limit__group" key={group.id}>
            <span className="rate-limit__group-title">{group.title}</span>
            {group.windows.map((window, index) => renderSegment(window, index, group.title))}
          </span>
        ))
        : windows.map((window, index) => renderSegment(window, index))}
    </div>
  )
}
