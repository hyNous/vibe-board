import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { UpdateDialog } from '../components/settings/UpdateDialog'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; percent?: number }) => {
      const translations: Record<string, string> = {
        'update.availableTitle': 'Update Available',
        'update.readyTitle': 'Update Ready',
        'update.later': 'Later',
        'update.install': 'Install & Restart',
        'update.downloading': 'Downloading...',
        'update.restart': 'Restart Now',
        'update.restartHint': 'Update ready. Restart to finish installation.',
        'update.downloadInBackground': 'Download in Background',
        'update.miniReadyRestart': 'Update ready — click to restart',
      }
      if (key === 'update.miniDownloading') return `Downloading ${options?.percent ?? 0}%`
      return translations[key] ?? options?.defaultValue ?? key
    },
    i18n: { language: 'en' },
  }),
}))

function baseProps() {
  return {
    version: '0.3.0',
    notes: 'Some notes',
    date: null,
    manualDownloadUrl: null,
    onMinimize: vi.fn(),
    onExpand: vi.fn(),
    onInstall: vi.fn(),
    onDismiss: vi.fn(),
  }
}

describe('UpdateDialog non-blocking download', () => {
  it('lets the user background the download instead of disabling the close path', () => {
    const props = baseProps()
    const { container } = render(
      <UpdateDialog
        {...props}
        status="downloading"
        downloadProgress={{ downloaded: 50, total: 100, percent: 50 }}
      />,
    )

    // Footer secondary button becomes "Download in Background" and is NOT disabled.
    const footerButtons = container.querySelectorAll<HTMLButtonElement>('.update-dialog__footer .update-dialog__button')
    const bg = footerButtons[0]
    expect(bg).toHaveTextContent('Download in Background')
    expect(bg).toBeEnabled()
    fireEvent.click(bg)
    expect(props.onMinimize).toHaveBeenCalledTimes(1)
    expect(props.onDismiss).not.toHaveBeenCalled()
  })

  it('close (×) during download minimizes rather than dismissing', () => {
    const props = baseProps()
    const { container } = render(
      <UpdateDialog
        {...props}
        status="downloading"
        downloadProgress={{ downloaded: 50, total: 100, percent: 50 }}
      />,
    )
    const close = container.querySelector<HTMLButtonElement>('.update-dialog__close')!
    expect(close).toBeEnabled()
    fireEvent.click(close)
    expect(props.onMinimize).toHaveBeenCalledTimes(1)
    expect(props.onDismiss).not.toHaveBeenCalled()
  })

  it('renders a floating mini bar when minimized mid-download and expands on click', () => {
    const props = baseProps()
    const { container } = render(
      <UpdateDialog
        {...props}
        status="downloading"
        minimized
        downloadProgress={{ downloaded: 42, total: 100, percent: 42 }}
      />,
    )
    // Full overlay is gone; mini bar is shown instead.
    expect(container.querySelector('.update-dialog-overlay')).toBeNull()
    const mini = container.querySelector<HTMLButtonElement>('.update-mini')!
    expect(mini).toBeInTheDocument()
    expect(screen.getByText('Downloading 42%')).toBeInTheDocument()
    fireEvent.click(mini)
    expect(props.onExpand).toHaveBeenCalledTimes(1)
  })

  it('minimized + ready bar triggers install (restart) on click', () => {
    const props = baseProps()
    const { container } = render(
      <UpdateDialog
        {...props}
        status="ready"
        minimized
        downloadProgress={{ downloaded: 100, total: 100, percent: 100 }}
      />,
    )
    const mini = container.querySelector<HTMLButtonElement>('.update-mini')!
    fireEvent.click(mini)
    expect(props.onInstall).toHaveBeenCalledTimes(1)
    expect(props.onExpand).not.toHaveBeenCalled()
  })

  it('non-download state keeps the classic dismiss-on-close behavior', () => {
    const props = baseProps()
    const { container } = render(<UpdateDialog {...props} status="available" downloadProgress={null} />)
    const close = container.querySelector<HTMLButtonElement>('.update-dialog__close')!
    fireEvent.click(close)
    expect(props.onDismiss).toHaveBeenCalledTimes(1)
    expect(props.onMinimize).not.toHaveBeenCalled()
  })

  it('keeps the ready hint outside the scrollable release notes area', () => {
    const props = baseProps()
    const { container } = render(<UpdateDialog {...props} status="ready" downloadProgress={null} />)
    const status = container.querySelector('.update-dialog__status')
    const body = container.querySelector('.update-dialog__body')

    expect(status).toHaveTextContent('Update ready. Restart to finish installation.')
    expect(body).not.toHaveTextContent('Update ready. Restart to finish installation.')
  })
})
