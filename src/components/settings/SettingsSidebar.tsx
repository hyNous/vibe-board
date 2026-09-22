import { useTranslation } from 'react-i18next'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { splitAgentsByProgram, useSkillStoreV2 } from '../../stores/skillStoreV2'
import { useSessionStore } from '../../stores/sessionStore'
import type { SkillManagerTab } from '../../stores/skillStoreV2'
import { AgentIconBadge } from '../skills-v2/AgentIconBadge'
import { getCurrentAppVersion } from '../../services/tauriApi'
import { buildAgentUsageScores, readStoredAgentOrder, sortAgentSummaries, writeStoredAgentOrder } from '../../utils/agentOrdering'

interface SidebarItem {
  id: string
  labelKey: string
  labelDefault: string
  icon: string
  hidden?: boolean
}

interface SidebarGroup {
  labelKey?: string
  labelDefault?: string
  items: SidebarItem[]
}

const SHARED_SKILLS_AGENT_ID = 'agents'

interface AgentDropTarget {
  agentId: string
  edge: 'before' | 'after'
}

// 左侧导航固定六项功能名（任务看板 / 使用额度 / Skill管理 / Agent管理 / 外观设置 / 通用设置），
// 文案走 i18n；窄窗口只收窄侧栏宽度，不隐藏标签文字。
const sidebarGroups: SidebarGroup[] = [
  {
    labelKey: 'settings.nav.groups.run',
    labelDefault: '运行',
    items: [
      { id: 'tasks', labelKey: 'settings.nav.tasks', labelDefault: '任务看板', icon: '✓' },
      { id: 'usage', labelKey: 'settings.nav.usage', labelDefault: '使用额度', icon: '▥' },
    ],
  },
  {
    labelKey: 'settings.nav.groups.manage',
    labelDefault: '管理',
    items: [
      { id: 'skills', labelKey: 'settings.nav.skills', labelDefault: 'Skill管理', icon: '🧩' },
      { id: 'agents', labelKey: 'settings.nav.agents', labelDefault: 'Agent管理', icon: '🤖' },
    ],
  },
  {
    labelKey: 'settings.nav.groups.appearance',
    labelDefault: '外观',
    items: [
      { id: 'island', labelKey: 'settings.nav.island', labelDefault: '外观设置', icon: '🏝' },
    ],
  },
  {
    labelKey: 'settings.nav.groups.system',
    labelDefault: '系统',
    items: [
      { id: 'general', labelKey: 'settings.nav.general', labelDefault: '通用设置', icon: '⚙' },
    ],
  },
  {
    items: [
      { id: 'about', labelKey: 'settings.nav.about', labelDefault: '关于', icon: 'ℹ', hidden: true },
    ],
  },
]

interface SettingsSidebarProps {
  activeSection: string
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
  onSelect: (section: string) => void
}

export function SettingsSidebar({
  activeSection,
  collapsed,
  onCollapsedChange,
  onSelect,
}: SettingsSidebarProps) {
  const { t } = useTranslation()
  const skillActiveTab = useSkillStoreV2((s) => s.activeTab)
  const setSkillTab = useSkillStoreV2((s) => s.setTab)
  const skillAgents = useSkillStoreV2((s) => s.agents)
  const skillSelectedAgentId = useSkillStoreV2((s) => s.selectedAgentId)
  const selectAgent = useSkillStoreV2((s) => s.selectAgent)
  const requestCustomAgentDialog = useSkillStoreV2((s) => s.requestCustomAgentDialog)
  const sessionList = useSessionStore((s) => s.sessionList)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const [showOtherSkillAgents, setShowOtherSkillAgents] = useState(false)
  const [manualAgentOrder, setManualAgentOrder] = useState<string[]>(() => readStoredAgentOrder())
  const [draggedAgentId, setDraggedAgentId] = useState<string | null>(null)
  const [agentDropTarget, setAgentDropTarget] = useState<AgentDropTarget | null>(null)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const agentMouseCleanupRef = useRef<(() => void) | null>(null)
  const suppressAgentClickRef = useRef(false)
  const agentUsageScores = useMemo(() => buildAgentUsageScores(sessionList, activeSessionId), [sessionList, activeSessionId])
  const visibleSkillAgents = useMemo(() => skillAgents.filter((agent) => agent.id !== SHARED_SKILLS_AGENT_ID), [skillAgents])
  // Agents whose own program was detected lead the list; config-only and
  // not-installed Agents stay behind the "+" control.
  const { detected: detectedSkillAgents, hidden: otherSkillAgentsSource } = useMemo(
    () => splitAgentsByProgram(visibleSkillAgents),
    [visibleSkillAgents],
  )
  const installedSkillAgents = useMemo(
    () => sortAgentSummaries(detectedSkillAgents, { manualOrder: manualAgentOrder, usageScores: agentUsageScores }),
    [agentUsageScores, detectedSkillAgents, manualAgentOrder],
  )
  const otherSkillAgents = useMemo(
    () => sortAgentSummaries(otherSkillAgentsSource, { usageScores: agentUsageScores }),
    [agentUsageScores, otherSkillAgentsSource],
  )
  const reorderInstalledAgent = useCallback((sourceAgentId: string, target: AgentDropTarget) => {
    const next = installedSkillAgents.map((agent) => agent.id).filter((agentId) => agentId !== sourceAgentId)
    const targetIndex = next.indexOf(target.agentId)
    if (targetIndex < 0) return
    next.splice(targetIndex + (target.edge === 'after' ? 1 : 0), 0, sourceAgentId)
    setManualAgentOrder(next)
    writeStoredAgentOrder(next)
  }, [installedSkillAgents])
  const finishAgentDrag = () => {
    setDraggedAgentId(null)
    setAgentDropTarget(null)
  }
  const startAgentMouseDrag = (event: ReactMouseEvent<HTMLDivElement>, agentId: string) => {
    if (event.button !== 0 || installedSkillAgents.length < 2) return
    agentMouseCleanupRef.current?.()

    const startX = event.clientX
    const startY = event.clientY
    let dragging = false
    let dropTarget: AgentDropTarget | null = null

    const handleMouseMove = (mouseEvent: MouseEvent) => {
      if (!dragging && Math.hypot(mouseEvent.clientX - startX, mouseEvent.clientY - startY) < 6) return
      if (!dragging) {
        dragging = true
        setDraggedAgentId(agentId)
      }
      mouseEvent.preventDefault()

      const targetRow = Array.from(document.querySelectorAll<HTMLElement>('.sm2-sidebar__subitem-row[data-agent-id]')).find((row) => {
        const bounds = row.getBoundingClientRect()
        return mouseEvent.clientX >= bounds.left
          && mouseEvent.clientX <= bounds.right
          && mouseEvent.clientY >= bounds.top
          && mouseEvent.clientY <= bounds.bottom
      })
      const targetAgentId = targetRow?.dataset.agentId
      if (!targetRow || !targetAgentId || targetAgentId === agentId) {
        dropTarget = null
        setAgentDropTarget(null)
        return
      }

      const bounds = targetRow.getBoundingClientRect()
      const nextTarget: AgentDropTarget = {
        agentId: targetAgentId,
        edge: mouseEvent.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after',
      }
      if (dropTarget?.agentId === nextTarget.agentId && dropTarget.edge === nextTarget.edge) return
      dropTarget = nextTarget
      setAgentDropTarget(nextTarget)
    }

    const handleMouseUp = (mouseEvent: MouseEvent) => {
      if (dragging) mouseEvent.preventDefault()
      cleanup()
      if (dragging && dropTarget) reorderInstalledAgent(agentId, dropTarget)
      if (dragging) {
        suppressAgentClickRef.current = true
        window.setTimeout(() => { suppressAgentClickRef.current = false }, 0)
      }
      finishAgentDrag()
    }

    const cleanup = () => {
      window.removeEventListener('mousemove', handleMouseMove, true)
      window.removeEventListener('mouseup', handleMouseUp, true)
      agentMouseCleanupRef.current = null
    }

    window.addEventListener('mousemove', handleMouseMove, true)
    window.addEventListener('mouseup', handleMouseUp, true)
    agentMouseCleanupRef.current = cleanup
  }
  useEffect(() => () => agentMouseCleanupRef.current?.(), [])
  useEffect(() => {
    let cancelled = false
    getCurrentAppVersion()
      .then((version) => {
        if (!cancelled) setAppVersion(version)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])
  const sidebarClassName = 'settings-sidebar settings-scroll'
  const capabilitySidebarClassName = `settings-sidebar settings-sidebar--capability settings-scroll${collapsed ? ' settings-sidebar--collapsed' : ''}`
  const toggleLabel = collapsed ? t('settings.expandSidebar', { defaultValue: 'Expand sidebar' }) : t('settings.collapseSidebar', { defaultValue: 'Collapse sidebar' })
  const sectionTitleById: Record<string, string> = {
    'skill-manager-v2': t('settings.skillManager', { defaultValue: 'Agent管理' }),
  }
  const isCapabilitySection = activeSection === 'skill-manager-v2'
  const brandTitle = isCapabilitySection ? sectionTitleById[activeSection] : t('settings.title')
  const backToSettingsLabel = t('settings.backToSettings', { defaultValue: 'Back to Settings' })
  const openSkillTab = (tab: SkillManagerTab) => {
    setSkillTab(tab)
  }
  const selectMainNavItem = (item: SidebarItem) => {
    // Agent管理直接复用现有真实 Agent 管理页（技能库的 agents 标签页）。
    if (item.id === 'agents') openSkillTab('agents')
    onSelect(item.id)
  }
  const toggleSidebar = (
    <div className={`settings-sidebar__brand${isCapabilitySection ? ' settings-sidebar__brand--contextual' : ''}`}>
      <button
        type="button"
        className="settings-sidebar__brand-home"
        aria-label={isCapabilitySection ? backToSettingsLabel : t('settings.title')}
        title={isCapabilitySection ? backToSettingsLabel : t('settings.title')}
        onClick={() => onSelect('general')}
      >
        <span className="settings-sidebar__brand-mark" aria-hidden="true">
          <img className="settings-sidebar__collapse-logo" src="/vibe-board-logo.png" alt="" />
        </span>
        <span className="settings-sidebar__brand-copy">
          <span className="settings-sidebar__brand-title">{brandTitle}</span>
        </span>
      </button>
      <button
        type="button"
        className="settings-sidebar__collapse-toggle"
        aria-label={toggleLabel}
        title={toggleLabel}
        onClick={() => onCollapsedChange(!collapsed)}
      >
        <span className="settings-sidebar__brand-indicator" aria-hidden="true">
          {collapsed ? '›' : '‹'}
        </span>
      </button>
    </div>
  )

  if (activeSection === 'skill-manager-v2') {
    const skillTabs: Array<{ id: SkillManagerTab; label: string; icon: string; iconBg: string }> = [
      { id: 'library', label: 'Skill 库', icon: '🧩', iconBg: '#34C759' },
      { id: 'install', label: '安装 Skill', icon: '⬇', iconBg: '#FF9500' },
      { id: 'agents', label: 'Agent 管理', icon: '🤖', iconBg: '#007AFF' },
      { id: 'settings', label: '设置', icon: '⚙', iconBg: '#8E8E93' },
    ]

    return (
      <nav className={capabilitySidebarClassName}>
        {toggleSidebar}
        <div className="settings-capability-nav">
          {skillTabs.map((item) => (
            <button
              key={item.id}
              type="button"
              className={skillActiveTab === item.id ? 'active' : ''}
              aria-label={item.label}
              title={item.label}
              onClick={() => openSkillTab(item.id)}
            >
              <span
                className="settings-sidebar__icon settings-capability-nav__icon--colored"
                style={{ background: skillActiveTab === item.id ? 'rgba(255,255,255,0.25)' : item.iconBg, color: '#fff' }}
              >
                {item.icon}
              </span>
              <span className="settings-sidebar__label-text">{item.label}</span>
            </button>
          ))}
          {skillActiveTab === 'agents' && (
            <div className="sm2-sidebar__subgroup">
              <div className="sm2-sidebar__subgroup-label">
                <span>已检测到程序</span>
                <em>{installedSkillAgents.length}</em>
              </div>
              {visibleSkillAgents.length === 0 ? (
                <div className="sm2-sidebar__subgroup-empty">暂无</div>
              ) : (
                <>
                  {installedSkillAgents.length === 0 ? (
                    <div className="sm2-sidebar__subgroup-empty">暂无已安装 Agent</div>
                  ) : (
                    installedSkillAgents.map((a) => (
                      <div
                        key={a.id}
                        className={`sm2-sidebar__subitem-row${installedSkillAgents.length > 1 ? ' sm2-sidebar__subitem-row--draggable' : ''}${draggedAgentId === a.id ? ' sm2-sidebar__subitem-row--dragging' : ''}${agentDropTarget?.agentId === a.id ? ` sm2-sidebar__subitem-row--drop-${agentDropTarget.edge}` : ''}`}
                        data-agent-id={a.id}
                        title={`拖拽调整 ${a.displayName} 顺序`}
                        onMouseDown={(event) => startAgentMouseDrag(event, a.id)}
                      >
                        <button
                          type="button"
                          className={`sm2-sidebar__subitem${skillSelectedAgentId === a.id ? ' sm2-sidebar__subitem--active' : ''}`}
                          onClick={() => {
                            if (suppressAgentClickRef.current) return
                            selectAgent(a.id)
                          }}
                        >
                          <AgentIconBadge iconKey={a.iconKey} title={a.displayName} size={20} />
                          <span className="sm2-sidebar__subitem-label">{a.displayName}</span>
                          <span className="sm2-sidebar__subitem-dot" />
                        </button>
                        <span className="sm2-sidebar__drag-handle" aria-hidden="true" />
                      </div>
                    ))
                  )}
                  {otherSkillAgents.length > 0 && (
                    <div className="sm2-sidebar__subgroup-section">
                      <button
                        type="button"
                        className="sm2-sidebar__fold-toggle"
                        aria-expanded={showOtherSkillAgents}
                        onClick={() => setShowOtherSkillAgents((open) => !open)}
                      >
                        <span className={`sm2-sidebar__fold-chevron${showOtherSkillAgents ? ' sm2-sidebar__fold-chevron--open' : ''}`}>
                          ＋
                        </span>
                        <span>其他 Agent（未检测到程序）</span>
                        <em>{otherSkillAgents.length}</em>
                      </button>
                      {showOtherSkillAgents && otherSkillAgents.map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          className={`sm2-sidebar__subitem sm2-sidebar__subitem--muted${skillSelectedAgentId === a.id ? ' sm2-sidebar__subitem--active' : ''}`}
                          onClick={() => selectAgent(a.id)}
                        >
                          <AgentIconBadge iconKey={a.iconKey} title={a.displayName} size={20} />
                          <span className="sm2-sidebar__subitem-label">{a.displayName}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
              <button
                type="button"
                className="sm2-sidebar__subgroup-add"
                aria-label={t('settings.addEngineBranch')}
                title={t('settings.addEngineBranch')}
                onClick={requestCustomAgentDialog}
              >
                <span aria-hidden="true">＋</span>
                <span>{t('settings.addEngineBranch')}</span>
              </button>
            </div>
          )}
        </div>
      </nav>
    )
  }

  return (
    <nav className={sidebarClassName}>
      <div className="settings-sidebar__brand">
        <div className="settings-sidebar__brand-home settings-sidebar__brand-home--static">
          <span className="settings-sidebar__brand-mark" aria-hidden="true">
            <img className="settings-sidebar__collapse-logo" src="/vibe-board-logo.png" alt="" />
          </span>
          <span className="settings-sidebar__brand-copy">
            <span className="settings-sidebar__brand-title">Vibe Board</span>
            <span className="settings-sidebar__brand-sub">{t('settings.title')}</span>
          </span>
        </div>
      </div>
      <div className="settings-sidebar__nav">
        {sidebarGroups.map((group, gi) => (
          <div key={gi} hidden={group.items.every((item) => item.hidden)}>
            {group.labelKey && (
              <div className="settings-sidebar__group-label settings-sidebar__group-label--nav">
                {t(group.labelKey, { defaultValue: group.labelDefault })}
              </div>
            )}
            <div className="settings-sidebar__group">
              {group.items.map((item) => {
                const isActive = activeSection === item.id
                const label = t(item.labelKey, { defaultValue: item.labelDefault })
                return (
                  <div
                    key={item.id}
                    role="button"
                    tabIndex={0}
                    hidden={item.hidden}
                    className={`settings-sidebar__item ${isActive ? 'settings-sidebar__item--active' : ''}`}
                    aria-label={label}
                    title={label}
                    onClick={() => {
                      selectMainNavItem(item)
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return
                      e.preventDefault()
                      selectMainNavItem(item)
                    }}
                  >
                    <span
                      className="settings-sidebar__icon"
                      style={{ background: isActive ? 'var(--settings-sidebar-active)' : 'rgba(0, 140, 141, 0.10)', color: isActive ? 'var(--settings-accent)' : 'var(--settings-text-secondary)' }}
                    >
                      {item.icon}
                    </span>
                    <span className="settings-sidebar__label-text">{label}</span>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="settings-sidebar__foot">
        <span className="settings-sidebar__version">{appVersion ? `Vibe Board v${appVersion}` : 'Vibe Board'}</span>
        <span className="settings-sidebar__note">{t('settings.nav.autoSave', { defaultValue: '设置更改会自动保存' })}</span>
      </div>
    </nav>
  )
}
