import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { openTutorialWindow } from '../../../services/tauriApi'
import { reopenSetupWizard } from '../../../utils/setupWizard'
import { SettingSection } from '../SettingSection'
import { SettingGroup } from '../SettingGroup'
import { SettingRow } from '../SettingRow'
import { GlassButton } from '../../shared'

type TutorialAction = 'tutorial' | 'wizard'

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function TutorialSection() {
  const { t } = useTranslation()
  const [opening, setOpening] = useState<TutorialAction | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (action: TutorialAction, task: () => Promise<void>) => {
    setOpening(action)
    setError(null)
    try {
      await task()
    } catch (reason) {
      setError(readableError(reason))
    } finally {
      setOpening(null)
    }
  }

  return (
    <SettingSection
      title={t('settings.tutorial.title', { defaultValue: '重看教程与向导' })}
      description={t('settings.tutorial.desc', { defaultValue: '在应用内窗口打开随包分发的离线教程，或重新运行首次向导。' })}
    >
      <SettingGroup>
        <SettingRow
          label={t('settings.tutorial.openTutorial', { defaultValue: '打开完整教程' })}
          description={t('settings.tutorial.openTutorialDesc', { defaultValue: '岛怎么用、看板在显示什么、点任务会发生什么、Agent 接入，以及 Skill 管理与使用额度。' })}
        >
          <GlassButton
            variant="secondary"
            onClick={() => void run('tutorial', openTutorialWindow)}
            disabled={opening !== null}
          >
            {opening === 'tutorial'
              ? t('settings.opening', { defaultValue: 'Opening…' })
              : t('settings.tutorial.openTutorialAction', { defaultValue: '打开教程' })}
          </GlassButton>
        </SettingRow>
        <SettingRow
          label={t('settings.tutorial.reopen', { defaultValue: '重新打开首次向导' })}
          description={t('settings.tutorial.reopenDesc', { defaultValue: '再次选择要接入的 Agent，并重新安装 Hook。' })}
        >
          <GlassButton
            variant="secondary"
            onClick={() => void run('wizard', reopenSetupWizard)}
            disabled={opening !== null}
          >
            {opening === 'wizard'
              ? t('settings.opening', { defaultValue: 'Opening…' })
              : t('settings.tutorial.open', { defaultValue: '打开向导' })}
          </GlassButton>
        </SettingRow>
        {error && <div className="hook-error-card" role="alert">{error}</div>}
      </SettingGroup>
    </SettingSection>
  )
}
