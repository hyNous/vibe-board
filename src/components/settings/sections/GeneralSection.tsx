import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { useConfigStore } from '../../../stores/configStore'
import { SettingSection } from '../SettingSection'
import { SettingGroup } from '../SettingGroup'
import { SettingRow } from '../SettingRow'
import { Toggle } from '../Toggle'
import { Dropdown } from '../Dropdown'
import { quitApp, setLanguage, setLaunchAtLogin } from '../../../services/tauriApi'
import { reopenSetupWizard } from '../../../utils/setupWizard'
import type { AppLanguage } from '../../../i18n/language'
import { GlassButton } from '../../shared'
import { SettingDetails } from '../SettingDetails'

export function GeneralSection() {
  const { t, i18n } = useTranslation()
  const { language, launchAtLogin, autoLaunchAgents, updateConfig } = useConfigStore(useShallow((state) => ({
    language: state.language,
    launchAtLogin: state.launchAtLogin,
    autoLaunchAgents: state.autoLaunchAgents,
    updateConfig: state.updateConfig,
  })))
  const [reconfiguring, setReconfiguring] = useState(false)
  const [setupError, setSetupError] = useState<string | null>(null)

  const handleReopenSetupWizard = async () => {
    setReconfiguring(true)
    setSetupError(null)
    try {
      await reopenSetupWizard()
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : String(error))
    } finally {
      setReconfiguring(false)
    }
  }

  const languageOptions = [
    { value: 'en', label: 'English' },
    { value: 'zh', label: '中文' },
  ]

  return (
    <SettingSection title={t('settings.general')} description={t('settings.generalDesc')}>
      <SettingGroup>
        <SettingRow label={t('settings.language')} description={t('settings.languageDesc')}>
          <Dropdown
            value={(() => {
              const lang = i18n.language
              if (lang.startsWith('zh')) return 'zh'
              return 'en'
            })()}
            options={languageOptions}
            onChange={(v) => {
              const previousLanguage = language
              const nextLanguage = v as AppLanguage
              i18n.changeLanguage(v)
              updateConfig('language', nextLanguage)
              setLanguage(nextLanguage).catch((error) => {
                console.error('[settings] setLanguage:', error)
                i18n.changeLanguage(previousLanguage)
                updateConfig('language', previousLanguage)
              })
            }}
            minWidth={120}
          />
        </SettingRow>
        <SettingRow label={t('settings.launchAtLogin')} description={t('settings.launchAtLoginDesc')}>
          <Toggle checked={launchAtLogin} onChange={(v) => {
            const previous = launchAtLogin
            updateConfig('launchAtLogin', v)
            setLaunchAtLogin(v).catch((error) => {
              console.error('[settings] setLaunchAtLogin:', error)
              updateConfig('launchAtLogin', previous)
            })
          }} />
        </SettingRow>
        <SettingRow
          label={t('settings.agentConnection', { defaultValue: '接入的 Agent' })}
          description={t('settings.agentConnectionDesc', { defaultValue: '选择哪些 Agent 会把任务状态同步到看板。' })}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <span style={{ color: 'var(--settings-text-secondary)', fontSize: 12 }}>
              {autoLaunchAgents.length > 0
                ? t('settings.autoLaunchAgents', {
                  defaultValue: '{{count}} 个 Agent 会在会话开始时自动打开看板',
                  count: autoLaunchAgents.length,
                })
                : t('settings.notConfigured', { defaultValue: '还没有接入任何 Agent' })}
            </span>
            <GlassButton variant="secondary" onClick={handleReopenSetupWizard} disabled={reconfiguring}>
              {reconfiguring ? t('settings.opening', { defaultValue: '正在打开…' }) : t('settings.configure', { defaultValue: '选择要接入的 Agent' })}
            </GlassButton>
          </div>
        </SettingRow>
        {setupError && (
          <div className="hook-error-card" role="alert">
            <div>{t('settings.wizardOpenFailed', { defaultValue: '向导没能打开，请稍后再试。' })}</div>
            <SettingDetails testId="general-setup-error">{setupError}</SettingDetails>
          </div>
        )}
        <SettingRow label={t('settings.quitApp')}>
          <GlassButton variant="danger" onClick={() => quitApp()}>
            {t('tray.quit')}
          </GlassButton>
        </SettingRow>
      </SettingGroup>
    </SettingSection>
  )
}
