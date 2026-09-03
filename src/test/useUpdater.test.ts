import { describe, expect, it } from 'vitest'
import { selectReleaseDownloadAsset } from '../hooks/useUpdater'

const assets = [
  {
    name: 'Agent Island_latest_universal.dmg',
    browser_download_url: 'https://example.com/Agent Island_latest_universal.dmg',
  },
  {
    name: 'Agent Island_latest_x64.msi',
    browser_download_url: 'https://example.com/Agent Island_latest_x64.msi',
  },
  {
    name: 'Agent Island_latest_x64-setup.exe',
    browser_download_url: 'https://example.com/Agent Island_latest_x64-setup.exe',
  },
]

describe('selectReleaseDownloadAsset', () => {
  it('prefers the Windows setup executable on Windows', () => {
    expect(selectReleaseDownloadAsset(assets, 'windows')?.name).toBe('Agent Island_latest_x64-setup.exe')
  })

  it('falls back to the Windows MSI when the setup executable is absent', () => {
    expect(selectReleaseDownloadAsset(assets.slice(0, 2), 'windows')?.name).toBe('Agent Island_latest_x64.msi')
  })

  it('keeps the universal DMG for macOS', () => {
    expect(selectReleaseDownloadAsset(assets, 'macos')?.name).toBe('Agent Island_latest_universal.dmg')
  })

})
