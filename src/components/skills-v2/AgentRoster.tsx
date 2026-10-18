import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { splitAgentsByProgram, useSkillStoreV2 } from '../../stores/skillStoreV2'
import { useSessionStore } from '../../stores/sessionStore'
import { AgentIconBadge } from './AgentIconBadge'
import { buildAgentUsageScores, readStoredAgentOrder, sortAgentSummaries, writeStoredAgentOrder } from '../../utils/agentOrdering'

const SHARED_SKILLS_AGENT_ID = 'agents'

interface AgentDropTarget {
  agentId: string
  edge: 'before' | 'after'
}

// 已安装 Agent 列表：原名在设置侧栏里，M16c 挪进「按 Agent 看」页面内。
// 选中逻辑、拖拽排序与持久化、按使用活跃度排序、其他 Agent 折叠组、添加自定义 Agent 全部保持不变。
export function AgentRoster() {
  const { t } = useTranslation()
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

  return (
    <div className="sm2-sidebar__subgroup">
      <div className="sm2-sidebar__subgroup-label">
        <span>{t('settings.skillAgents.installed', { defaultValue: '已安装的 Agent' })}</span>
        <em>{installedSkillAgents.length}</em>
      </div>
      {visibleSkillAgents.length === 0 ? (
        <div className="sm2-sidebar__subgroup-empty">{t('settings.skillAgents.none', { defaultValue: '暂无' })}</div>
      ) : (
        <>
          {installedSkillAgents.length === 0 ? (
            <div className="sm2-sidebar__subgroup-empty">{t('settings.skillAgents.noneInstalled', { defaultValue: '还没有检测到已安装的 Agent' })}</div>
          ) : (
            installedSkillAgents.map((a) => (
              <div
                key={a.id}
                className={`sm2-sidebar__subitem-row${installedSkillAgents.length > 1 ? ' sm2-sidebar__subitem-row--draggable' : ''}${draggedAgentId === a.id ? ' sm2-sidebar__subitem-row--dragging' : ''}${agentDropTarget?.agentId === a.id ? ` sm2-sidebar__subitem-row--drop-${agentDropTarget.edge}` : ''}`}
                data-agent-id={a.id}
                title={t('settings.skillAgents.dragHint', { name: a.displayName, defaultValue: '拖拽调整 {{name}} 的顺序' })}
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
                <span>{t('settings.skillAgents.others', { defaultValue: '其他 Agent（没找到程序）' })}</span>
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
  )
}
