import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsApp } from '../components/settings'
import type { BackendDisplayInfo } from '../services/tauriApi'
import { useConfigStore } from '../stores/configStore'
import { useThemeStore } from '../stores/themeStore'
import { isApplePlatform } from '../utils/platform'

const tauriMocks = vi.hoisted(() => ({
  listDisplays: vi.fn(() => Promise.resolve([] as BackendDisplayInfo[])),
  repositionNotch: vi.fn(() => Promise.resolve()),
  setDisplayId: vi.fn(() => Promise.resolve()),
  setIslandFeatureFlags: vi.fn(() => Promise.resolve()),
  previewIslandLayout: vi.fn(() => Promise.resolve()),
  clearIslandLayoutPreview: vi.fn(() => Promise.resolve()),
  previewSound: vi.fn(() => Promise.resolve()),
  setSoundEventRule: vi.fn(() => Promise.resolve()),
  registerGlobalShortcut: vi.fn(() => Promise.resolve()),
  setGlobalActionShortcuts: vi.fn(() => Promise.resolve()),
  setIslandSurfaceOptions: vi.fn(() => Promise.resolve()),
  setAnalyticsEnabled: vi.fn(() => Promise.resolve()),
}))

vi.mock('../services/tauriApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tauriApi')>()
  return {
    ...actual,
    listDisplays: tauriMocks.listDisplays,
    repositionNotch: tauriMocks.repositionNotch,
    setDisplayId: tauriMocks.setDisplayId,
    setIslandFeatureFlags: tauriMocks.setIslandFeatureFlags,
    previewIslandLayout: tauriMocks.previewIslandLayout,
    clearIslandLayoutPreview: tauriMocks.clearIslandLayoutPreview,
    previewSound: tauriMocks.previewSound,
    setSoundEventRule: tauriMocks.setSoundEventRule,
    registerGlobalShortcut: tauriMocks.registerGlobalShortcut,
    setGlobalActionShortcuts: tauriMocks.setGlobalActionShortcuts,
    setIslandSurfaceOptions: tauriMocks.setIslandSurfaceOptions,
    setAnalyticsEnabled: tauriMocks.setAnalyticsEnabled,
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; message?: string; count?: number }) => {
      const translations: Record<string, string> = {
        'settings.soundEvents.session-start': '会话开始',
        'settings.soundEvents.permission-request': '权限请求',
        'settings.soundEvents.context-compact': '上下文压缩',
        'settings.probeFilterDesc': '静音很快结束的后台探测会话，避免连接检查、模型探测等短任务播放提示音。',
      }
      const value = translations[key] ?? options?.defaultValue ?? key
      return value
        .replace('{{message}}', options?.message ?? '')
        .replace('{{count}}', String(options?.count ?? ''))
    },
    i18n: { language: 'en' },
  }),
}))

vi.mock('../components/settings/sections/AgentMonitorSection', () => ({
  AgentMonitorSection: () => <section><h2>Tasks</h2></section>,
}))

describe('settings island menu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tauriMocks.listDisplays.mockResolvedValue([])
    tauriMocks.registerGlobalShortcut.mockResolvedValue(undefined)
    tauriMocks.setGlobalActionShortcuts.mockResolvedValue(undefined)
    tauriMocks.setIslandSurfaceOptions.mockResolvedValue(undefined)
    tauriMocks.setAnalyticsEnabled.mockResolvedValue(undefined)
    useConfigStore.setState({
      displayMonitor: 'auto',
      followFocus: false,
      tipsEnabled: true,
      analyticsEnabled: false,
      analyticsConsentPromptCompleted: true,
    })
  })

  it('shows the six Chinese primary navigation entries and keeps legacy entries hidden', () => {
    const { container } = render(<SettingsApp onClose={vi.fn()} />)
    const visibleLabels = Array.from(
      container.querySelectorAll('.settings-sidebar__item:not([hidden]) .settings-sidebar__label-text'),
    ).map((item) => item.textContent?.trim())

    expect(visibleLabels).toEqual(['任务看板', '使用额度', 'Skill管理', 'Agent管理', '外观设置', '通用设置'])
    expect(screen.queryByText('远程服务器')).not.toBeInTheDocument()
    expect(screen.queryByText('Agent Switch')).not.toBeInTheDocument()
    expect(screen.getByText('关于')).not.toBeVisible()
  })

  it('switches between Tasks, Usage, and Settings', async () => {
    render(<SettingsApp onClose={vi.fn()} />)

    expect(screen.getByRole('heading', { name: 'Tasks' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '使用额度' }))
    expect(await screen.findByRole('heading', { name: 'Usage' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '通用设置' }))
    await waitFor(() => expect(screen.getByText('settings.language')).toBeInTheDocument())
  })

  it('does not expose first-run analytics consent or Pet choices', () => {
    useConfigStore.setState({
      analyticsEnabled: false,
      analyticsConsentPromptCompleted: false,
    })
    render(<SettingsApp onClose={vi.fn()} />)

    expect(screen.queryByRole('radio', { name: /settings.surfacePet/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'settings.welcomeContinue' })).not.toBeInTheDocument()
    expect(useConfigStore.getState().analyticsConsentPromptCompleted).toBe(false)
    expect(useConfigStore.getState().analyticsEnabled).toBe(false)
    expect(tauriMocks.setAnalyticsEnabled).not.toHaveBeenCalled()
  })

  it('uses the left settings menu for island pages instead of top tabs', async () => {
    const { container } = render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByText('外观设置'))

    await waitFor(() => expect(screen.getByRole('button', { name: /Overview/ })).toHaveClass('active'))
    expect(screen.getByRole('button', { name: /Display/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Behavior/ })).toBeInTheDocument()
    expect(container.querySelector('.island-tabs')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Display/ }))

    await waitFor(() => expect(screen.getByRole('button', { name: /Display/ })).toHaveClass('active'))
    // 灵动岛效果只在总览页提供单一入口，Display 页不再重复配色卡与效果单选项。
    expect(screen.queryByText('settings.colorTheme')).not.toBeInTheDocument()
    expect(container.querySelector('.pet-picker-block')).toBeNull()
    expect(screen.queryByText('settings.activeTheme')).not.toBeInTheDocument()
    expect(container.querySelectorAll('.color-theme-cards')).toHaveLength(0)
    expect(screen.queryByRole('radio', { name: /磨砂玻璃/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: '展示模式' })).not.toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: '灵动岛' })).not.toBeInTheDocument()
    expect(container.querySelector('.island-tabs')).not.toBeInTheDocument()
  })

  it('keeps SSH server management out of the Dynamic Island menu', async () => {
    const { container } = render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByText('外观设置'))

    await waitFor(() => expect(screen.getByRole('button', { name: /Overview/ })).toHaveClass('active'))
    const islandMenuLabels = Array.from(container.querySelectorAll('.island-view-tabs button'))
      .map((button) => button.textContent?.trim())
    expect(islandMenuLabels).toContain('Integration')
    expect(islandMenuLabels).not.toContain('SSH Remote')
    expect(screen.queryByText('settings.sshDescription')).not.toBeInTheDocument()
  })

  it('orders Skill and Agent management in the primary navigation', () => {
    const { container } = render(<SettingsApp onClose={vi.fn()} />)
    const labels = Array.from(container.querySelectorAll('.settings-sidebar__item:not([hidden]) .settings-sidebar__label-text'))
      .map((item) => item.textContent?.trim())

    expect(labels.indexOf('Skill管理')).toBeLessThan(labels.indexOf('Agent管理'))
    expect(labels.indexOf('Agent管理')).toBeLessThan(labels.indexOf('外观设置'))
  })

  it('places Hook diagnostics under Integration instead of Advanced', async () => {
    render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByText('外观设置'))
    fireEvent.click(await screen.findByRole('button', { name: /Integration/ }))

    await waitFor(() => expect(screen.getByText('Hook Doctor')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Run diagnostics' }))
    await waitFor(() => expect(screen.getByText('Browser mode')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }))

    await waitFor(() => expect(screen.getByText('Visual Signals')).toBeInTheDocument())
    expect(screen.queryByText('Hook Doctor')).not.toBeInTheDocument()
    expect(screen.queryByText('Session Launcher')).not.toBeInTheDocument()
    expect(screen.queryByText('Custom CLI Hook Templates')).not.toBeInTheDocument()
  })

  it('renders Advanced without removed debug and launcher controls', async () => {
    render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByText('外观设置'))
    fireEvent.click(await screen.findByRole('button', { name: /Advanced/ }))

    await waitFor(() => expect(screen.getByText('Visual Signals')).toBeInTheDocument())
    expect(screen.getByText('settings.agentActivity')).toBeInTheDocument()
    expect(screen.getByText('settings.pixelCursor')).toBeInTheDocument()
    expect(screen.queryByText('settings.showCacheTTL')).not.toBeInTheDocument()
    expect(screen.queryByText('settings.aiMessageLines')).not.toBeInTheDocument()
    expect(screen.queryByText('settings.confettiOnComplete')).not.toBeInTheDocument()
    expect(screen.queryByText('Debug and Paths')).not.toBeInTheDocument()
    expect(screen.queryByText('settings.remoteHosts')).not.toBeInTheDocument()
  })

  it('saves the island effect choice from the appearance page', async () => {
    useThemeStore.setState({ colorTheme: 'midnight' })
    render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '外观设置' }))

    const frosted = await screen.findByRole('radio', { name: /磨砂玻璃/ })
    expect(screen.getByRole('radio', { name: /纯黑/ })).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(frosted)

    expect(useThemeStore.getState().colorTheme).toBe('frosted-glass')
    expect(document.documentElement.getAttribute('data-island-color-theme')).toBe('frosted-glass')
    expect(frosted).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(screen.getByRole('radio', { name: /纯黑/ }))
    expect(useThemeStore.getState().colorTheme).toBe('midnight')
  })

  it('does not report midnight selected when another color theme is saved', async () => {
    useThemeStore.setState({ colorTheme: 'warm-paper' })
    render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '外观设置' }))

    const midnight = await screen.findByRole('radio', { name: /纯黑/ })
    expect(midnight).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('radio', { name: /磨砂玻璃/ })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText(/当前使用其他配色主题/)).toBeInTheDocument()

    fireEvent.click(midnight)
    expect(useThemeStore.getState().colorTheme).toBe('midnight')
    await waitFor(() => expect(midnight).toHaveAttribute('aria-checked', 'true'))
  })

  it('removes the large island preview while keeping both effect choices', async () => {
    render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '外观设置' }))

    expect(await screen.findByRole('radio', { name: /纯黑/ })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /磨砂玻璃/ })).toBeInTheDocument()
    expect(screen.getByText(/选择一种外观效果/)).toBeInTheDocument()
    expect(document.querySelector('.island-effect-picker')).not.toBeNull()
    expect(document.querySelector('.island-effect-preview')).toBeNull()
  })

  it('opens the user-level Skills overview with honest distribution categories', async () => {
    render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Skill管理' }))

    expect(await screen.findByRole('heading', { name: 'Skills' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /全部（中心库）/ })).toBeInTheDocument()
    expect(screen.getByText(/仅用户级 Skills/)).toBeInTheDocument()
    expect(screen.getByText(/没有「通用 \/ 专属」自动分配能力/)).toBeInTheDocument()
    expect(screen.queryByText(/通用分类来自中心库/)).not.toBeInTheDocument()
  })

  it('keeps the six primary navigation entries on the island page', async () => {
    const { container } = render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByText('外观设置'))

    await waitFor(() => expect(screen.getByText('settings.tipsEnabled')).toBeInTheDocument())
    const labels = Array.from(
      container.querySelectorAll('.settings-sidebar__item:not([hidden]) .settings-sidebar__label-text'),
    ).map((item) => item.textContent?.trim())
    expect(labels).toEqual(['任务看板', '使用额度', 'Skill管理', 'Agent管理', '外观设置', '通用设置'])
    expect(container.querySelector('.settings-capability-nav')).not.toBeInTheDocument()
    const islandTabs = Array.from(container.querySelectorAll('.island-view-tabs button'))
      .map((button) => button.textContent?.trim())
    expect(islandTabs).toEqual(['Overview', 'Display', 'Behavior', 'Integration', 'Shortcuts', 'Advanced'])
  })

  it('returns to general settings from the island page via the primary navigation', async () => {
    render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByText('外观设置'))

    await waitFor(() => expect(screen.getByText('settings.tipsEnabled')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '通用设置' }))

    await waitFor(() => expect(screen.getByText('settings.language')).toBeInTheDocument())
    expect(screen.queryByText('settings.tipsEnabled')).not.toBeInTheDocument()
  })

  it('shows tips toggle in island overview and preserves follow focus when persisting it', async () => {
    useConfigStore.setState({ followFocus: true, tipsEnabled: true })

    render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByText('外观设置'))

    await waitFor(() => expect(screen.getByText('settings.tipsEnabled')).toBeInTheDocument())
    const tipsRow = screen.getByText('settings.tipsEnabled').closest('.setting-row')
    fireEvent.click(tipsRow!.querySelector('[role="switch"]')!)

    expect(tauriMocks.setIslandFeatureFlags).toHaveBeenCalledWith(expect.objectContaining({
      tipsEnabled: false,
      followFocus: true,
    }))
  })

  it('uses interaction mode cards as presets and marks manual changes as custom', async () => {
    useConfigStore.setState({
      interactionMode: 'persistent',
      smartSuppression: true,
      autoHideNoSessions: false,
      idleCompactDwellSeconds: 8,
      noSessionsHideDelay: 10,
    })

    render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByText('外观设置'))
    fireEvent.click(await screen.findByText('Quiet Assistant'))

    expect(useConfigStore.getState()).toEqual(expect.objectContaining({
      interactionMode: 'minimal',
      smartSuppression: true,
      autoHideNoSessions: true,
      idleCompactDwellSeconds: 8,
      noSessionsHideDelay: 10,
    }))
    expect(screen.queryByText('Custom visibility')).not.toBeInTheDocument()

    const autoHideRow = screen.getByText('settings.autoHideNoSessions').closest('.setting-row')
    fireEvent.click(autoHideRow!.querySelector('[role="switch"]')!)

    await waitFor(() => expect(screen.getByText('Custom visibility')).toBeInTheDocument())
  })

  it('shows the primary display label instead of a stale raw display id', async () => {
    useConfigStore.setState({ displayMonitor: '14035' })
    tauriMocks.listDisplays.mockResolvedValue([
      {
        id: 'Color LCD',
        name: 'Color LCD',
        label: 'Color LCD (1728x1117)',
        width: 3456,
        height: 2234,
        scaleFactor: 2,
        isPrimary: true,
      },
    ])

    render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByText('外观设置'))
    fireEvent.click(await screen.findByRole('button', { name: /Display/ }))

    await waitFor(() => {
      expect(screen.getByText('settings.mainDisplay · Color LCD (1728x1117)')).toBeInTheDocument()
    })
    expect(screen.queryByText('14035')).not.toBeInTheDocument()
  })

  it('passes custom notch height through the layout preview event', async () => {
    useConfigStore.setState({ notchHeightMode: 'custom', customNotchHeight: 40 })
    const { container } = render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByText('外观设置'))
    fireEvent.click(await screen.findByRole('button', { name: /Display/ }))

    await waitFor(() => expect(screen.getByText('settings.customNotchHeight')).toBeInTheDocument())
    const customRow = screen.getByText('settings.customNotchHeight').closest('.setting-row')
    const slider = customRow!.querySelector<HTMLInputElement>('input[type="range"]')!
    fireEvent.change(slider, { target: { value: '55' } })

    expect(tauriMocks.previewIslandLayout).toHaveBeenCalledWith('compact', expect.objectContaining({
      notchHeightMode: 'custom',
      customNotchHeight: 55,
    }))
    expect(container.querySelector('.island-tabs')).not.toBeInTheDocument()
  })

  it('previews the notification card max height from display settings', async () => {
    useConfigStore.setState({ completionCardHeight: 200 })
    render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByText('外观设置'))
    fireEvent.click(await screen.findByRole('button', { name: /Display/ }))

    await waitFor(() => expect(screen.getByText('settings.completionCardHeight')).toBeInTheDocument())
    const row = screen.getByText('settings.completionCardHeight').closest('.setting-row')
    const slider = row!.querySelector<HTMLInputElement>('input[type="range"]')!
    expect(slider).toHaveAttribute('max', '420')

    fireEvent.change(slider, { target: { value: '360' } })

    expect(tauriMocks.previewIslandLayout).toHaveBeenCalledWith('completion', expect.objectContaining({
      completionCardHeight: 360,
    }))
  })

  it('applies and previews the side island size tier from display settings', async () => {
    useConfigStore.setState({ sideIslandSize: 'narrow' })
    render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByText('外观设置'))
    fireEvent.click(await screen.findByRole('button', { name: /Display/ }))

    await waitFor(() => expect(screen.getByText('Side Island Size')).toBeInTheDocument())
    const row = screen.getByText('Side Island Size').closest('.setting-row')!
    expect(row).toHaveTextContent('Narrow')

    fireEvent.click(row.querySelector('.glass-dropdown__trigger')!)
    fireEvent.click(screen.getByText('Wide'))

    expect(useConfigStore.getState().sideIslandSize).toBe('wide')
    expect(tauriMocks.previewIslandLayout).toHaveBeenCalledWith('compact', expect.objectContaining({
      sideIslandSize: 'wide',
    }))
  })

  it('records and clears in-window shortcuts from the shortcuts page', async () => {
    render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByText('外观设置'))
    fireEvent.click(await screen.findByRole('button', { name: /Shortcuts/ }))

    await waitFor(() => expect(screen.getByText('Toggle Panel')).toBeInTheDocument())
    expect(screen.getByText('Collapse Panel')).toBeInTheDocument()
    expect(screen.getByText('Open Settings')).toBeInTheDocument()
    expect(screen.queryByText('Expand Panel')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Show advanced shortcuts/ }))
    await waitFor(() => expect(screen.getByText('Expand Panel')).toBeInTheDocument())
    const row = screen.getByText('Expand Panel').closest('.shortcuts-row')!
    const editButtons = row.querySelectorAll('.shortcuts-row__edit')
    fireEvent.click(editButtons[editButtons.length - 1]!)
    fireEvent.keyDown(window, { key: 'k', metaKey: isApplePlatform(), ctrlKey: !isApplePlatform(), shiftKey: true })

    const expectedShortcut = isApplePlatform() ? '⌘+⇧+K' : 'Ctrl+Shift+K'
    const expectedParts = isApplePlatform() ? ['⌘', '⇧', 'K'] : ['Ctrl', 'Shift', 'K']
    expect(useConfigStore.getState().shortcuts.find((shortcut) => shortcut.action === 'expand-panel')?.keys).toBe(expectedShortcut)
    for (const part of expectedParts) expect(row).toHaveTextContent(part)

    fireEvent.click(row.querySelector('.shortcuts-row__clear')!)

    expect(useConfigStore.getState().shortcuts.find((shortcut) => shortcut.action === 'expand-panel')?.keys).toBe('')
    expect(row).toHaveTextContent('Off')
  })

  it('syncs global shortcut controls and rolls back failed native registration', async () => {
    tauriMocks.setGlobalActionShortcuts.mockRejectedValueOnce(new Error('already registered'))
    render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByText('外观设置'))
    fireEvent.click(await screen.findByRole('button', { name: /Shortcuts/ }))

    await waitFor(() => expect(screen.getByText('Approve current permission')).toBeInTheDocument())
    const row = screen.getByText('Approve current permission').closest('.setting-row')!
    fireEvent.click(row.querySelector('[role="switch"]')!)

    expect(tauriMocks.setGlobalActionShortcuts).toHaveBeenCalledWith(expect.objectContaining({
      approve: 'CommandOrControl+Shift+A',
      approveEnabled: true,
    }))
    await waitFor(() => expect(useConfigStore.getState().shortcutApproveEnabled).toBe(false))
    expect(screen.getByRole('alert')).toHaveTextContent('already registered')
  })
})
