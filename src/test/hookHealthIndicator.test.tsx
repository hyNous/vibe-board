import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HookHealthIndicator } from '../components/notch/HookHealthIndicator'
import { CollapsedBar } from '../components/notch/CollapsedBar'
import type { HookDoctorCheck, HookDoctorReport } from '../services/tauriApi'

const healthMocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  runHookDoctor: vi.fn(),
  reinstallAllHooks: vi.fn(),
}))

vi.mock('../services/tauriApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tauriApi')>()
  return {
    ...actual,
    isTauri: healthMocks.isTauri,
    runHookDoctor: healthMocks.runHookDoctor,
    reinstallAllHooks: healthMocks.reinstallAllHooks,
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; count?: number; errors?: string }) => {
      const value = options?.defaultValue ?? key
      return value
        .replace('{{count}}', String(options?.count ?? ''))
        .replace('{{errors}}', options?.errors ?? '')
    },
    i18n: { language: 'en' },
  }),
}))

function check(id: string, label: string, status: HookDoctorCheck['status'], detail: string): HookDoctorCheck {
  return { id, label, status, detail }
}

const sixChecks: HookDoctorCheck[] = [
  check('bridge-binary', 'Bridge binary', 'ok', '/Applications/Vibe Board/bridge'),
  check('bridge-current', 'Bridge version', 'ok', 'Installed hook bridge matches bundled bridge'),
  check('hook-server-tcp', 'Hook server TCP', 'ok', '127.0.0.1:17890'),
  check('installed-hooks', 'Installed hooks', 'warn', '1 adapter config needs reinstall: Claude Code'),
  check('bridge-invocations', 'Bridge invocation trace', 'info', 'No bridge invocations recorded yet'),
  check('platform-integration', 'Windows hook transport', 'info', 'Windows uses TCP hook delivery'),
]

function report(checks: HookDoctorCheck[]): HookDoctorReport {
  return { generatedAt: 1_700_000_000, checks }
}

describe('HookHealthIndicator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    healthMocks.isTauri.mockReturnValue(true)
    healthMocks.reinstallAllHooks.mockResolvedValue([])
  })

  it('stays hidden when every self-check passes', async () => {
    healthMocks.runHookDoctor.mockResolvedValue(report(sixChecks.map((item) => ({ ...item, status: 'ok' }))))

    const { container } = render(<HookHealthIndicator />)

    await waitFor(() => expect(healthMocks.runHookDoctor).toHaveBeenCalled())
    expect(container.querySelector('.hook-health__trigger')).toBeNull()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows the indicator and expands the six self-check results when one fails', async () => {
    healthMocks.runHookDoctor.mockResolvedValue(report(sixChecks))

    render(<HookHealthIndicator />)

    const trigger = await screen.findByRole('button', { name: '1 项通知检查未通过' })
    expect(trigger).toBeInTheDocument()

    fireEvent.click(trigger)

    expect(await screen.findByRole('dialog', { name: '事件通知检查' })).toBeInTheDocument()
    expect(screen.getAllByTestId(/hook-health-check-/)).toHaveLength(6)
    expect(screen.getByText('Agent 的事件通知')).toBeInTheDocument()
    expect(screen.getByText('通知组件文件')).toBeInTheDocument()
    expect(screen.getByText('通知接收服务')).toBeInTheDocument()
    expect(screen.getByText('最近收到的通知')).toBeInTheDocument()
  })

  it('reinstalls hooks from the expanded panel', async () => {
    healthMocks.runHookDoctor
      .mockResolvedValueOnce(report(sixChecks))
      .mockResolvedValue(report(sixChecks.map((item) => ({ ...item, status: 'ok' }))))

    render(<HookHealthIndicator />)

    fireEvent.click(await screen.findByRole('button', { name: '1 项通知检查未通过' }))
    fireEvent.click(await screen.findByText('重新连接'))

    await waitFor(() => expect(healthMocks.reinstallAllHooks).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('已重新连接，请重启对应的 Agent 会话。')).toBeInTheDocument()
    expect(screen.getAllByTestId(/hook-health-check-/)).toHaveLength(6)

    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '事件通知检查' })).not.toBeInTheDocument()
  })


  it('keeps paths and versions out of the default panel and shows them in the raw details', async () => {
    healthMocks.runHookDoctor.mockResolvedValue(report(sixChecks))

    const { container } = render(<HookHealthIndicator />)

    // The closed indicator never shows internal paths or version text.
    await waitFor(() => expect(healthMocks.runHookDoctor).toHaveBeenCalled())
    expect(container.textContent).not.toContain('/Applications/Vibe Board/bridge')
    expect(container.textContent).not.toContain('127.0.0.1:17890')

    fireEvent.click(await screen.findByRole('button', { name: '1 项通知检查未通过' }))
    const panel = await screen.findByRole('dialog', { name: '事件通知检查' })
    // The friendly panel still hides the raw paths.
    expect(panel.textContent).not.toContain('/Applications/Vibe Board/bridge')
    expect(panel.textContent).not.toContain('127.0.0.1:17890')

    fireEvent.click(screen.getByTestId('hook-health-raw-details'))
    const raw = screen.getByTestId('hook-health-raw-details-body')
    expect(raw).toHaveTextContent('/Applications/Vibe Board/bridge')
    expect(raw).toHaveTextContent('127.0.0.1:17890')
    expect(raw).toHaveTextContent('Installed hooks')
  })

  it('is wired into the island status row', async () => {
    healthMocks.runHookDoctor.mockResolvedValue(report(sixChecks))

    const { container } = render(<CollapsedBar sessions={[]} panelState="hover" onCollapse={() => {}} />)

    await waitFor(() => expect(container.querySelector('.hook-health__trigger')).not.toBeNull())
  })
})
