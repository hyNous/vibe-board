import { useSkillStoreV2 } from '../../stores/skillStoreV2'
import { SkillLibraryPage } from './SkillLibraryPage'
import { InstallPage } from './InstallPage'
import { AgentManagementPage } from './AgentManagementPage'
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
      {visibleTab === 'agents' && <AgentManagementPage />}
      {visibleTab === 'settings' && <SettingsPageV2 />}
    </div>
  )
}
