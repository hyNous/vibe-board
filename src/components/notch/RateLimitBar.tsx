/* RateLimitBar — Compact API rate limit display */
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
  if (!rateLimits) return null

  const windows = rateLimitWindows(rateLimits).slice(0, 2)
  const groups = rateLimitWindowGroups(rateLimits)
  const stacked = rateLimits.provider?.toLowerCase() === 'antigravity' && groups.length > 1
  const titleWindows = stacked ? groups.flatMap((group) => group.windows) : windows

  const source = rateLimits.providerLabel || rateLimits.provider || 'Usage'
  const sourceDetail = [rateLimits.source, rateLimits.updatedAt ? new Date(rateLimits.updatedAt).toLocaleTimeString() : null]
    .filter(Boolean)
    .join(' · ')
  const title = `${source}: ${titleWindows.map((window) => `${window.title}: ${Math.round(window.usedPercent)}% used${window.remainingLabel ? ` (${window.remainingLabel} left)` : ''}`).join(' | ')}${sourceDetail ? ` · ${sourceDetail}` : ''}`

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
