import { useTranslation } from 'react-i18next'
import { Segmented } from '../settings/Segmented'
import { useSkillStoreV2 } from '../../stores/skillStoreV2'
import { SkillLibraryPage } from './SkillLibraryPage'
import { InstallPage } from './InstallPage'
import { AgentManagementPage } from './AgentManagementPage'
import { SettingsPageV2 } from './SettingsPageV2'
import './SkillManagerV2.css'
import './SkillSection.css'

type SkillPageSegment = 'library' | 'agents' | 'settings'

// 「完整管理」已并进这一页：页头带检查更新与添加入口，分段在库 / 按 Agent / 设置之间切换。
// 「添加 Skill」进入原来的安装页，安装页顶部有返回库的按钮。
export function SkillSection() {
  const { t } = useTranslation()
  const activeTab = useSkillStoreV2((s) => s.activeTab)
  const setTab = useSkillStoreV2((s) => s.setTab)
  const updateChecking = useSkillStoreV2((s) => s.updateChecking)
  const checkAllUpdates = useSkillStoreV2((s) => s.checkAllUpdates)
  // Older persisted state may still point at the removed project-scoped view.
  const tab = activeTab === 'projects' ? 'library' : activeTab
  const inInstall = tab === 'install'
  const segment: SkillPageSegment = tab === 'agents' ? 'agents' : tab === 'settings' ? 'settings' : 'library'

  return (
    <section className="vb-skill-section">
      <header className="vb-skill-section__head">
        <div>
          <h1>{t('settings.skillsSection.title', { defaultValue: 'Skill' })}</h1>
          <p>{t('settings.skillsSection.subtitle', { defaultValue: '把 Skill 收进中心库，再决定让哪些 Agent 用上。' })}</p>
        </div>
        <div className="vb-skill-section__acts">
          <button
            type="button"
            className="vb-btn"
            disabled={updateChecking}
            onClick={() => void checkAllUpdates()}
          >
            {updateChecking
              ? t('settings.skillsSection.checking', { defaultValue: '检查中…' })
              : t('settings.skillsSection.checkUpdates', { defaultValue: '检查更新' })}
          </button>
          <button type="button" className="vb-btn vb-btn--primary" onClick={() => setTab('install')}>
            {t('settings.skillsSection.addSkill', { defaultValue: '添加 Skill' })}
          </button>
        </div>
      </header>

      {inInstall ? (
        <div className="vb-skill-section__back">
          <button type="button" className="vb-btn" onClick={() => setTab('library')}>
            ← {t('settings.skillsSection.backToLibrary', { defaultValue: '返回 Skill 库' })}
          </button>
        </div>
      ) : (
        <div className="vb-skill-section__seg">
          <Segmented
            value={segment}
            ariaLabel={t('settings.skillsSection.tabsLabel', { defaultValue: 'Skill 页面' })}
            options={[
              { value: 'library', label: t('settings.skillsSection.tabLibrary', { defaultValue: 'Skill 库' }) },
              { value: 'agents', label: t('settings.skillsSection.tabAgents', { defaultValue: '按 Agent 看' }) },
              { value: 'settings', label: t('settings.skillsSection.tabSettings', { defaultValue: '设置' }) },
            ]}
            onChange={(value) => setTab(value)}
          />
        </div>
      )}

      <div className="vb-skill-section__body">
        {tab === 'install' ? (
          <InstallPage />
        ) : tab === 'agents' ? (
          <AgentManagementPage />
        ) : tab === 'settings' ? (
          <SettingsPageV2 />
        ) : (
          <SkillLibraryPage />
        )}
      </div>
    </section>
  )
}
