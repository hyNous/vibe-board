import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { openTutorialWindow } from '../../../services/tauriApi'
import { reopenSetupWizard } from '../../../utils/setupWizard'
import { SettingDetails } from '../SettingDetails'
import './TutorialSection.css'

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
    <section className="tutorial-page">
      <header className="tutorial-page__head">
        <div>
          <h1>{t('settings.tutorial.title', { defaultValue: '重看教程与向导' })}</h1>
        </div>
      </header>

      <div className="tutorial-page__tiles">
        <div className="tutorial-tile">
          <b>{t('settings.tutorial.openTutorial', { defaultValue: '看完整教程' })}</b>
          <span>{t('settings.tutorial.openTutorialDesc', { defaultValue: '从灵动岛怎么用到任务看板、额度、Skill 和派活，一节一节讲清楚。' })}</span>
          <button
            type="button"
            className="tutorial-tile__go"
            onClick={() => void run('tutorial', openTutorialWindow)}
            disabled={opening !== null}
          >
            {opening === 'tutorial'
              ? t('settings.opening', { defaultValue: '正在打开…' })
              : t('settings.tutorial.openTutorialAction', { defaultValue: '打开教程' })}
          </button>
        </div>
        <div className="tutorial-tile">
          <b>{t('settings.tutorial.reopen', { defaultValue: '重新选择要接入的 Agent' })}</b>
          <span>{t('settings.tutorial.reopenDesc', { defaultValue: '再走一遍首次向导：重新选 Agent，并让它们把任务状态同步到看板。' })}</span>
          <button
            type="button"
            className="tutorial-tile__go"
            onClick={() => void run('wizard', reopenSetupWizard)}
            disabled={opening !== null}
          >
            {opening === 'wizard'
              ? t('settings.opening', { defaultValue: '正在打开…' })
              : t('settings.tutorial.open', { defaultValue: '打开向导' })}
          </button>
        </div>
      </div>

      {error && (
        <div className="tutorial-page__error" role="alert">
          <div>{t('settings.tutorial.openFailed', { defaultValue: '没能打开，请稍后再试。' })}</div>
          <SettingDetails testId="tutorial-error-details">{error}</SettingDetails>
        </div>
      )}
    </section>
  )
}
