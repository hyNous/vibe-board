import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { useConfigStore } from '../../../stores/configStore'
import { SettingSection } from '../SettingSection'
import { SettingGroup } from '../SettingGroup'
import { SettingRow } from '../SettingRow'
import { Toggle } from '../Toggle'
import { Dropdown } from '../Dropdown'
import { getConfig, quitApp, setLanguage, setLaunchAtLogin, updateConfig as updateBackendConfig } from '../../../services/tauriApi'
import { GlassButton } from '../../shared'

export function GeneralSection() {
  const { t, i18n } = useTranslation()
  const { language, launchAtLogin, hostAgent, childAgents, updateConfig } = useConfigStore(useShallow((state) => ({
    language: state.language,
    launchAtLogin: state.launchAtLogin,
    hostAgent: state.hostAgent,
    childAgents: state.childAgents,
    updateConfig: state.updateConfig,
  })))
  const [reconfiguring, setReconfiguring] = useState(false)
  const [setupError, setSetupError] = useState<string | null>(null)

  const reopenSetupWizard = async () => {
    setReconfiguring(true)
    setSetupError(null)
    try {
      const backend = await getConfig()
      await updateBackendConfig({ ...backend, setupWizardCompleted: false })
      updateConfig('setupWizardCompleted', false)
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : String(error))
    } finally {
      setReconfiguring(false)
    }
  }

  const languageOptions = [
    { value: 'en', label: 'English' },
    { value: 'zh', label: '中文' },
    { value: 'ja', label: '日本語' },
    { value: 'ko', label: '한국어' },
    { value: 'tr', label: 'Türkçe' },
  ]

  return (
    <SettingSection title={t('settings.general')} description={t('settings.generalDesc')}>
      <SettingGroup>
        <SettingRow label={t('settings.language')} description={t('settings.languageDesc')}>
          <Dropdown
            value={(() => {
              const lang = i18n.language
              if (lang.startsWith('zh')) return 'zh'
              if (lang.startsWith('ja')) return 'ja'
              if (lang.startsWith('ko')) return 'ko'
              if (lang.startsWith('tr')) return 'tr'
              return 'en'
            })()}
            options={languageOptions}
            onChange={(v) => {
              const previousLanguage = language
              const nextLanguage = v as 'en' | 'zh' | 'ja' | 'ko' | 'tr'
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
          label={t('settings.agentConnection', { defaultValue: 'Agent connection' })}
          description={t('settings.agentConnectionDesc', { defaultValue: 'Choose which local Agent wakes Vibe Board and which child Agents are monitored.' })}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <span style={{ color: 'var(--settings-text-secondary)', fontSize: 12 }}>
              {hostAgent ?? t('settings.notConfigured', { defaultValue: 'Not configured' })}
              {childAgents.length > 0 && ` · ${childAgents.length} ${t('settings.childAgents', { defaultValue: 'child' })}`}
            </span>
            <GlassButton variant="secondary" onClick={reopenSetupWizard} disabled={reconfiguring}>
              {reconfiguring ? t('settings.opening', { defaultValue: 'Opening…' }) : t('settings.configure', { defaultValue: 'Configure' })}
            </GlassButton>
          </div>
        </SettingRow>
        {setupError && <div className="hook-error-card" role="alert">{setupError}</div>}
        <SettingRow label={t('settings.quitApp')}>
          <GlassButton variant="danger" onClick={() => quitApp()}>
            {t('tray.quit')}
          </GlassButton>
        </SettingRow>
      </SettingGroup>
    </SettingSection>
  )
}
