import { describe, it, expect } from 'vitest'
import en from '../i18n/locales/en.json'
import zh from '../i18n/locales/zh.json'
import ja from '../i18n/locales/ja.json'
import ko from '../i18n/locales/ko.json'
import tr from '../i18n/locales/tr.json'

function flatKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k
    return typeof v === 'object' && v !== null
      ? flatKeys(v as Record<string, unknown>, key)
      : [key]
  })
}

const enKeys = flatKeys(en)

describe('Skill management copy', () => {
  const locales = { en, zh, ja, ko, tr }

  it('keeps the Skill management namespaces identical across all five locales', () => {
    const namespaces = [
      'settings.skillsOverview',
      'skills.sourceCategory',
      'skills.sourceType',
      'skills.claim',
      'skills.blocker',
      'skills.agentManagement',
    ]
    const scopedKeys = (locale: Record<string, unknown>, namespace: string) =>
      flatKeys(locale).filter((key) => key === namespace || key.startsWith(`${namespace}.`))

    for (const namespace of namespaces) {
      const expected = scopedKeys(en, namespace).sort()
      for (const [name, locale] of Object.entries(locales)) {
        expect(scopedKeys(locale as Record<string, unknown>, namespace).sort(), `${name} ${namespace}`).toEqual(expected)
      }
    }
  })

  it('labels Skill origins as 自定义 / GitHub / 从 Agent 同步 in every locale', () => {
    const expected = ['custom', 'github', 'agent']
    for (const [name, locale] of Object.entries(locales)) {
      const sourceCategory = (locale as Record<string, unknown>).skills as Record<string, Record<string, unknown>>
      expect(Object.keys(sourceCategory.sourceCategory).sort(), name).toEqual([...expected].sort())
      for (const key of expected) {
        expect(String(sourceCategory.sourceCategory[key]).trim(), `${name} ${key}`).not.toBe('')
      }
    }
    expect(locales.zh.skills.sourceCategory).toEqual({
      custom: '自定义',
      github: 'GitHub',
      agent: '从 Agent 同步',
    })
  })

  it('no Skill management string falls back to the removed distribution wording', () => {
    const patterns: Record<string, RegExp> = {
      en: /distribut/i,
      zh: /分发/,
      ja: /配布|配信/,
      ko: /배포|분배/,
      tr: /dağıt|dağit/i,
    }
    const namespaces = ['settings.skillsOverview', 'skills.sourceCategory', 'skills.claim', 'skills.blocker', 'skills.agentManagement']
    for (const [name, locale] of Object.entries(locales)) {
      const pattern = patterns[name]
      for (const key of flatKeys(locale as Record<string, unknown>)) {
        if (!namespaces.some((namespace) => key === namespace || key.startsWith(`${namespace}.`))) continue
        const value = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], locale)
        if (typeof value !== 'string') continue
        expect(pattern.test(value), `${name} ${key}: ${value}`).toBe(false)
      }
    }
  })
})

describe('i18n locale completeness', () => {
  it('zh has all keys from en', () => {
    const zhKeys = flatKeys(zh)
    const missing = enKeys.filter((k) => !zhKeys.includes(k))
    expect(missing).toEqual([])
  })

  it('ja has all keys from en', () => {
    const jaKeys = flatKeys(ja)
    const missing = enKeys.filter((k) => !jaKeys.includes(k))
    expect(missing).toEqual([])
  })

  it('ko has all keys from en', () => {
    const koKeys = flatKeys(ko)
    const missing = enKeys.filter((k) => !koKeys.includes(k))
    expect(missing).toEqual([])
  })

  it('en has expected top-level namespaces', () => {
    expect(Object.keys(en)).toEqual(expect.arrayContaining(['notch', 'settings', 'tray', 'trial']))
  })

  it('ja tray.quit is translated', () => {
    expect(ja.tray.quit).not.toBe(en.tray.quit)
  })

  it('ko tray.quit is translated', () => {
    expect(ko.tray.quit).not.toBe(en.tray.quit)
  })

  it('all five locales cover layered Agent Skill scope copy', () => {
    const keys = [
      'skillSource',
      'skillStatus',
      'agentSkills',
      'managedSkills',
      'unmanagedSkills',
      'inheritedManagedNoResults',
      'inheritedUnmanagedNoResults',
      'sharedAdoptAction',
      'sharedAdoptBusy',
      'sharedViewDetails',
      'builtinSkills',
    ]
    const locales = [en, zh, ja, ko, tr].map(
      (locale) => locale.skills.agentManagement as Record<string, unknown>,
    )

    for (const locale of locales) {
      for (const key of keys) {
        expect(locale[key], key).toEqual(expect.any(String))
        expect(String(locale[key]).trim(), key).not.toBe('')
      }
    }

    expect(locales.map((locale) => locale.builtinSkills)).toEqual([
      'Built-in read-only',
      '内置只读',
      '組み込み読み取り専用',
      '기본 제공 읽기 전용',
      'Yerleşik salt okunur',
    ])

    const sharedDeleteKeys = [
      'managedTitle',
      'unmanagedTitle',
      'confirm',
      'busy',
      'managedDescription',
      'managedPreserved',
      'unmanagedDescription',
      'unmanagedPermanent',
    ]
    for (const locale of locales) {
      const sharedDelete = locale.sharedDelete as Record<string, unknown>
      for (const key of sharedDeleteKeys) {
        expect(sharedDelete[key], key).toEqual(expect.any(String))
        expect(String(sharedDelete[key]).trim(), key).not.toBe('')
      }
    }

    const actionKeys = [
      'delete',
      'deleting',
      'deleteNamed',
      'deletingNamed',
      'adopt',
      'preparingAdopt',
      'adopting',
      'batchSelect',
      'selected',
      'selectCurrent',
      'selectCurrentAdoptable',
      'clear',
      'batchDelete',
      'adoptToCenter',
      'cancelSelection',
      'batchManage',
      'selectNamed',
    ]
    for (const locale of locales) {
      const actions = locale.actions as Record<string, unknown>
      for (const key of actionKeys) {
        expect(actions[key], key).toEqual(expect.any(String))
        expect(String(actions[key]).trim(), key).not.toBe('')
      }
    }
  })
})
