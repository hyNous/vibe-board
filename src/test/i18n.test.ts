import { describe, it, expect } from 'vitest'
import en from '../i18n/locales/en.json'
import zh from '../i18n/locales/zh.json'

function flatKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k
    return typeof v === 'object' && v !== null
      ? flatKeys(v as Record<string, unknown>, key)
      : [key]
  })
}

const enKeys = flatKeys(en)

describe('i18n locale completeness', () => {
  it('both locales have exactly the same key set', () => {
    const locales = { en, zh }
    const expected = [...enKeys].sort()
    for (const [name, locale] of Object.entries(locales)) {
      expect([...flatKeys(locale as Record<string, unknown>)].sort(), name).toEqual(expected)
    }
  })
})
