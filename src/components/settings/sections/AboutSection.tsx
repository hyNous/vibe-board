import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { open } from '@tauri-apps/plugin-shell'
import { save } from '@tauri-apps/plugin-dialog'
import { exportDiagnostics, getCurrentAppVersion } from '../../../services/tauriApi'
import { useSettingsToast } from '../../../stores/settingsToastStore'
import type { UpdateStatus } from '../../../hooks/useUpdater'
import { SettingDetails } from '../SettingDetails'
import './AboutSection.css'

interface AboutSectionProps {
  updateStatus?: UpdateStatus
  updateVersion?: string | null
  updateError?: string | null
  updateRestartPending?: boolean
  updateRestartBlockedByActivity?: boolean
  updateBlockingSessionCount?: number
  onCheckForUpdate?: () => void
}

// The distribution repositories still live under their published names, so the
// repository URL stays external while the product name is Vibe Board.
const REPOSITORY_URL = ((import.meta.env.VITE_VIBEBOARD_REPOSITORY_URL ?? import.meta.env.VITE_AGENT_ISLAND_REPOSITORY_URL ?? '').trim() || 'https://github.com/hyNous/agent-island').replace(/\/$/, '')
const REPO_ISSUES_URL = `${REPOSITORY_URL}/issues/new`
const REPO_RELEASES_URL = `${REPOSITORY_URL}/releases`

function ExternalArrow() {
  return (
    <svg aria-hidden="true" className="about-settings__arrow" viewBox="0 0 16 16" fill="none">
      <path d="M5 11l6-6M6 5h5v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function AboutSection({
  updateStatus,
  updateVersion,
  updateError,
  updateRestartPending = false,
  updateRestartBlockedByActivity = false,
  updateBlockingSessionCount = 0,
  onCheckForUpdate,
}: AboutSectionProps) {
  const { t } = useTranslation()
  const showToast = useSettingsToast((state) => state.show)
  const [diagStatus, setDiagStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [appVersion, setAppVersion] = useState<string>('...')

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
      const defaultName = `Vibe Board-Diagnostics-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.zip`
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
      showToast(t('settings.exportSaved', { defaultValue: '已保存！' }))
      setTimeout(() => setDiagStatus('idle'), 2000)
    } catch {
      setDiagStatus('error')
      setTimeout(() => setDiagStatus('idle'), 2000)
    }
  }

  const busy = updateStatus === 'checking' || updateStatus === 'downloading'
  const updateAvailable = updateStatus === 'available' || updateStatus === 'ready'

  const updateDescription = (() => {
    switch (updateStatus) {
      case 'checking': return t('settings.updateChecking', { defaultValue: '正在检查更新...' })
      case 'available':
        return t('settings.updateAvailable', { version: updateVersion, defaultValue: `发现新版本 ${updateVersion}` })
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

  const exportLabel = diagStatus === 'saved'
    ? t('settings.exportSaved', { defaultValue: '已保存！' })
    : diagStatus === 'error'
      ? t('settings.exportFailed', { defaultValue: '导出失败' })
      : t('settings.exportDiagnostics', { defaultValue: '导出诊断包' })

  return (
    <section className="about-settings">
      <div className={`about-settings__island${updateAvailable ? ' about-settings__island--found' : ''}`}>
        <span className="about-settings__mark">
          <img src="/vibe-board-app-icon.png" alt="" aria-hidden="true" />
        </span>
        <div className="about-settings__text">
          <b>{`Vibe Board ${appVersion}`}</b>
          <span data-testid="about-update-status">
            {updateStatus === 'checking' && <i className="about-settings__spin" aria-hidden="true" />}
            {updateDescription}
          </span>
        </div>
        <button
          type="button"
          className={`vb-btn about-settings__check${updateAvailable ? ' vb-btn--primary' : ''}`}
          disabled={busy}
          onClick={() => onCheckForUpdate?.()}
        >
          {t('settings.checkForUpdates', { defaultValue: '检查更新' })}
        </button>
      </div>

      <p className="about-settings__line">{t('notch.slogan')}</p>

      <div className="about-settings__links">
        {REPO_RELEASES_URL && (
          <button type="button" className="about-settings__link" onClick={() => openExternalLink(REPO_RELEASES_URL)}>
            {t('settings.releases', { defaultValue: '发布版本' })}
            <ExternalArrow />
          </button>
        )}
        {REPO_ISSUES_URL && (
          <button type="button" className="about-settings__link" onClick={() => openExternalLink(REPO_ISSUES_URL)}>
            {t('settings.reportBug', { defaultValue: '报告 Bug' })}
            <ExternalArrow />
          </button>
        )}
        <button
          type="button"
          className="about-settings__link"
          data-testid="about-export-diagnostics"
          disabled={diagStatus === 'saving'}
          onClick={() => void handleExportDiagnostics()}
        >
          {exportLabel}
        </button>
      </div>

      <p className="about-settings__note">
        {`${t('settings.aboutDiagnosticsNote', { defaultValue: '诊断包不含你的代码和对话内容' })} · Apache-2.0 · ${t('settings.copyright')}`}
      </p>

      {updateStatus === 'error' && updateError && (
        <div className="about-settings__error" role="alert">
          <SettingDetails testId="about-update-error-details">{updateError}</SettingDetails>
        </div>
      )}
    </section>
  )
}
