import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { reopenSetupWizard } from '../../../utils/setupWizard'
import { SettingSection } from '../SettingSection'
import { SettingGroup } from '../SettingGroup'
import { SettingRow } from '../SettingRow'
import { GlassButton } from '../../shared'

export function TutorialSection() {
  const { t } = useTranslation()
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleReopen = async () => {
    setOpening(true)
    setError(null)
    try {
      await reopenSetupWizard()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setOpening(false)
    }
  }

  return (
    <SettingSection
      title={t('settings.tutorial.title', { defaultValue: '重看教程与向导' })}
      description={t('settings.tutorial.desc', { defaultValue: '重新打开首次向导。教程内容将在后续里程碑加入。' })}
    >
      <SettingGroup>
        <SettingRow
          label={t('settings.tutorial.reopen', { defaultValue: '重新打开首次向导' })}
          description={t('settings.tutorial.reopenDesc', { defaultValue: '再次选择要接入的 Agent，并重新安装 Hook。' })}
        >
          <GlassButton variant="secondary" onClick={handleReopen} disabled={opening}>
            {opening ? t('settings.opening', { defaultValue: 'Opening…' }) : t('settings.tutorial.open', { defaultValue: '打开向导' })}
          </GlassButton>
        </SettingRow>
        {error && <div className="hook-error-card" role="alert">{error}</div>}
      </SettingGroup>
    </SettingSection>
  )
}
