import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsApp } from '../components/settings/SettingsApp'
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
        .replace('{{name}}', (options as { name?: string })?.name ?? '')
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
  detected: true,
  loginExpiresAt: null,
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
  detected: true,
  loginExpiresAt: null,
}

describe('settings island menu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tauriMocks.listDisplays.mockResolvedValue([])
    tauriMocks.registerGlobalShortcut.mockResolvedValue(undefined)
    tauriMocks.setIslandSurfaceOptions.mockResolvedValue(undefined)
    tauriMocks.listUsageProviders.mockResolvedValue([])
    tauriMocks.updateConfig.mockResolvedValue(undefined)
    tauriMocks.isTauri.mockReturnValue(false)
    useConfigStore.setState({
      displayMonitor: 'auto',
      followFocus: false,
      tipsEnabled: true,
      setupWizardCompleted: true,
      globalShortcut: 'CommandOrControl+Shift+I',
    })
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
    expect(screen.getByRole('radio', { name: /磨砂玻璃/ })).toHaveAttribute('aria-checked', 'true')

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

  it('shows tips toggle in island overview and preserves follow focus when persisting it', async () => {
    useConfigStore.setState({ followFocus: true, tipsEnabled: true })

    render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '外观' }))

    await waitFor(() => expect(screen.getByText('settings.tipsEnabled')).toBeInTheDocument())
    const tipsRow = screen.getByText('settings.tipsEnabled').closest('.island-look__row')
    fireEvent.click(tipsRow!.querySelector('[role="switch"]')!)

    expect(tauriMocks.setIslandFeatureFlags).toHaveBeenCalledWith(expect.objectContaining({
      tipsEnabled: false,
      followFocus: true,
    }))
  })

  it('uses the visibility segmented control as presets and marks manual changes as custom', async () => {
    useConfigStore.setState({
      interactionMode: 'persistent',
      smartSuppression: true,
      autoHideNoSessions: false,
      idleCompactDwellSeconds: 8,
      noSessionsHideDelay: 10,
    })

    render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '外观' }))
    fireEvent.click(await screen.findByRole('radio', { name: 'Quiet Assistant' }))

    expect(useConfigStore.getState()).toEqual(expect.objectContaining({
      interactionMode: 'minimal',
      smartSuppression: true,
      autoHideNoSessions: true,
      idleCompactDwellSeconds: 8,
      noSessionsHideDelay: 10,
    }))
    expect(screen.queryByText('Custom visibility')).not.toBeInTheDocument()

    const suppressRow = screen.getByText('settings.smartSuppression').closest('.island-look__row')
    fireEvent.click(suppressRow!.querySelector('[role="switch"]')!)

    // The whole settings app re-renders here; allow for a busy parallel test run.
    await waitFor(() => expect(screen.getByText('Custom visibility')).toBeInTheDocument(), { timeout: 3_000 })
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

    fireEvent.click(screen.getByRole('button', { name: /Show more shortcuts/ }))
    await waitFor(() => expect(screen.getByText('Expand Panel')).toBeInTheDocument())
    const row = screen.getByText('Expand Panel').closest('.shortcut-row')!
    fireEvent.click(row.querySelector('.shortcut-row__edit')!)
    fireEvent.keyDown(window, { key: 'k', metaKey: isApplePlatform(), ctrlKey: !isApplePlatform(), shiftKey: true })

    const expectedShortcut = isApplePlatform() ? '⌘+⇧+K' : 'Ctrl+Shift+K'
    const expectedParts = isApplePlatform() ? ['⌘', '⇧', 'K'] : ['Ctrl', 'Shift', 'K']
    expect(useConfigStore.getState().shortcuts.find((shortcut) => shortcut.action === 'expand-panel')?.keys).toBe(expectedShortcut)
    for (const part of expectedParts) expect(row).toHaveTextContent(part)

    fireEvent.click(row.querySelector('.shortcut-row__clear')!)

    expect(useConfigStore.getState().shortcuts.find((shortcut) => shortcut.action === 'expand-panel')?.keys).toBe('')
    expect(row).toHaveTextContent('Not set')
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
    expect(screen.getByRole('alert')).toHaveTextContent('这个组合键没能生效')
    fireEvent.click(screen.getByTestId('shortcut-error-details'))
    expect(screen.getByTestId('shortcut-error-details-body')).toHaveTextContent('already registered')
  })

  it('requires confirmation before enabling a provider online query', async () => {
    tauriMocks.listUsageProviders.mockResolvedValue([providerFixture])
    tauriMocks.setUsageNetworkAuthorization.mockResolvedValue(['codex'])
    render(<SettingsApp onClose={vi.fn()} />)
    tauriMocks.isTauri.mockReturnValue(true)

    fireEvent.click(screen.getByRole('button', { name: '使用额度' }))
    const providerRow = await screen.findByTestId('usage-provider-codex')
    expect(providerRow).toHaveTextContent('未开启联网查询（默认关闭）')

    fireEvent.click(within(providerRow).getByRole('switch'))

    // Nothing is authorized until the user confirms the described request.
    expect(tauriMocks.setUsageNetworkAuthorization).not.toHaveBeenCalled()
    const confirm = await within(providerRow).findByTestId('usage-network-confirm-codex')
    expect(confirm).toHaveTextContent('codex app-server (JSON-RPC account/rateLimits/read)')
    expect(confirm).toHaveTextContent('/home/user/.codex/auth.json')

    fireEvent.click(within(confirm).getByText('允许查询'))
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
    expect(codexRow).toHaveTextContent('已开启联网查询')

    fireEvent.click(within(codexRow).getByRole('switch'))

    // Revoking needs no confirmation and takes effect right away.
    await waitFor(() => expect(tauriMocks.setUsageNetworkAuthorization).toHaveBeenCalledWith('codex', false))
    expect(within(codexRow).queryByTestId('usage-network-confirm-codex')).not.toBeInTheDocument()

    const claudeRow = await screen.findByTestId('usage-provider-claude-code')
    expect(claudeRow).toHaveTextContent('这个工具暂不支持联网查询')
    expect(within(claudeRow).queryByRole('switch')).not.toBeInTheDocument()
  })

  it('turns the query back off and says why when the first query fails', async () => {
    tauriMocks.listUsageProviders.mockResolvedValue([{ ...providerFixture, networkAuthorized: false }])
    tauriMocks.setUsageNetworkAuthorization.mockResolvedValue([])
    render(<SettingsApp onClose={vi.fn()} />)
    tauriMocks.isTauri.mockReturnValue(true)

    fireEvent.click(screen.getByRole('button', { name: '使用额度' }))
    const codexRow = await screen.findByTestId('usage-provider-codex')
    fireEvent.click(within(codexRow).getByRole('switch'))
    const confirm = await within(codexRow).findByTestId('usage-network-confirm-codex')

    tauriMocks.listUsageProviders.mockResolvedValue([{
      ...providerFixture,
      networkAuthorized: true,
      state: 'failed',
      detail: 'OpenCode usage request failed: HTTP 401',
    }])
    fireEvent.click(within(confirm).getByRole('button', { name: '允许查询' }))

    await waitFor(() => expect(tauriMocks.setUsageNetworkAuthorization).toHaveBeenCalledWith('codex', false))
    expect(tauriMocks.setUsageNetworkAuthorization).toHaveBeenCalledWith('codex', true)
    expect(await screen.findByText(/已自动关闭查询/)).toHaveTextContent('登录信息无效或已过期')
  })

  it('reminds the user shortly before a login can no longer renew itself', async () => {
    const day = 24 * 60 * 60 * 1000
    tauriMocks.listUsageProviders.mockResolvedValue([
      { ...providerFixture, loginExpiresAt: Date.now() + day },
      { ...providerFixture, provider: 'opencode', label: 'OpenCode', loginExpiresAt: Date.now() + 10 * day },
    ])
    render(<SettingsApp onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '使用额度' }))
    expect(await screen.findByTestId('usage-login-reminder-codex')).toHaveTextContent('到期')
    expect(screen.queryByTestId('usage-login-reminder-opencode')).not.toBeInTheDocument()
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
    fireEvent.click(screen.getByRole('button', { name: '重新检查' }))

    expect(await within(providerRow).findByTestId('usage-provider-querying-codex'))
      .toHaveTextContent('正在查询…')

    resolveProviders?.([])
    await waitFor(() =>
      expect(within(providerRow).queryByTestId('usage-provider-querying-codex')).not.toBeInTheDocument())
  })
})
