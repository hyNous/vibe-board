import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface ColorThemeInfo {
  id: string
  label: string
  labelZh: string
  tag: string
  isDark: boolean
  bg: string
  card: string
  accent: string
}

export const COLOR_THEMES: ColorThemeInfo[] = [
  { id: 'midnight', label: 'Midnight', labelZh: '午夜', tag: 'Vibe Board', isDark: true, bg: '#000000', card: '#0a0a0a', accent: '#7b78ff' },
  { id: 'ink-amber', label: 'Vibe Board Classic', labelZh: 'Vibe Board 经典', tag: 'Classic', isDark: false, bg: '#f4eddf', card: '#fffaf2', accent: '#9a5f12' },
  { id: 'frosted-glass', label: 'Liquid Glass', labelZh: '液态玻璃', tag: 'Glass', isDark: false, bg: '#eef2f8', card: '#fbfcff', accent: '#3f46ff' },
  { id: 'apple', label: 'Apple', labelZh: '苹果', tag: 'Clean', isDark: false, bg: '#f5f5f7', card: '#ffffff', accent: '#007aff' },
  { id: 'smoke', label: 'Smoke', labelZh: '烟灰', tag: 'Neutral', isDark: false, bg: '#e8e8ec', card: '#f4f4f6', accent: '#64748b' },
  { id: 'ocean-mist', label: 'Ocean Mist', labelZh: '海雾', tag: 'Cool', isDark: false, bg: '#e8eef5', card: '#f2f6fb', accent: '#0284c7' },
  { id: 'warm-paper', label: 'Warm Paper', labelZh: '暖纸', tag: 'Warm', isDark: false, bg: '#f2efe8', card: '#faf7f0', accent: '#d97706' },
  { id: 'soft-lavender', label: 'Soft Lavender', labelZh: '柔薰衣草', tag: 'Soft', isDark: false, bg: '#eeedf6', card: '#f8f7fc', accent: '#6366f1' },
  { id: 'system', label: 'System', labelZh: '跟随系统', tag: 'Auto', isDark: false, bg: 'linear-gradient(90deg, #0b0c0f 0 50%, #f5f5f7 50% 100%)', card: 'linear-gradient(90deg, #15171c 0 50%, #ffffff 50% 100%)', accent: '#007aff' },
]

export function isDarkColorTheme(id: string) {
  return COLOR_THEMES.find((theme) => theme.id === id)?.isDark ?? false
}

const DEFAULT_COLOR_THEME_ID = 'midnight'

type PersistedThemeState = {
  colorTheme?: string
}

function applyColorTheme(id: string) {
  document.documentElement.setAttribute('data-island-color-theme', id)
}

interface ThemeStore {
  colorTheme: string
  setColorTheme: (id: string) => void
}

export const useThemeStore = create<ThemeStore>()(
  persist(
    (set, get) => ({
      colorTheme: DEFAULT_COLOR_THEME_ID,

      setColorTheme: (id) => {
        if (COLOR_THEMES.some((t) => t.id === id)) {
          applyColorTheme(id)
          if (get().colorTheme === id) return
          set({ colorTheme: id })
        }
      },
    }),
    {
      name: 'vibeboard-theme',
      version: 4,
      partialize: (state) => ({ colorTheme: state.colorTheme }),
      migrate: (persistedState, version) => {
        const state = persistedState as PersistedThemeState | undefined
        if (!state) return persistedState
        const colorTheme = version < 3 && (!state.colorTheme || state.colorTheme === 'ink-amber')
          ? DEFAULT_COLOR_THEME_ID
          : state.colorTheme
        return colorTheme ? { colorTheme } : persistedState
      },
      onRehydrateStorage: () => {
        return (state) => {
          if (state?.colorTheme && COLOR_THEMES.some((theme) => theme.id === state.colorTheme)) {
            applyColorTheme(state.colorTheme)
          } else if (state) {
            state.colorTheme = DEFAULT_COLOR_THEME_ID
            applyColorTheme(DEFAULT_COLOR_THEME_ID)
          }
        }
      },
    }
  )
)
