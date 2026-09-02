import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useSkillStoreV2 } from '../../stores/skillStoreV2'
import { SkillLibraryPage } from './SkillLibraryPage'
import { InstallPage } from './InstallPage'
import { SkillPackPage } from './SkillPackPage'
import { AgentManagementPage } from './AgentManagementPage'
import { DiagnosisPage } from './DiagnosisPage'
import { SettingsPageV2 } from './SettingsPageV2'
import { useSelectedRuntimeEnvironment } from '../../hooks/useRuntimeEnvironment'
import './SkillManagerV2.css'

export function SkillManagerShell() {
  const { t } = useTranslation()
  const activeTab = useSkillStoreV2((s) => s.activeTab)
  const runtimeEnvironmentId = useSkillStoreV2((s) => s.runtimeEnvironmentId)
  const switchRuntimeEnvironment = useSkillStoreV2((s) => s.switchRuntimeEnvironment)
  const { selectedEnvironmentId } = useSelectedRuntimeEnvironment()
  // Older persisted state may still point at the removed project-scoped view.
  const visibleTab = activeTab === 'projects' ? 'library' : activeTab

  useEffect(() => {
    void switchRuntimeEnvironment(selectedEnvironmentId)
  }, [selectedEnvironmentId, switchRuntimeEnvironment])

  return (
    <div className="sm2-shell__page">
      {runtimeEnvironmentId !== selectedEnvironmentId ? (
        <div className="sm2">
          <div className="sm2__empty">{t('skills.runtimeEnvironment.loading')}</div>
        </div>
      ) : (
        <>
          {visibleTab === 'library' && <SkillLibraryPage />}
          {visibleTab === 'install' && <InstallPage />}
          {visibleTab === 'packs' && <SkillPackPage />}
          {visibleTab === 'agents' && <AgentManagementPage />}
          {visibleTab === 'diagnostics' && <DiagnosisPage />}
          {visibleTab === 'settings' && <SettingsPageV2 />}
        </>
      )}
    </div>
  )
}
