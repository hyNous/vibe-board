import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { useConfigStore } from '../../../stores/configStore'
import { Segmented } from '../Segmented'
import { Toggle } from '../Toggle'
import { Dropdown } from '../Dropdown'
import { quitApp, setLanguage, setLaunchAtLogin, getConfig, updateConfig as updateBackendConfig } from '../../../services/tauriApi'
import { reopenSetupWizard } from '../../../utils/setupWizard'
import type { AppLanguage } from '../../../i18n/language'
import { GlassButton } from '../../shared'
import { SettingDetails } from '../SettingDetails'
import './GeneralSection.css'

function persistWindowCloseBehavior(value: 'tray' | 'exit') {
  getConfig()
    .then((backendConfig) => updateBackendConfig({ ...backendConfig, windowCloseBehavior: value }))
    .catch((err) => console.error('Failed to persist window close behavior:', err))
}

export function GeneralSection() {
  const { t, i18n } = useTranslation()
  const { language, launchAtLogin, autoLaunchAgents, windowCloseBehavior, updateConfig } = useConfigStore(useShallow((state) => ({
    language: state.language,
    launchAtLogin: state.launchAtLogin,
    autoLaunchAgents: state.autoLaunchAgents,
    windowCloseBehavior: state.windowCloseBehavior,
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

  const currentLanguage: AppLanguage = i18n.language.startsWith('zh') ? 'zh' : 'en'

  const changeLanguage = (next: AppLanguage) => {
    const previousLanguage = language
    i18n.changeLanguage(next)
    updateConfig('language', next)
    setLanguage(next).catch((error) => {
      console.error('[settings] setLanguage:', error)
      i18n.changeLanguage(previousLanguage)
      updateConfig('language', previousLanguage)
    })
  }

  return (
    <section className="general-settings">
      <header className="general-settings__head">
        <div>
          <h1>{t('settings.general')}</h1>
          <p>{t('settings.generalDesc')}</p>
        </div>
      </header>

      <div className="general-settings__panel">
        <div className="general-settings__row">
          <div className="general-settings__row-info">
            <div className="general-settings__row-label">{t('settings.language')}</div>
            <div className="general-settings__row-description">{t('settings.languageDesc')}</div>
          </div>
          <div className="general-settings__row-control">
            <Segmented
              value={currentLanguage}
              ariaLabel={t('settings.language')}
              options={[
                { value: 'zh', label: '中文' },
                { value: 'en', label: 'English' },
              ]}
              onChange={changeLanguage}
            />
          </div>
        </div>
        <div className="general-settings__row">
          <div className="general-settings__row-info">
            <div className="general-settings__row-label">{t('settings.launchAtLogin')}</div>
            <div className="general-settings__row-description">{t('settings.launchAtLoginDesc')}</div>
          </div>
          <div className="general-settings__row-control">
            <Toggle checked={launchAtLogin} onChange={(v) => {
              const previous = launchAtLogin
              updateConfig('launchAtLogin', v)
              setLaunchAtLogin(v).catch((error) => {
                console.error('[settings] setLaunchAtLogin:', error)
                updateConfig('launchAtLogin', previous)
              })
            }} />
          </div>
        </div>
        <div className="general-settings__row">
          <div className="general-settings__row-info">
            <div className="general-settings__row-label">{t('settings.windowCloseBehavior', { defaultValue: '关闭窗口时' })}</div>
            <div className="general-settings__row-description">{t('settings.windowCloseBehaviorDesc', { defaultValue: '点击桌面窗口右上角的叉时，选择隐藏到系统托盘或退出 Vibe Board。' })}</div>
          </div>
          <div className="general-settings__row-control">
            <Dropdown
              value={windowCloseBehavior}
              options={[
                { value: 'tray', label: t('settings.windowCloseToTray', { defaultValue: '最小化到托盘' }) },
                { value: 'exit', label: t('settings.windowCloseExit', { defaultValue: '直接退出程序' }) },
              ]}
              onChange={(value) => {
                const behavior = value === 'exit' ? 'exit' : 'tray'
                updateConfig('windowCloseBehavior', behavior)
                persistWindowCloseBehavior(behavior)
              }}
              minWidth={180}
            />
          </div>
        </div>
      </div>

      <div className="general-settings__group-title">
        {t('settings.agentConnection', { defaultValue: '接入的 Agent' })}
      </div>
      <div className="general-settings__panel">
        <div className="general-settings__row">
          <div className="general-settings__row-info">
            <div className="general-settings__row-label">
              {autoLaunchAgents.length > 0
                ? t('settings.agentConnectedCount', {
                  defaultValue: '{{count}} 个 Agent 已接入',
                  count: autoLaunchAgents.length,
                }).replace('{{count}}', String(autoLaunchAgents.length))
                : t('settings.notConfigured', { defaultValue: '还没有接入任何 Agent' })}
            </div>
            <div className="general-settings__row-description">
              {t('settings.agentConnectedDesc', { defaultValue: '它们开新会话时会通知灵动岛' })}
            </div>
          </div>
          <div className="general-settings__row-control">
            <button
              type="button"
              className="vb-btn"
              onClick={() => void handleReopenSetupWizard()}
              disabled={reconfiguring}
            >
              {reconfiguring
                ? t('settings.opening', { defaultValue: '正在打开…' })
                : t('settings.configure', { defaultValue: '选择要接入的 Agent' })}
            </button>
          </div>
        </div>
        {setupError && (
          <div className="general-settings__error" role="alert">
            <div>{t('settings.wizardOpenFailed', { defaultValue: '向导没能打开，请稍后再试。' })}</div>
            <SettingDetails testId="general-setup-error">{setupError}</SettingDetails>
          </div>
        )}
      </div>

      <div className="general-settings__quit">
        <GlassButton variant="danger" onClick={() => quitApp()}>
          {t('settings.quitApp', { defaultValue: '退出 Vibe Board' })}
        </GlassButton>
        <span>{t('settings.quitHint', { defaultValue: '灵动岛和托盘图标都会关掉' })}</span>
      </div>
    </section>
  )
}
