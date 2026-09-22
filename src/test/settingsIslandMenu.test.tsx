import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsApp } from '../components/settings'
import type { BackendDisplayInfo, UsageSnapshot } from '../services/tauriApi'
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
  setIslandSurfaceOptions: vi.fn(() => Promise.resolve()),
  setAnalyticsEnabled: vi.fn(() => Promise.resolve()),
  listUsageProviders: vi.fn(() => Promise.resolve([] as UsageSnapshot[])),
  authorizeUsageProvider: vi.fn(() => Promise.resolve()),
  setUsageNetworkAuthorization: vi.fn(() => Promise.resolve([] as string[])),
  updateConfig: vi.fn(() => Promise.resolve()),
  openTutorialWindow: vi.fn(() => Promise.resolve()),
  isTauri: vi.fn(() => false),
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
    setIslandSurfaceOptions: tauriMocks.setIslandSurfaceOptions,
    setAnalyticsEnabled: tauriMocks.setAnalyticsEnabled,
    listUsageProviders: tauriMocks.listUsageProviders,
    authorizeUsageProvider: tauriMocks.authorizeUsageProvider,
    setUsageNetworkAuthorization: tauriMocks.setUsageNetworkAuthorization,
    updateConfig: tauriMocks.updateConfig,
    openTutorialWindow: tauriMocks.openTutorialWindow,
    isTauri: tauriMocks.isTauri,
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

const providerFixture: UsageSnapshot = {
  provider: 'codex',
  label: 'Codex',
  state: 'unauthorized',
  detail: 'authorization required',
  source: 'local',
  fetchedAt: null,
  windows: [],
  history: {
    available: false,
    source: null,
    detail: '',
    sessionsScanned: null,
    tokenEvents: null,
    pricingEffectiveDate: null,
    periods: [],
  },
  enabled: true,
  catalogSupported: true,
  implementationStatus: 'active',
  settingsOrder: 0,
  authStatus: 'missing',
  authPath: '/home/user/.codex/auth.json',
  canAuthorize: true,
  networkSupported: true,
  networkAuthorized: false,
  networkKind: 'cli',
  networkTarget: 'codex app-server (JSON-RPC account/rateLimits/read)',
  networkCredential: '/home/user/.codex/auth.json',
  networkUnsupportedReason: null,
}

const claudeFixture: UsageSnapshot = {
  ...providerFixture,
  provider: 'claude-code',
  label: 'Claude Code',
  settingsOrder: 1,
  authStatus: 'missing',
  authPath: null,
  canAuthorize: false,
  networkSupported: false,
  networkAuthorized: false,
  networkKind: null,
  networkTarget: null,
  networkCredential: null,
  networkUnsupportedReason: 'unverified',
}

describe('settings island menu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tauriMocks.listDisplays.mockResolvedValue([])
    tauriMocks.registerGlobalShortcut.mockResolvedValue(undefined)
    tauriMocks.setIslandSurfaceOptions.mockResolvedValue(undefined)
    tauriMocks.setAnalyticsEnabled.mockResolvedValue(undefined)
    tauriMocks.listUsageProviders.mockResolvedValue([])
    tauriMocks.updateConfig.mockResolvedValue(undefined)
    tauriMocks.isTauri.mockReturnValue(false)
    useConfigStore.setState({
      displayMonitor: 'auto',
      followFocus: false,
      tipsEnabled: true,
      analyticsEnabled: false,
      analyticsConsentPromptCompleted: true,
      setupWizardCompleted: true,
      globalShortcut: 'CommandOrControl+Shift+I',
    })
  })

  it('shows the grouped navigation entries in the required order', () => {
    const { container } = render(<SettingsApp onClose={vi.fn()} />)
    const groups = Array.from(container.querySelectorAll('.settings-sidebar__nav > div')).map((group) => ({
      label: group.querySelector('.settings-sidebar__group-label')?.textContent?.trim() ?? null,
      items: Array.from(group.querySelectorAll('.settings-sidebar__item:not([hidden]) .settings-sidebar__label-text'))
        .map((item) => item.textContent?.trim()),
    }))

    expect(groups).toEqual([
      { label: '运行', items: ['任务看板', '使用额度'] },
      { label: '管理', items: ['Skill', '派发框架'] },
      { label: '外观', items: ['外观'] },
      { label: '快捷键', items: ['快捷键'] },
      { label: '系统', items: ['通用', '重看教程与向导', '关于'] },
    ])
    expect(screen.queryByText('远程服务器')).not.toBeInTheDocument()
    expect(screen.queryByText('Agent Switch')).not.toBeInTheDocument()
    expect(screen.queryByText('Agent管理')).not.toBeInTheDocument()
  })

  it('switches between Tasks, Usage, and General', async () => {
    render(<SettingsApp onClose={vi.fn()} />)

    expect(screen.getByRole('heading', { name: 'Tasks' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '使用额度' }))
    expect(await screen.findByRole('heading', { name: 'Usage' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '通用' }))
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

  it('uses the appearance page tabs instead of top tabs', async () => {
    const { container } = render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '外观' }))

    await waitFor(() => expect(screen.getByRole('button', { name: /Overview/ })).toHaveClass('active'))
    const islandTabs = Array.from(container.querySelectorAll('.island-view-tabs button'))
      .map((button) => button.textContent?.trim())
    expect(islandTabs).toEqual(['Overview', 'Display', 'Behavior', 'Advanced'])
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
  })

  it('keeps Hook diagnostics, detected tools, custom hooks, providers, and shortcuts out of appearance', async () => {
    render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '外观' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Overview/ })).toHaveClass('active'))

    for (const tab of ['Overview', 'Display', 'Behavior', 'Advanced']) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(tab) }))
      await waitFor(() => expect(screen.getByRole('button', { name: new RegExp(tab) })).toHaveClass('active'))
      expect(screen.queryByText('Hook Doctor')).not.toBeInTheDocument()
      expect(screen.queryByText('settings.detectedTools')).not.toBeInTheDocument()
      expect(screen.queryByText('自定义 Hook 配置')).not.toBeInTheDocument()
      expect(screen.queryByText('账号配额')).not.toBeInTheDocument()
      expect(screen.queryByText('Global Shortcuts')).not.toBeInTheDocument()
      expect(screen.queryByText('settings.jumpBeforeSend')).not.toBeInTheDocument()
    }
    expect(tauriMocks.listUsageProviders).not.toHaveBeenCalled()
  })

  it('keeps SSH server management out of the appearance page', async () => {
    render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '外观' }))

    await waitFor(() => expect(screen.getByRole('button', { name: /Overview/ })).toHaveClass('active'))
    expect(screen.queryByText('settings.sshDescription')).not.toBeInTheDocument()
  })

  it('renders Advanced without removed debug and launcher controls', async () => {
    render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '外观' }))
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

    fireEvent.click(screen.getByRole('button', { name: '外观' }))

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

    fireEvent.click(screen.getByRole('button', { name: '外观' }))

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

    fireEvent.click(screen.getByRole('button', { name: '外观' }))

    expect(await screen.findByRole('radio', { name: /纯黑/ })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /磨砂玻璃/ })).toBeInTheDocument()
    expect(screen.getByText(/选择一种外观效果/)).toBeInTheDocument()
    expect(document.querySelector('.island-effect-picker')).not.toBeNull()
    expect(document.querySelector('.island-effect-preview')).toBeNull()
  })

  it('opens the user-level Skills overview with honest effect categories', async () => {
    render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Skill' }))

    expect(await screen.findByRole('heading', { name: 'Skills' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /全部（中心库）/ })).toBeInTheDocument()
    expect(screen.getByText(/仅用户级 Skills/)).toBeInTheDocument()
    expect(screen.getByText(/「通用 \/ 专属」自动分配/)).toBeInTheDocument()
    expect(screen.queryByText(/通用分类来自中心库/)).not.toBeInTheDocument()
  })

  it('returns to general settings from the appearance page via the primary navigation', async () => {
    render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '外观' }))

    await waitFor(() => expect(screen.getByText('settings.tipsEnabled')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '通用' }))

    await waitFor(() => expect(screen.getByText('settings.language')).toBeInTheDocument())
    expect(screen.queryByText('settings.tipsEnabled')).not.toBeInTheDocument()
  })

  it('shows tips toggle in island overview and preserves follow focus when persisting it', async () => {
    useConfigStore.setState({ followFocus: true, tipsEnabled: true })

    render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '外观' }))

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

    fireEvent.click(screen.getByRole('button', { name: '外观' }))
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

    // The whole settings app re-renders here; allow for a busy parallel test run.
    await waitFor(() => expect(screen.getByText('Custom visibility')).toBeInTheDocument(), { timeout: 3_000 })
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

    fireEvent.click(screen.getByRole('button', { name: '外观' }))
    fireEvent.click(await screen.findByRole('button', { name: /Display/ }))

    await waitFor(() => {
      expect(screen.getByText('settings.mainDisplay · Color LCD (1728x1117)')).toBeInTheDocument()
    })
    expect(screen.queryByText('14035')).not.toBeInTheDocument()
  })

  it('passes custom notch height through the layout preview event', async () => {
    useConfigStore.setState({ notchHeightMode: 'custom', customNotchHeight: 40 })
    const { container } = render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '外观' }))
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

    fireEvent.click(screen.getByRole('button', { name: '外观' }))
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

    fireEvent.click(screen.getByRole('button', { name: '外观' }))
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

    fireEvent.click(screen.getByRole('button', { name: '快捷键' }))

    await waitFor(() => expect(screen.getByText('Toggle Panel')).toBeInTheDocument())
    expect(screen.getByText('Collapse Panel')).toBeInTheDocument()
    expect(screen.getByText('Open Settings')).toBeInTheDocument()
    expect(screen.queryByText('Expand Panel')).not.toBeInTheDocument()
    expect(screen.queryByText('Approve current permission')).not.toBeInTheDocument()
    expect(screen.queryByText('Deny current permission')).not.toBeInTheDocument()
    expect(screen.queryByText('Skip current question')).not.toBeInTheDocument()

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

  it('rolls back a failed global toggle shortcut registration', async () => {
    tauriMocks.registerGlobalShortcut.mockRejectedValueOnce(new Error('already registered'))
    render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '快捷键' }))

    const input = await screen.findByDisplayValue('CommandOrControl+Shift+I')
    fireEvent.change(input, { target: { value: 'CommandOrControl+Shift+J' } })
    fireEvent.blur(input)

    expect(tauriMocks.registerGlobalShortcut).toHaveBeenCalledWith('CommandOrControl+Shift+J')
    await waitFor(() => expect(useConfigStore.getState().globalShortcut).toBe('CommandOrControl+Shift+I'))
    expect(screen.getByRole('alert')).toHaveTextContent('already registered')
  })

  it('shows the usage provider settings on the usage page', async () => {
    tauriMocks.listUsageProviders.mockResolvedValue([providerFixture])
    render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '使用额度' }))

    expect(await screen.findByText('账号配额')).toBeInTheDocument()
    expect(screen.getByText('在灵动岛显示额度')).toBeInTheDocument()
    const providerRow = await screen.findByTestId('usage-provider-codex')
    expect(providerRow).toHaveTextContent('Codex')
    expect(providerRow).toHaveTextContent('未授权联网查询')

    tauriMocks.isTauri.mockReturnValue(true)
    fireEvent.click(screen.getByText('打开官方登录'))
    await waitFor(() => expect(tauriMocks.authorizeUsageProvider).toHaveBeenCalledWith('codex'))
  })

  it('requires confirmation before enabling a provider online query', async () => {
    tauriMocks.listUsageProviders.mockResolvedValue([providerFixture])
    tauriMocks.setUsageNetworkAuthorization.mockResolvedValue(['codex'])
    render(<SettingsApp onClose={vi.fn()} />)
    tauriMocks.isTauri.mockReturnValue(true)

    fireEvent.click(screen.getByRole('button', { name: '使用额度' }))
    const providerRow = await screen.findByTestId('usage-provider-codex')
    expect(providerRow).toHaveTextContent('未允许联网查询（默认关闭）')

    fireEvent.click(within(providerRow).getByRole('switch'))

    // Nothing is authorized until the user confirms the described request.
    expect(tauriMocks.setUsageNetworkAuthorization).not.toHaveBeenCalled()
    const confirm = await within(providerRow).findByTestId('usage-network-confirm-codex')
    expect(confirm).toHaveTextContent('codex app-server (JSON-RPC account/rateLimits/read)')
    expect(confirm).toHaveTextContent('/home/user/.codex/auth.json')

    fireEvent.click(within(confirm).getByText('确认开启'))
    await waitFor(() => expect(tauriMocks.setUsageNetworkAuthorization).toHaveBeenCalledWith('codex', true))
  })

  it('cancels a pending online query authorization without changing anything', async () => {
    tauriMocks.listUsageProviders.mockResolvedValue([providerFixture])
    render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '使用额度' }))
    const providerRow = await screen.findByTestId('usage-provider-codex')

    fireEvent.click(within(providerRow).getByRole('switch'))
    fireEvent.click(await within(providerRow).findByText('取消'))

    expect(within(providerRow).queryByTestId('usage-network-confirm-codex')).not.toBeInTheDocument()
    expect(tauriMocks.setUsageNetworkAuthorization).not.toHaveBeenCalled()
  })

  it('revokes an authorized provider immediately and marks unsupported ones', async () => {
    tauriMocks.listUsageProviders.mockResolvedValue([
      { ...providerFixture, networkAuthorized: true },
      claudeFixture,
    ])
    tauriMocks.setUsageNetworkAuthorization.mockResolvedValue([])
    render(<SettingsApp onClose={vi.fn()} />)
    tauriMocks.isTauri.mockReturnValue(true)

    fireEvent.click(screen.getByRole('button', { name: '使用额度' }))
    const codexRow = await screen.findByTestId('usage-provider-codex')
    expect(codexRow).toHaveTextContent('已允许联网查询')

    fireEvent.click(within(codexRow).getByRole('switch'))

    // Revoking needs no confirmation and takes effect right away.
    await waitFor(() => expect(tauriMocks.setUsageNetworkAuthorization).toHaveBeenCalledWith('codex', false))
    expect(within(codexRow).queryByTestId('usage-network-confirm-codex')).not.toBeInTheDocument()

    const claudeRow = await screen.findByTestId('usage-provider-claude-code')
    expect(claudeRow).toHaveTextContent('暂不支持联网查询')
    expect(within(claudeRow).queryByRole('switch')).not.toBeInTheDocument()
  })

  it('marks an authorized provider as querying while the refresh is in flight', async () => {
    tauriMocks.listUsageProviders.mockResolvedValueOnce([{ ...providerFixture, networkAuthorized: true }])
    render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '使用额度' }))
    const providerRow = await screen.findByTestId('usage-provider-codex')

    let resolveProviders: ((providers: UsageSnapshot[]) => void) | undefined
    tauriMocks.listUsageProviders.mockImplementationOnce(
      () => new Promise<UsageSnapshot[]>((resolve) => { resolveProviders = resolve }),
    )
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))

    expect(await within(providerRow).findByTestId('usage-provider-querying-codex'))
      .toHaveTextContent('正在查询…')

    resolveProviders?.([])
    await waitFor(() =>
      expect(within(providerRow).queryByTestId('usage-provider-querying-codex')).not.toBeInTheDocument())
  })

  it('renders the dispatch relationship page inside the settings window', async () => {
    render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '派发框架' }))

    expect(await screen.findByText('派发关系树')).toBeInTheDocument()
    expect(await screen.findByTestId('dispatch-empty-agents')).toBeInTheDocument()
  })

  it('reopens the first-run wizard from the tutorial entry', async () => {
    render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '重看教程与向导' }))

    expect(await screen.findByText('重新打开首次向导')).toBeInTheDocument()
    fireEvent.click(screen.getByText('打开向导'))

    await waitFor(() => expect(tauriMocks.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ setupWizardCompleted: false }),
    ))
    expect(useConfigStore.getState().setupWizardCompleted).toBe(false)
  })

  it('opens the bundled tutorial window from the tutorial entry', async () => {
    render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '重看教程与向导' }))

    expect(await screen.findByText('打开完整教程')).toBeInTheDocument()
    fireEvent.click(screen.getByText('打开教程'))

    await waitFor(() => expect(tauriMocks.openTutorialWindow).toHaveBeenCalledTimes(1))
    expect(tauriMocks.updateConfig).not.toHaveBeenCalled()
  })
})
