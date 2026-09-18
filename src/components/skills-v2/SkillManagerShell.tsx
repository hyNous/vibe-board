import { useSkillStoreV2 } from '../../stores/skillStoreV2'
import { SkillLibraryPage } from './SkillLibraryPage'
import { InstallPage } from './InstallPage'
import { SkillPackPage } from './SkillPackPage'
import { AgentManagementPage } from './AgentManagementPage'
import { DiagnosisPage } from './DiagnosisPage'
import { SettingsPageV2 } from './SettingsPageV2'
import './SkillManagerV2.css'

export function SkillManagerShell() {
  const activeTab = useSkillStoreV2((s) => s.activeTab)
  // Older persisted state may still point at the removed project-scoped view.
  const visibleTab = activeTab === 'projects' ? 'library' : activeTab

  return (
    <div className="sm2-shell__page">
      {visibleTab === 'library' && <SkillLibraryPage />}
      {visibleTab === 'install' && <InstallPage />}
      {visibleTab === 'packs' && <SkillPackPage />}
      {visibleTab === 'agents' && <AgentManagementPage />}
      {visibleTab === 'diagnostics' && <DiagnosisPage />}
      {visibleTab === 'settings' && <SettingsPageV2 />}
    </div>
  )
}
