import { beforeEach, describe, expect, it } from 'vitest'
import { useConfigStore } from '../stores/configStore'

describe('configStore island defaults', () => {
  beforeEach(() => {
    localStorage.clear()
    useConfigStore.getState().resetIslandDefaults()
  })

  it('matches Vibe Board island defaults for feedback and cache display', () => {
    const state = useConfigStore.getState()

    expect(state.completionCardHeight).toBe(200)
    expect(state.detailPanelMaxHeight).toBe(500)
    expect(state.showCacheTTL).toBe(true)
    expect(state.taskCompleteDwellSeconds).toBe(6)
    expect(state.idleTimeoutMinutes).toBe(5)
    expect(state.volume).toBe(70)
  })

  it('uses tuned island interaction timing defaults', () => {
    const state = useConfigStore.getState()

    expect(state.hoverExpandDelay).toBe(50)
    expect(state.microHoverExpandDelay).toBe(50)
    expect(state.collapseDelay).toBe(200)
    expect(state.islandAnimationScale).toBe(1)
  })

  it('does not define the removed approval and jump-before-send settings', () => {
    const state = useConfigStore.getState() as unknown as Record<string, unknown>

    for (const key of [
      'shortcutApprove',
      'shortcutApproveEnabled',
      'shortcutDeny',
      'shortcutDenyEnabled',
      'shortcutSkip',
      'shortcutSkipEnabled',
      'autoApproveTools',
      'jumpBeforeSend',
    ]) {
      expect(key in state, key).toBe(false)
    }
    const actions = useConfigStore.getState().shortcuts.map((shortcut) => shortcut.action)
    expect(actions).not.toContain('approve-action')
    expect(actions).not.toContain('reject-action')
  })

  it('loads legacy configs with removed fields without writing them back', async () => {
    localStorage.setItem('vibeboard-config', JSON.stringify({
      state: {
        shortcutApprove: 'CommandOrControl+Shift+P',
        shortcutApproveEnabled: true,
        shortcutDeny: 'CommandOrControl+Shift+R',
        shortcutDenyEnabled: true,
        shortcutSkip: 'CommandOrControl+Shift+S',
        shortcutSkipEnabled: true,
        autoApproveTools: ['Read', 'Write'],
        jumpBeforeSend: false,
        shortcuts: [
          { action: 'toggle-panel', label: 'Toggle Panel', keys: 'CommandOrControl+Shift+I' },
          { action: 'approve-action', label: 'Approve Action', keys: 'CommandOrControl+Shift+P' },
        ],
        language: 'zh',
      },
      version: 0,
    }))

    await useConfigStore.persist.rehydrate()

    const state = useConfigStore.getState() as unknown as Record<string, unknown>
    expect(state.language).toBe('zh')
    for (const key of ['shortcutApprove', 'shortcutApproveEnabled', 'autoApproveTools', 'jumpBeforeSend']) {
      expect(key in state, key).toBe(false)
    }
    expect(useConfigStore.getState().shortcuts.map((shortcut) => shortcut.action)).not.toContain('approve-action')
  })

  it('keeps low-frequency in-window shortcuts off by default', () => {
    const state = useConfigStore.getState()

    expect(state.shortcuts.find((shortcut) => shortcut.action === 'toggle-panel')?.keys).toBe('CommandOrControl+Shift+I')
    expect(state.shortcuts.find((shortcut) => shortcut.action === 'collapse-panel')?.keys).toBe('Escape')
    expect(state.shortcuts.find((shortcut) => shortcut.action === 'open-settings')?.keys).toBe('CommandOrControl+,')
    expect(state.shortcuts.find((shortcut) => shortcut.action === 'expand-panel')?.keys).toBe('')
    expect(state.shortcuts.find((shortcut) => shortcut.action === 'next-session')?.keys).toBe('')
    expect(state.shortcuts.find((shortcut) => shortcut.action === 'prev-session')?.keys).toBe('')
  })
})
