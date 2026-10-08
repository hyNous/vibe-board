import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSkillStoreV2 } from '../../stores/skillStoreV2'
import { skillApiV2 } from '../../services/skillApiV2'
import { SettingDetails } from '../settings/SettingDetails'

export function SettingsPageV2() {
  const { t } = useTranslation()
  const state = useSkillStoreV2()
  const settings = state.settings
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [noticeDetails, setNoticeDetails] = useState<string | null>(null)

  useEffect(() => {
    if (!settings) state.loadOverview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!settings) {
    return <div className="sm2__empty">正在加载设置…</div>
  }

  const update = async (patch: Parameters<typeof state.updateSettings>[0]) => {
    setBusy(true)
    setNotice(null)
    setNoticeDetails(null)
    try {
      await state.updateSettings(patch)
    } finally {
      setBusy(false)
    }
  }

  const exportSnapshot = async () => {
    setBusy(true)
    setNotice(null)
    setNoticeDetails(null)
    try {
      const path = await skillApiV2.exportSnapshot()
      setNotice('记录已刷新。')
      if (path) setNoticeDetails(path)
    } catch (e) {
      state.setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const revealSqlite = async () => {
    setBusy(true)
    setNotice(null)
    setNoticeDetails(null)
    try {
      await skillApiV2.revealPath(settings.sqlitePath)
      setNotice('已在文件管理器里定位到这个文件。')
    } catch (e) {
      state.setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sm2">
      <div className="sm2__header sm2__header--stacked">
        <div>
          <h2 className="sm2__title">Skill 设置</h2>
          <p className="sm2__header-subtitle">这些设置决定新加的 Skill 默认怎么让 Agent 用上，以及打开这一页时要不要自动检查。</p>
        </div>
      </div>
      <div className="sm2__main">
        {state.error && <div className="sm2__error">{state.error}</div>}
        {notice && <div className="sm2__notice sm2__notice--ok">{notice}</div>}
        {noticeDetails && (
          <SettingDetails testId="skill-settings-notice-details" label="详情">
            <code>{noticeDetails}</code>
          </SettingDetails>
        )}

        <div className="sm2__issue">
          <h4 className="sm2__settings-label">新 Skill 默认怎么让 Agent 用上</h4>
          <select
            className="sm2__select"
            value={settings.defaultDistributeMode}
            onChange={(e) => update({ defaultDistributeMode: e.target.value as 'link' | 'copy' })}
          >
            <option value="link">共享同一份（改一处，所有 Agent 都跟着变）</option>
            <option value="copy">各存一份（每个 Agent 一份独立副本）</option>
          </select>
        </div>

        <div className="sm2__issue">
          <h4 className="sm2__settings-label">共享不成功时</h4>
          <select
            className="sm2__select"
            value={settings.linkFailPolicy}
            onChange={(e) => update({ linkFailPolicy: e.target.value as 'ask' | 'copy' })}
          >
            <option value="ask">停下来问我</option>
            <option value="copy">自动改用「各存一份」</option>
          </select>
        </div>

        <div className="sm2__issue">
          <h4 className="sm2__settings-label">启动与显示</h4>
          <label className="sm2__checkbox-row">
            <input
              type="checkbox"
              checked={settings.startupScan}
              onChange={(e) => update({ startupScan: e.target.checked })}
            />
            打开 Vibe Board 时自动检查 Skill 库和各 Agent
          </label>
          <label className="sm2__checkbox-row">
            <input
              type="checkbox"
              checked={settings.showUnmanaged}
              onChange={(e) => update({ showUnmanaged: e.target.checked })}
            />
            显示还没纳入管理的 Skill
          </label>
        </div>

        <div className="sm2__issue">
          <h4 className="sm2__settings-label">
            {t('skills.settings.openSourceUpdates', { defaultValue: '开源 Skill 更新' })}
          </h4>
          <label className="sm2__checkbox-row">
            <input
              type="checkbox"
              checked={settings.periodicSkillUpdateCheck ?? false}
              onChange={(e) => update({ periodicSkillUpdateCheck: e.target.checked })}
            />
            {t('skills.settings.periodicCheck', { defaultValue: '定期检查更新' })}
          </label>
          <p className="sm2__settings-help">
            {t('skills.settings.periodicCheckHelp', {
              defaultValue: '打开后，Vibe Board 每天最多检查一次你安装的开源 Skill 是否有新版本：检查会访问 GitHub。发现新版本时只提示，不会自动改文件；只有单独打开「自动更新」的 Skill 才会直接更新。默认关闭。',
            })}
          </p>
          <p className="sm2__settings-help">
            {t('skills.settings.lastChecked', {
              time: settings.lastSkillUpdateCheckAt
                ? new Date(settings.lastSkillUpdateCheckAt).toLocaleString()
                : t('skills.updates.neverChecked', { defaultValue: '还没有检查过' }),
              defaultValue: '上次检查：{{time}}',
            })}
          </p>
        </div>

        <div className="sm2__issue">
          <h4 className="sm2__settings-label">排查用的数据文件</h4>
          <p className="sm2__settings-help">
            Skill 的记录保存在本机。只有排查问题时才需要动这里的文件。
          </p>
          <SettingDetails testId="skill-settings-storage-details" label="详情（排查用）">
            <div className="setting-details__row">
              <span>记录文件</span>
              <code>{settings.sqlitePath}</code>
            </div>
            <div className="setting-details__row">
              <span>备份快照</span>
              <code>{settings.centerPath}/vibeboard-skills.snapshot.json</code>
            </div>
            <div className="sm2__btn-row">
              <button className="sm2__btn" onClick={exportSnapshot} disabled={busy}>刷新备份快照</button>
              <button className="sm2__btn" onClick={revealSqlite} disabled={busy}>在文件管理器里显示记录文件</button>
            </div>
          </SettingDetails>
        </div>
      </div>
    </div>
  )
}
