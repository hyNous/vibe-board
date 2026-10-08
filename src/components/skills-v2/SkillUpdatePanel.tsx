import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useSkillStoreV2 } from '../../stores/skillStoreV2'
import type { SkillUpdateCheckEntry } from '../../services/skillApiV2'
import { SettingDetails } from '../settings/SettingDetails'
import { PreviewDialog } from './PreviewDialog'
import { changeSummaryText, skillUpdateErrorText } from './skillUpdateText'

function skippedText(t: TFunction, reason: string): string {
  if (reason === 'locally_modified') {
    return t('skills.updates.skippedModified', {
      defaultValue: '已跳过：这个 Skill 和安装时记录的版本对不上，可能被改过，自动更新不会覆盖它。',
    })
  }
  if (reason === 'unknown_baseline') {
    return t('skills.updates.skippedUnknown', {
      defaultValue: '已跳过：无法确认这个 Skill 有没有被改过，请手动更新。',
    })
  }
  return t('skills.updates.skippedFailed', {
    defaultValue: '已跳过：更新没有成功。',
  })
}

export function SkillUpdatePanel() {
  const { t } = useTranslation()
  const state = useSkillStoreV2()
  const status = state.updateStatus
  const report = status?.report ?? null
  const entries = useMemo(() => report?.entries ?? [], [report])
  const updatable = useMemo(() => entries.filter((entry) => entry.updateAvailable), [entries])
  const autoUpdated = useMemo(() => entries.filter((entry) => entry.autoUpdated), [entries])
  const autoSkipped = useMemo(
    () => entries.filter((entry) => !entry.autoUpdated && entry.autoUpdateSkipped),
    [entries],
  )
  const failed = useMemo(() => entries.filter((entry) => entry.errorKind), [entries])
  const [confirmEntry, setConfirmEntry] = useState<SkillUpdateCheckEntry | null>(null)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const checking = state.updateChecking
  const busy = state.updateBusySkillId !== null
  const checkedAt = status?.lastCheckedAt ?? report?.checkedAt ?? null

  useEffect(() => {
    if (!state.updateStatus) void state.loadUpdateStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const confirmUpdate = async () => {
    if (!confirmEntry) return
    setConfirmError(null)
    try {
      const result = await state.updateSkill(confirmEntry.skillId, true)
      if (result.errorKind) {
        setConfirmError(skillUpdateErrorText(t, result.errorKind))
        return
      }
      setConfirmEntry(null)
    } catch (error) {
      setConfirmError(String(error))
    }
  }

  return (
    <section className="vb-skills-updates" aria-live="polite">
      <div className="vb-skills-updates__head">
        <h3>{t('skills.updates.title', { defaultValue: '开源 Skill 更新' })}</h3>
        <span className="vb-skills-updates__status">
          {t('skills.updates.lastChecked', {
            time: checkedAt ? new Date(checkedAt).toLocaleString() : t('skills.updates.neverChecked', { defaultValue: '还没有检查过' }),
            defaultValue: '上次检查：{{time}}',
          })}
        </span>
        <button
          type="button"
          className="vb-skills-btn vb-skills-btn--primary"
          disabled={checking || busy}
          onClick={() => void state.checkAllUpdates()}
        >
          {checking
            ? t('skills.updates.checking', { defaultValue: '正在检查…' })
            : t('skills.updates.checkAll', { defaultValue: '检查全部更新' })}
        </button>
      </div>

      {report && (
        <p className="vb-skills-updates__summary">
          {report.updateCount > 0
            ? t('skills.updates.summary', {
                n: report.updateCount,
                defaultValue: '{{n}} 个可更新',
              })
            : t('skills.updates.allCurrent', { defaultValue: '全部已是最新' })}
          {report.checkedCount === 0 && (
            <span>
              {' '}
              {t('skills.updates.noSources', {
                defaultValue: '没有来源记录的 Skill 不参与检查。',
              })}
            </span>
          )}
        </p>
      )}

      {updatable.map((entry) => (
        <div key={entry.skillId} className="vb-skills-updates__row">
          <span className="vb-skills-updates__name">{entry.name}</span>
          {entry.locallyModified && (
            <span className="vb-skills-updates__warning" role="status">
              {t('skills.updates.modifiedNote', { defaultValue: '这个 Skill 和安装时记录的版本对不上，可能被改过，更新会覆盖本地内容。' })}
            </span>
          )}
          {entry.changes && (
            <SettingDetails
              testId={`skill-update-changes-${entry.skillId}`}
              label={changeSummaryText(t, entry.changes)}
            >
              <ul className="vb-skills-updates__files">
                {entry.changes.files.map((file) => (
                  <li key={`${file.changeType}-${file.path}`}>
                    <span>{t(`skills.updates.change.${file.changeType}`, { defaultValue: file.changeType })}</span>
                    <code>{file.path}</code>
                  </li>
                ))}
                {entry.changes.truncated && (
                  <li>{t('skills.updates.changesTruncated', { defaultValue: '只列出了前面一部分文件。' })}</li>
                )}
              </ul>
            </SettingDetails>
          )}
          <label className="vb-skills-updates__toggle" title={t('skills.updates.autoUpdateHint', { defaultValue: '只有打开「定期检查更新」后才生效' })}>
            <input
              type="checkbox"
              checked={entry.autoUpdateEnabled}
              disabled={busy}
              onChange={(event) => void state.setSkillAutoUpdate(entry.skillId, event.target.checked)}
            />
            {t('skills.updates.autoUpdate', { defaultValue: '自动更新' })}
          </label>
          <button
            type="button"
            className="vb-skills-btn"
            disabled={busy}
            onClick={() => {
              setConfirmError(null)
              setConfirmEntry(entry)
            }}
          >
            {t('skills.updates.update', { defaultValue: '更新' })}
          </button>
        </div>
      ))}

      {autoUpdated.map((entry) => (
        <div key={`auto-${entry.skillId}`} className="vb-skills-updates__row vb-skills-updates__row--quiet">
          <span className="vb-skills-updates__name">{entry.name}</span>
          <span className="vb-skills-updates__status">
            {t('skills.updates.autoUpdated', { defaultValue: '已自动更新到新版本' })}
          </span>
        </div>
      ))}

      {autoSkipped.map((entry) => (
        <div key={`skip-${entry.skillId}`} className="vb-skills-updates__row vb-skills-updates__row--quiet">
          <span className="vb-skills-updates__name">{entry.name}</span>
          <span className="vb-skills-updates__warning" role="status">
            {skippedText(t, entry.autoUpdateSkipped ?? 'apply_failed')}
          </span>
        </div>
      ))}

      {failed.map((entry) => (
        <div key={`fail-${entry.skillId}`} className="vb-skills-updates__row">
          <span className="vb-skills-updates__name">{entry.name}</span>
          <span className="vb-skills-updates__status vb-skills-updates__status--error" role="alert">
            {skillUpdateErrorText(t, entry.errorKind)}
          </span>
          {entry.errorDetail && (
            <SettingDetails testId={`skill-update-error-${entry.skillId}`} label={t('settings.details', { defaultValue: '详情' })}>
              <p>{entry.errorDetail}</p>
              {entry.sourceUri && <code>{entry.sourceUri}</code>}
            </SettingDetails>
          )}
        </div>
      ))}

      {confirmEntry && (
        <PreviewDialog
          title={t('skills.updates.confirmTitle', {
            name: confirmEntry.name,
            defaultValue: '更新「{{name}}」？',
          })}
          confirmLabel={t('skills.updates.confirmUpdate', { defaultValue: '更新' })}
          cancelLabel={t('skills.cancel', { defaultValue: '取消' })}
          busyLabel={t('skills.updates.updating', { defaultValue: '正在更新…' })}
          destructive={confirmEntry.locallyModified}
          busy={state.updateBusySkillId === confirmEntry.skillId}
          onConfirm={() => void confirmUpdate()}
          onCancel={() => {
            if (state.updateBusySkillId !== null) return
            setConfirmEntry(null)
            setConfirmError(null)
          }}
        >
          <div className="vb-skills-sync-preview">
            <p>{t('skills.updates.confirmBody', { defaultValue: '会用 GitHub 上的新版本替换本地文件；各 Agent 的链接不变。' })}</p>
            {confirmEntry.locallyModified && (
              <p className="vb-skills-sync-preview__warning" role="alert">
                {t('skills.updates.modifiedNote', { defaultValue: '这个 Skill 和安装时记录的版本对不上，可能被改过，更新会覆盖本地内容。' })}
              </p>
            )}
            {confirmEntry.changes && (
              <p>{changeSummaryText(t, confirmEntry.changes)}</p>
            )}
            {confirmError && (
              <p className="vb-skills-sync-preview__error" role="alert">{confirmError}</p>
            )}
          </div>
        </PreviewDialog>
      )}
    </section>
  )
}
