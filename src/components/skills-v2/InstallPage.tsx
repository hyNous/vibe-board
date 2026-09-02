import { useState } from 'react'
import { useSkillStoreV2 } from '../../stores/skillStoreV2'
import type { SkillInstallTab } from '../../stores/skillStoreV2'
import type { SkillSummary } from '../../services/skillApiV2'
import { AgentSyncPanel, LocalPanel, GitPanel } from './InstallView'
import { DistributeDialog } from './DistributeDialog'

const TABS: Array<{ id: SkillInstallTab; icon: string; label: string }> = [
  { id: 'agent', icon: '◌', label: 'Agent 同步' },
  { id: 'local', icon: '📁', label: '本地导入' },
  { id: 'git', icon: '⑂', label: 'Git 安装' },
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
        <h2 className="sm2__install-page-title">安装 Skills</h2>
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
