import { useState } from 'react'
import { useSkillStoreV2 } from '../../stores/skillStoreV2'
import type { SkillInstallTab } from '../../stores/skillStoreV2'
import type { SkillSummary } from '../../services/skillApiV2'
import { AgentSyncPanel, LocalPanel, GitPanel } from './InstallView'
import { DistributeDialog } from './DistributeDialog'

const TABS: Array<{ id: SkillInstallTab; icon: string; label: string }> = [
  { id: 'agent', icon: '◌', label: '从 Agent 导入' },
  { id: 'local', icon: '📁', label: '从文件夹导入' },
  { id: 'git', icon: '⑂', label: '从 Git 安装' },
]

export function InstallPage() {
  const state = useSkillStoreV2()
  // Older persisted state may still contain the removed marketplace tab.
  const tab = state.activeInstallTab === 'official' ? 'git' : state.activeInstallTab
  const setTab = state.setInstallTab
  const [justInstalled, setJustInstalled] = useState<SkillSummary | null>(null)

  const handleDone = async (skillId?: string) => {
    await state.loadOverview(true)
    if (skillId) {
      const fresh = useSkillStoreV2.getState().skills
      const found = fresh.find((s) => s.id === skillId)
      if (found) {
        setJustInstalled(found)
        return
      }
    }
  }

  return (
    <div className="sm2 sm2__install-page">
      <div className="sm2__install-page-head">
        <div>
          <h2 className="sm2__install-page-title">添加 Skill</h2>
          <p className="sm2__header-subtitle">从 Agent 目录、文件夹或 Git 仓库把 Skill 收进 Skill 库，再决定让哪些 Agent 用上。</p>
        </div>
        <nav className="sm2__install-page-nav">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`sm2__install-page-tab${tab === t.id ? ' sm2__install-page-tab--active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              <span className="sm2__install-page-tab-icon">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      <div className="sm2__install-page-body settings-scroll">
        {tab === 'agent' && <AgentSyncPanel onDone={handleDone} />}
        {tab === 'local' && <LocalPanel onDone={handleDone} />}
        {tab === 'git' && <GitPanel onDone={handleDone} />}
      </div>

      {justInstalled && state.settings && (
        <DistributeDialog
          skill={justInstalled}
          agents={state.agents}
          defaultMode={state.settings.defaultDistributeMode}
          onClose={() => setJustInstalled(null)}
          onDone={() => {
            setJustInstalled(null)
            state.loadOverview(true)
          }}
        />
      )}
    </div>
  )
}
