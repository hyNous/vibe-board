export type AppLanguage = 'en' | 'zh'

// Only Chinese and English ship; any other stored or detected value falls back to English.
export function normalizeLanguage(value: unknown): AppLanguage {
  return typeof value === 'string' && value.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}
