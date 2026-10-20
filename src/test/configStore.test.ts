import { beforeEach, describe, expect, it } from 'vitest'
import { useConfigStore } from '../stores/configStore'

describe('configStore island defaults', () => {
  beforeEach(() => {
    localStorage.clear()
    useConfigStore.getState().resetIslandDefaults()
  })

  it('strips removed analytics fields from a persisted legacy config', async () => {
    localStorage.setItem('vibeboard-config', JSON.stringify({
      state: {
        analyticsEnabled: true,
        analyticsConsentPromptCompleted: true,
        language: 'zh',
      },
      version: 0,
    }))

    await useConfigStore.persist.rehydrate()

    const state = useConfigStore.getState() as unknown as Record<string, unknown>
    expect(state.language).toBe('zh')
    expect('analyticsEnabled' in state).toBe(false)
    expect('analyticsConsentPromptCompleted' in state).toBe(false)

    useConfigStore.getState().updateConfig('language', 'en')
    const persisted = localStorage.getItem('vibeboard-config') ?? ''
    expect(persisted).not.toContain('analyticsEnabled')
    expect(persisted).not.toContain('analyticsConsentPromptCompleted')
  })

  it('turns the hidden automatic update switches off, even when an older build saved them on', async () => {
    expect(useConfigStore.getState().autoCheckUpdate).toBe(false)
    localStorage.setItem('vibeboard-config', JSON.stringify({
      state: { autoCheckUpdate: true, autoInstallUpdate: true, language: 'zh' },
      version: 0,
    }))

    await useConfigStore.persist.rehydrate()

    const state = useConfigStore.getState()
    expect(state.language).toBe('zh')
    expect(state.autoCheckUpdate).toBe(false)
    expect(state.autoInstallUpdate).toBe(false)
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
})
