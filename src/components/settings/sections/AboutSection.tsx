import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { open } from '@tauri-apps/plugin-shell'
import { save } from '@tauri-apps/plugin-dialog'
import { exportDiagnostics, getCurrentAppVersion } from '../../../services/tauriApi'
import { HOMEBREW_UPDATE_COMMAND } from '../../../hooks/useUpdater'
import type { UpdateInstallChannel, UpdateStatus } from '../../../hooks/useUpdater'
import { useConfigStore } from '../../../stores/configStore'
import { SettingSection } from '../SettingSection'
import { SettingGroup } from '../SettingGroup'
import { SettingRow } from '../SettingRow'
import { Toggle } from '../Toggle'
import { GlassButton } from '../../shared'

interface AboutSectionProps {
  updateStatus?: UpdateStatus
  updateInstallChannel?: UpdateInstallChannel
  updateVersion?: string | null
  updateError?: string | null
  updateRestartPending?: boolean
  updateRestartBlockedByActivity?: boolean
  updateBlockingSessionCount?: number
  onCheckForUpdate?: () => void
}

const REPOSITORY_URL = ((import.meta.env.VITE_AGENT_ISLAND_REPOSITORY_URL ?? '').trim() || 'https://github.com/hyNous/agent-island').replace(/\/$/, '')
const REPO_ISSUES_URL = `${REPOSITORY_URL}/issues/new`
const REPO_RELEASES_URL = `${REPOSITORY_URL}/releases`

function RowIcon({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span className="about-row-icon" style={{ background: tone }} aria-hidden="true">
      {children}
    </span>
  )
}

function ExternalArrow() {
  return (
    <svg aria-hidden="true" className="about-row-arrow" viewBox="0 0 16 16" fill="none">
      <path d="M5 11l6-6M6 5h5v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function AboutSection({
  updateStatus,
  updateInstallChannel = 'direct',
  updateVersion,
  updateError,
  updateRestartPending = false,
  updateRestartBlockedByActivity = false,
  updateBlockingSessionCount = 0,
  onCheckForUpdate,
}: AboutSectionProps) {
  const { t } = useTranslation()
  const [diagStatus, setDiagStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [appVersion, setAppVersion] = useState<string>('...')

  const autoCheckUpdate = useConfigStore((s) => s.autoCheckUpdate)
  const autoInstallUpdate = useConfigStore((s) => s.autoInstallUpdate)
  const updateConfig = useConfigStore((s) => s.updateConfig)

  useEffect(() => {
    let cancelled = false
    getCurrentAppVersion()
      .then((version) => {
        if (!cancelled) setAppVersion(version)
      })
      .catch(() => {
        if (!cancelled) setAppVersion('dev')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const openExternalLink = (url: string) => {
    open(url).catch((err) => console.warn('[AboutSection] open link:', err))
  }

  const handleExportDiagnostics = async () => {
    setDiagStatus('saving')
    try {
      const now = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      const defaultName = `Agent Island-Diagnostics-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.zip`
      const targetPath = await save({
        defaultPath: defaultName,
        filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
      })
      if (!targetPath) {
        setDiagStatus('idle')
        return
      }
      await exportDiagnostics(targetPath)
      setDiagStatus('saved')
      setTimeout(() => setDiagStatus('idle'), 2000)
    } catch {
      setDiagStatus('error')
      setTimeout(() => setDiagStatus('idle'), 2000)
    }
  }

  const updateDescription = (() => {
    switch (updateStatus) {
      case 'checking': return t('settings.updateChecking', { defaultValue: '正在检查更新...' })
      case 'available':
        return updateInstallChannel === 'homebrew'
          ? t('settings.updateAvailableHomebrew', { version: updateVersion, command: HOMEBREW_UPDATE_COMMAND, defaultValue: `发现新版本 ${updateVersion}。请运行 ${HOMEBREW_UPDATE_COMMAND}` })
          : t('settings.updateAvailable', { version: updateVersion, defaultValue: `发现新版本 ${updateVersion}` })
      case 'downloading': return t('settings.updateDownloading', { version: updateVersion, defaultValue: `正在下载 ${updateVersion}...` })
      case 'ready':
        if (updateRestartBlockedByActivity) {
          return t('settings.updateReadyWaitingIdle', {
            version: updateVersion,
            count: updateBlockingSessionCount,
            defaultValue: `新版本 ${updateVersion} 已就绪，会在当前会话空闲后自动重启安装`,
          })
        }
        if (updateRestartPending) {
          return t('settings.updateReadyAuto', {
            version: updateVersion,
            defaultValue: `新版本 ${updateVersion} 已就绪，会在短暂空闲后自动重启安装`,
          })
        }
        return t('settings.updateReady', { version: updateVersion, defaultValue: `新版本 ${updateVersion} 已就绪，重启后生效` })
      case 'error': return updateError ?? t('settings.updateCheckFailed', { defaultValue: '无法连接更新服务，请稍后重试，或通过“发布版本”手动下载最新版。' })
      case 'up-to-date': return t('settings.latestVersion')
      default: return t('settings.latestVersion')
    }
  })()

  return (
    <SettingSection title={t('settings.aboutTitle')}>
      <div className="about-header">
        <img className="about-header__icon" src="/agent-island-logo.png" alt="" aria-hidden="true" />
        <div className="about-header__name">Agent Island</div>
        <div className="about-header__slogan">{t('notch.slogan')}</div>
        <div className="about-header__version">Version {appVersion}</div>
      </div>

      <SettingGroup>
        <SettingRow label={t('settings.checkForUpdates')} description={updateDescription}>
          <GlassButton
            variant="secondary"
            onClick={() => onCheckForUpdate?.()}
            disabled={updateStatus === 'checking' || updateStatus === 'downloading'}
          >
            {updateStatus === 'checking' || updateStatus === 'downloading' ? '...' : t('settings.checkNow')}
          </GlassButton>
        </SettingRow>
        <SettingRow
          label={t('settings.autoCheckUpdate')}
          description={t('settings.autoCheckUpdateDesc')}
        >
          <Toggle checked={autoCheckUpdate} onChange={(v) => updateConfig('autoCheckUpdate', v)} />
        </SettingRow>
        <SettingRow
          label={t('settings.autoInstallUpdate')}
          description={t('settings.autoInstallUpdateDesc')}
        >
          <Toggle checked={autoInstallUpdate} onChange={(v) => updateConfig('autoInstallUpdate', v)} />
        </SettingRow>
      </SettingGroup>

      <SettingGroup>
        {REPO_RELEASES_URL && <button type="button" className="about-link-row" onClick={() => openExternalLink(REPO_RELEASES_URL)}>
          <RowIcon tone="#AF52DE">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
              <path d="m3.27 6.96 8.73 5.05 8.73-5.05M12 22.08V12" />
            </svg>
          </RowIcon>
          <span className="about-link-row__label">{t('settings.releases')}</span>
          <span className="about-link-row__value">GitHub</span>
          <ExternalArrow />
        </button>}
        {REPO_ISSUES_URL && <button type="button" className="about-link-row" onClick={() => openExternalLink(REPO_ISSUES_URL)}>
          <RowIcon tone="#FF9500">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2">
              <path d="M8 2v3M16 2v3M5 8h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z" />
              <path d="M9 13l2 2 4-4" />
            </svg>
          </RowIcon>
          <span className="about-link-row__label">{t('settings.reportBug')}</span>
          <span className="about-link-row__value">GitHub</span>
          <ExternalArrow />
        </button>}
      </SettingGroup>

      <SettingGroup label={t('settings.logoMeaning', { defaultValue: 'Logo Meaning' })}>
        <div className="about-logo-meaning">
          <img src="/agent-island-logo.png" alt="" aria-hidden="true" />
          <div>
            <strong>{t('settings.logoMeaningTitle', { defaultValue: 'A handshake between people and agents' })}</strong>
            <span>{t('settings.logoMeaningDesc', { defaultValue: 'The center handshake represents collaboration between humans and AI agents. The outer A/B shape comes from Agent Island and resembles two connected agent nodes.' })}</span>
          </div>
        </div>
      </SettingGroup>

      <SettingGroup>
        <SettingRow label={t('settings.exportDiagnostics')} description={t('settings.exportDiagnosticsDesc')}>
          <GlassButton
            variant="secondary"
            onClick={handleExportDiagnostics}
            disabled={diagStatus === 'saving'}
          >
            {diagStatus === 'saved' ? t('settings.exportSaved', { defaultValue: 'Saved!' }) : diagStatus === 'error' ? t('settings.exportFailed', { defaultValue: 'Failed' }) : t('settings.export')}
          </GlassButton>
        </SettingRow>
      </SettingGroup>

      <SettingGroup label={t('settings.credits')}>
        <div className="credits-list" style={{ padding: 'var(--space-sm) 0' }}>
          <div>{t('settings.builtWith')}</div>
          <div>{t('settings.designSystem')}</div>
          <div style={{ marginTop: 'var(--space-sm)', color: '#aeaeb2' }}>
            {t('settings.copyright')}
          </div>
        </div>
      </SettingGroup>

    </SettingSection>
  )
}
