import { describe, expect, it } from 'vitest'
import { getReadableNotificationHeight } from '../utils/notificationLayout'

describe('notificationLayout', () => {
  it('uses the configured height as a fallback when content is unknown', () => {
    expect(getReadableNotificationHeight(200, 600)).toBe(200)
  })

  it('keeps short notifications compact', () => {
    expect(getReadableNotificationHeight(200, 600, {
      text: '明白。我会严格按你每一轮的指令执行。',
      userMessage: '请给出第一轮指令。',
    })).toBe(128)
  })

  it('respects the available panel height', () => {
    expect(getReadableNotificationHeight(420, 360)).toBe(170)
  })

  it('caps very tall notification preferences', () => {
    expect(getReadableNotificationHeight(520, 900, {
      text: Array.from({ length: 28 }, (_, index) => `- Item ${index + 1}: verify a detailed implementation note`).join('\n'),
    })).toBe(420)
  })
})
