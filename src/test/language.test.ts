import { describe, expect, it } from 'vitest'
import { normalizeLanguage } from '../i18n/language'

describe('normalizeLanguage', () => {

  it('falls back to English for dropped or unknown languages', () => {
    for (const value of ['ja', 'ko', 'tr', 'fr-FR', '', undefined, 42]) {
      expect(normalizeLanguage(value)).toBe('en')
    }
  })
})
