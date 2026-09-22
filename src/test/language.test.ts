import { describe, expect, it } from 'vitest'
import { normalizeLanguage } from '../i18n/language'

describe('normalizeLanguage', () => {
  it('keeps Chinese and English', () => {
    expect(normalizeLanguage('zh')).toBe('zh')
    expect(normalizeLanguage('zh-CN')).toBe('zh')
    expect(normalizeLanguage('en')).toBe('en')
  })

  it('falls back to English for dropped or unknown languages', () => {
    for (const value of ['ja', 'ko', 'tr', 'fr-FR', '', undefined, 42]) {
      expect(normalizeLanguage(value)).toBe('en')
    }
  })
})
