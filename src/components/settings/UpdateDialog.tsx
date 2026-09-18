import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { UpdateStatus } from '../../hooks/useUpdater'

interface UpdateDialogProps {
  version: string
  notes: string | null
  date: string | null
  status: UpdateStatus
  manualDownloadUrl?: string | null
  downloadProgress?: {
    downloaded: number
    total: number | null
    percent: number | null
  } | null
  restartPending?: boolean
  restartBlockedByActivity?: boolean
  blockingSessionCount?: number
  minimized?: boolean
  onMinimize: () => void
  onExpand: () => void
  onInstall: () => void
  onDismiss: () => void
}

export function UpdateDialog({
  version,
  notes,
  date,
  status,
  manualDownloadUrl,
  downloadProgress,
  restartPending = false,
  restartBlockedByActivity = false,
  blockingSessionCount = 0,
  minimized = false,
  onMinimize,
  onExpand,
  onInstall,
  onDismiss,
}: UpdateDialogProps) {
  const { t, i18n } = useTranslation()
  const isDownloading = status === 'downloading'
  const isReady = status === 'ready'
  const isManualDownload = Boolean(manualDownloadUrl) && !isReady
  const progressPercent = downloadProgress?.percent ?? null
  const progressLabel = formatProgress(downloadProgress)
  const localizedNotes = useMemo(
    () => selectLocalizedReleaseNotes(notes, i18n.language),
    [i18n.language, notes],
  )

  // When minimized during an in-flight download (or once it's ready) we collapse
  // the modal into a small floating bar so the user can keep using Settings.
  if (minimized && (isDownloading || isReady)) {
    return (
      <button
        type="button"
        className="update-mini"
        onClick={isReady ? onInstall : onExpand}
        title={isReady ? t('update.miniReadyRestart') : t('update.miniDownloading', { percent: progressPercent ?? 0 })}
      >
        <span className="update-mini__label">
          {isReady
            ? t('update.miniReadyRestart')
            : progressPercent === null
              ? t('update.downloading')
              : t('update.miniDownloading', { percent: progressPercent })}
        </span>
        <span className="update-mini__track">
          <span
            className={`update-mini__bar${progressPercent === null ? ' update-mini__bar--indeterminate' : ''}`}
            style={progressPercent === null ? undefined : { width: `${progressPercent}%` }}
          />
        </span>
      </button>
    )
  }

  const handleCloseClick = isDownloading ? onMinimize : onDismiss
  const handleSecondaryClick = isDownloading ? onMinimize : onDismiss

  return (
    <div className="update-dialog-overlay" onClick={handleCloseClick}>
      <div className="update-dialog" onClick={e => e.stopPropagation()}>
        <div className="update-dialog__header">
          <div>
            <div className="update-dialog__eyebrow">Vibe Board</div>
            <div className="update-dialog__title">
              {isReady ? t('update.readyTitle') : t('update.availableTitle')}
            </div>
          </div>
          <button
            className="update-dialog__close"
            onClick={handleCloseClick}
            aria-label={isDownloading ? t('update.downloadInBackground') : t('update.later')}
          >
            ×
          </button>
        </div>

        <div className="update-dialog__meta">
          <strong>v{version}</strong>
          {date && <span>{new Date(date).toLocaleDateString()}</span>}
        </div>

        <div className="update-dialog__body">
          {localizedNotes ? (
            <ReactMarkdown
              className="update-dialog__markdown"
              remarkPlugins={[remarkGfm]}
            >
              {localizedNotes}
            </ReactMarkdown>
          ) : (
            <div className="update-dialog__empty">
              {t('update.noNotes', { defaultValue: '本次更新暂无详细说明。' })}
            </div>
          )}

        </div>

        {(isDownloading || isReady) && (
          <div className="update-dialog__status">
            {isDownloading && (
              <div className="update-dialog__progress">
                <div className="update-dialog__progress-row">
                  <span>{t('update.downloading')}</span>
                  <span>{progressLabel}</span>
                </div>
                <div className="update-dialog__progress-track">
                  <div
                    className="update-dialog__progress-bar"
                    style={{ width: progressPercent === null ? '36%' : `${progressPercent}%` }}
                  />
                </div>
              </div>
            )}

            {isReady && (
              <div className="update-dialog__ready">
                {restartBlockedByActivity
                  ? t('update.restartWhenIdleHint', { count: blockingSessionCount, defaultValue: 'The update is ready. Vibe Board will restart automatically after active sessions become idle.' })
                  : restartPending
                    ? t('update.restartSoonHint', { defaultValue: 'The update is ready. Vibe Board will restart automatically after a short idle window.' })
                    : t('update.restartHint')}
              </div>
            )}

          </div>
        )}

        <div className="update-dialog__footer">
          <button className="update-dialog__button" onClick={handleSecondaryClick}>
            {isDownloading ? t('update.downloadInBackground') : t('update.later')}
          </button>
          <button
            className="update-dialog__button update-dialog__button--primary"
            onClick={onInstall}
            disabled={isDownloading}
          >
            {isDownloading ? t('update.downloading') : isReady ? t('update.restart') : isManualDownload ? t('update.downloadLatest') : t('update.install')}
          </button>
        </div>
      </div>
    </div>
  )
}

function formatProgress(progress: UpdateDialogProps['downloadProgress']) {
  if (!progress) return ''
  if (progress.percent !== null) return `${progress.percent}%`
  if (progress.downloaded > 0) return formatBytes(progress.downloaded)
  return '...'
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

type ReleaseNotesLanguage = 'en' | 'zh'

function selectLocalizedReleaseNotes(notes: string | null, language: string | undefined): string | null {
  if (!notes) return null

  const sections = parseLocalizedReleaseNoteSections(notes)
  if (!sections) return notes

  const targetLanguage: ReleaseNotesLanguage = language?.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  return sections[targetLanguage] ?? sections.en ?? sections.zh ?? notes
}

function parseLocalizedReleaseNoteSections(notes: string): Partial<Record<ReleaseNotesLanguage, string>> | null {
  const sectionHeadingPattern = /^##\s*(English|中文|Chinese|简体中文)\s*$/gim
  const matches = Array.from(notes.matchAll(sectionHeadingPattern))
  if (matches.length === 0) return null

  const sections: Partial<Record<ReleaseNotesLanguage, string>> = {}

  matches.forEach((match, index) => {
    const label = match[1]?.toLowerCase()
    const language: ReleaseNotesLanguage = label === 'english' ? 'en' : 'zh'
    const start = match.index + match[0].length
    const end = matches[index + 1]?.index ?? notes.length
    const content = notes.slice(start, end).trim()
    if (content) sections[language] = content
  })

  return sections.en || sections.zh ? sections : null
}
