import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { openTutorialWindow } from '../../../services/tauriApi'
import { reopenSetupWizard } from '../../../utils/setupWizard'
import { SettingSection } from '../SettingSection'
import { SettingGroup } from '../SettingGroup'
import { SettingRow } from '../SettingRow'
import { SettingDetails } from '../SettingDetails'
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
      description={t('settings.tutorial.desc', { defaultValue: '第一次用，或者想再看一遍怎么用，从这里打开教程或重新走一遍向导。' })}
    >
      <SettingGroup>
        <SettingRow
          label={t('settings.tutorial.openTutorial', { defaultValue: '看完整教程' })}
          description={t('settings.tutorial.openTutorialDesc', { defaultValue: '从灵动岛怎么用到任务看板、额度、Skill 和派活，一节一节讲清楚。' })}
        >
          <GlassButton
            variant="secondary"
            onClick={() => void run('tutorial', openTutorialWindow)}
            disabled={opening !== null}
          >
            {opening === 'tutorial'
              ? t('settings.opening', { defaultValue: '正在打开…' })
              : t('settings.tutorial.openTutorialAction', { defaultValue: '打开教程' })}
          </GlassButton>
        </SettingRow>
        <SettingRow
          label={t('settings.tutorial.reopen', { defaultValue: '重新选择要接入的 Agent' })}
          description={t('settings.tutorial.reopenDesc', { defaultValue: '再走一遍首次向导：重新选 Agent，并让它们把任务状态同步到看板。' })}
        >
          <GlassButton
            variant="secondary"
            onClick={() => void run('wizard', reopenSetupWizard)}
            disabled={opening !== null}
          >
            {opening === 'wizard'
              ? t('settings.opening', { defaultValue: '正在打开…' })
              : t('settings.tutorial.open', { defaultValue: '打开向导' })}
          </GlassButton>
        </SettingRow>
        {error && (
          <div className="hook-error-card" role="alert">
            <div>{t('settings.tutorial.openFailed', { defaultValue: '没能打开，请稍后再试。' })}</div>
            <SettingDetails testId="tutorial-error-details">{error}</SettingDetails>
          </div>
        )}
      </SettingGroup>
    </SettingSection>
  )
}
