const NOTIFICATION_READER_MIN_HEIGHT = 128
const NOTIFICATION_READER_PREFERRED_HEIGHT = 360
const NOTIFICATION_READER_MAX_HEIGHT = 420
const NOTIFICATION_PANEL_CHROME_HEIGHT = 190
const NOTIFICATION_PANEL_MIN_HEIGHT = 300
const COMPACTING_PANEL_HEIGHT = 260

export interface NotificationContentMetrics {
  text?: string
  userMessage?: string
}

function weightedLength(value: string): number {
  return Array.from(value).reduce((total, char) => total + (char.charCodeAt(0) > 127 ? 1.65 : 1), 0)
}

function estimateMarkdownLineCount(text: string): number {
  const lines = text.split('\n')
  return lines.reduce((total, line) => {
    const trimmed = line.trim()
    if (!trimmed) return total + 0.35
    if (/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(trimmed)) return total

    const tableLike = trimmed.includes('|')
    const charsPerLine = tableLike ? 72 : 92
    const markdownWeight = /^#{1,6}\s/.test(trimmed)
      ? 0.35
      : /^[-*+]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)
        ? 0.15
        : 0

    return total + Math.max(1, Math.ceil(weightedLength(trimmed) / charsPerLine)) + markdownWeight
  }, 0)
}

function estimateReadableHeight(content?: NotificationContentMetrics): number | null {
  const text = content?.text?.trim()
  if (!text) return null

  const statusHeight = 30
  const userMessageHeight = content?.userMessage ? 30 : 0
  const bodyLineCount = estimateMarkdownLineCount(text)
  const bodyHeight = Math.ceil(bodyLineCount * 19) + 24
  return Math.ceil(statusHeight + userMessageHeight + bodyHeight + 16)
}

export function getReadableNotificationHeight(
  completionCardHeight: number,
  maxPanelHeight: number,
  content?: NotificationContentMetrics,
): number {
  const availableHeight = Math.max(
    NOTIFICATION_READER_MIN_HEIGHT,
    (maxPanelHeight || 600) - NOTIFICATION_PANEL_CHROME_HEIGHT,
  )
  const desiredHeight = estimateReadableHeight(content)
    ?? Math.max(NOTIFICATION_READER_MIN_HEIGHT, Math.min(completionCardHeight, NOTIFICATION_READER_PREFERRED_HEIGHT))
  return Math.min(NOTIFICATION_READER_MAX_HEIGHT, Math.max(NOTIFICATION_READER_MIN_HEIGHT, desiredHeight), availableHeight)
}

export function getNotificationPanelHeight(
  completionCardHeight: number,
  maxPanelHeight: number,
  overlayType?: string,
  content?: NotificationContentMetrics,
): number {
  const panelMaxHeight = maxPanelHeight || 600
  if (overlayType === 'compacting') {
    return Math.min(COMPACTING_PANEL_HEIGHT, panelMaxHeight)
  }

  const readerHeight = getReadableNotificationHeight(completionCardHeight, panelMaxHeight, content)
  return Math.min(
    Math.max(readerHeight + NOTIFICATION_PANEL_CHROME_HEIGHT, NOTIFICATION_PANEL_MIN_HEIGHT),
    panelMaxHeight,
  )
}


