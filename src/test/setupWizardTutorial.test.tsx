import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsApp } from '../components/settings'
import { SetupWizard } from '../components/settings/SetupWizard'
import { useConfigStore } from '../stores/configStore'

const tauriMocks = vi.hoisted(() => ({
  detectTools: vi.fn(() => Promise.resolve([])),
  getAllHookStatus: vi.fn(() => Promise.resolve([])),
  getConfig: vi.fn(() => Promise.resolve({ setupWizardCompleted: false, autoLaunchAgents: [] as string[] })),
  updateConfig: vi.fn(() => Promise.resolve()),
  openTutorialWindow: vi.fn(() => Promise.resolve()),
  isTauri: vi.fn(() => false),
}))

vi.mock('../services/tauriApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tauriApi')>()
  return {
    ...actual,
    detectTools: tauriMocks.detectTools,
    getAllHookStatus: tauriMocks.getAllHookStatus,
    getConfig: tauriMocks.getConfig,
    updateConfig: tauriMocks.updateConfig,
    openTutorialWindow: tauriMocks.openTutorialWindow,
    isTauri: tauriMocks.isTauri,
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'zh' },
  }),
}))

vi.mock('../components/settings/sections/AgentMonitorSection', () => ({
  AgentMonitorSection: () => <section><h2>Tasks</h2></section>,
}))

// jsdom has no Tauri window; the settings window subscribes to its native close
// event on mount whenever isTauri() reports true.
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    label: 'settings',
    onCloseRequested: () => Promise.resolve(() => {}),
    close: () => Promise.resolve(),
  }),
}))

describe('first-run wizard tutorial step', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tauriMocks.detectTools.mockResolvedValue([])
    tauriMocks.getAllHookStatus.mockResolvedValue([])
    tauriMocks.updateConfig.mockResolvedValue(undefined)
    tauriMocks.openTutorialWindow.mockResolvedValue(undefined)
    tauriMocks.isTauri.mockReturnValue(false)
    useConfigStore.setState({
      setupWizardCompleted: false,
      autoLaunchAgents: [],
      autoCheckUpdate: false,
    })
  })

  it('shows the four tutorial themes for a fresh configuration', async () => {
    tauriMocks.isTauri.mockReturnValue(true)
    tauriMocks.getConfig.mockResolvedValue({ setupWizardCompleted: false, autoLaunchAgents: [] })
    render(<SettingsApp onClose={vi.fn()} />)

    expect(await screen.findByText('让 Vibe Board 跟着你的 Agent 工作')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /继续/ }))

    expect(screen.getByText('岛怎么用')).toBeInTheDocument()
    expect(screen.getByText('看板在显示什么')).toBeInTheDocument()
    expect(screen.getByText('点任务会发生什么')).toBeInTheDocument()
    expect(screen.getByText('Agent 接入')).toBeInTheDocument()
  })

  it.each([
    ['稍后设置', 'the skip button'],
    ['关闭', 'the close button'],
  ])('returns to the settings page instead of closing the window via %s (%s)', async (name) => {
    tauriMocks.isTauri.mockReturnValue(true)
    tauriMocks.getConfig.mockResolvedValue({ setupWizardCompleted: false, autoLaunchAgents: [] })
    const onClose = vi.fn()
    render(<SettingsApp onClose={onClose} />)

    await screen.findByText('让 Vibe Board 跟着你的 Agent 工作')
    fireEvent.click(screen.getByRole('button', { name }))

    await waitFor(() => expect(useConfigStore.getState().setupWizardCompleted).toBe(true))
    expect(await screen.findByRole('button', { name: '外观' })).toBeInTheDocument()
    expect(screen.queryByText('让 Vibe Board 跟着你的 Agent 工作')).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('opens the bundled full tutorial from the tour step', async () => {
    render(<SetupWizard onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /继续/ }))
    fireEvent.click(screen.getByRole('button', { name: '打开完整教程' }))

    await waitFor(() => expect(tauriMocks.openTutorialWindow).toHaveBeenCalledTimes(1))
  })

  it('continues from the tour into Agent selection', async () => {
    render(<SetupWizard onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /继续/ }))
    fireEvent.click(screen.getByRole('button', { name: /开始检测/ }))

    expect(screen.getByText('选择要接入的 Agent')).toBeInTheDocument()
  })
})
