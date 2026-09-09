import type { RateLimitInfo, UsageRateWindow } from '../types/agent'

export interface RateLimitWindowGroup {
  id: string
  title: string
  windows: UsageRateWindow[]
}

export function rateLimitWindows(rateLimits: RateLimitInfo | undefined): UsageRateWindow[] {
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

function isAntigravity(rateLimits: RateLimitInfo | undefined): boolean {
  return rateLimits?.provider?.toLowerCase() === 'antigravity'
}

export function rateLimitWindowGroups(rateLimits: RateLimitInfo | undefined): RateLimitWindowGroup[] {
  const windows = rateLimitWindows(rateLimits)
  if (!isAntigravity(rateLimits)) {
    return windows.map((window) => ({
      id: window.id,
      title: window.title?.trim() || window.id,
      windows: [window],
    }))
  }

  const groups = new Map<string, RateLimitWindowGroup>()
  for (const window of windows) {
    const rawTitle = window.title?.trim() || window.id
    const match = rawTitle.match(/\s+(?:5h|7d|30d)$/i)
    const title = match ? rawTitle.slice(0, match.index).trim() || rawTitle : rawTitle
    const key = title.toLocaleLowerCase()
    const group = groups.get(key) ?? { id: `group-${key}`, title, windows: [] }
    group.windows.push(window)
    groups.set(key, group)
  }
  return Array.from(groups.values())
}

export function rateLimitWindowLabel(window: UsageRateWindow, groupTitle?: string): string {
  const title = window.title?.trim() || window.id
  if (!groupTitle) return title
  const prefix = `${groupTitle} `
  return title.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())
    ? title.slice(prefix.length).trim() || title
    : title
}
