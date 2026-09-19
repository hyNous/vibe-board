import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useThemeStore } from '../stores/themeStore'

describe('themeStore', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    useThemeStore.setState({ colorTheme: 'midnight' })
  })

  it('does not persist again when selecting the active color theme', () => {
    useThemeStore.getState().setColorTheme('ink-amber')
    const setItem = vi.spyOn(Storage.prototype, 'setItem')

    useThemeStore.getState().setColorTheme('ink-amber')

    expect(setItem).not.toHaveBeenCalled()
  })

  it('persists only the color theme after role themes were removed', () => {
    useThemeStore.getState().setColorTheme('warm-paper')

    const persisted = JSON.parse(localStorage.getItem('vibeboard-theme') ?? '{}')
    expect(persisted.version).toBe(4)
    expect(persisted.state).toEqual({ colorTheme: 'warm-paper' })
  })

  it('drops a legacy role theme selection when rehydrating persisted state', async () => {
    localStorage.setItem('vibeboard-theme', JSON.stringify({
      version: 3,
      state: { activeThemeName: 'codex-pet:nami', colorTheme: 'warm-paper' },
    }))

    await useThemeStore.persist.rehydrate()

    const state = useThemeStore.getState()
    expect(state.colorTheme).toBe('warm-paper')
    expect('activeThemeName' in state).toBe(false)
  })
})
