import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AnchorHTMLAttributes, CSSProperties, MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { open } from '@tauri-apps/plugin-dialog'
import { open as openShell } from '@tauri-apps/plugin-shell'
import { skillApiV2 } from '../../services/skillApiV2'
import { agentProgramDetected } from '../../stores/skillStoreV2'
import type { AddCenterSkillInput, AddCenterSkillPreview, AddCenterSkillDecision, AdoptPreview, AgentSkillInventoryAgent, AgentSkillInventoryItem, FileTreeNode } from '../../services/skillApiV2'
import type { GitHubRepoPreview } from '../../services/skillApiV2'
import { AdoptDialog } from './AdoptDialog'
import { AgentIconBadge } from './AgentIconBadge'
import { PreviewDialog } from './PreviewDialog'
import { SlideOver } from './SlideOver'
import { skillErrorMessage, skillModeLabel, unmanagedReasonLabel } from './skillLabels'
import { extractSkillDescription, stripSkillFrontmatter } from './frontmatter'


type InstallDoneHandler = (skillId?: string) => void | Promise<void>
const AGENT_SYNC_NOTICE_DISMISS_MS = 3200

type ViewMode = 'list' | 'cards'
type LocalPreviewViewMode = 'list' | 'cards'
type FileViewMode = 'preview' | 'source'
type LocalImportMode = 'copy' | 'link'
type LocalConflictResolution = 'overwrite' | 'rename' | 'skip'

function openExternal(url: string) {
  if ('__TAURI_INTERNALS__' in window) {
    openShell(url).catch((err) => console.warn('[skills] open external:', err))
  } else {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}

function initials(value: string) {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || 'SK'
}

// ── Local Agent sync ─────────────────────────────────────────────

type AgentSyncRow = { agent: AgentSkillInventoryAgent; item: AgentSkillInventoryItem }
type AgentSyncViewMode = 'list' | 'cards'
type AgentSkillDetailTab = 'overview' | 'files' | 'source'
type AgentSyncImportProgress = { current: number; total: number; currentName: string }
type OneClickOrganizeMode = 'import_link' | 'import_copy' | 'import_keep' | 'import_cleanup'
type BatchConflictMode = 'rename' | 'center_over_agent' | 'overwrite_center' | 'skip'
type BatchConflictScope = 'scoped' | 'visible'
const SHARED_SKILLS_AGENT_ID = 'agents'
const AGENT_STATUS_TABS = [
  { id: 'all', label: '全部' },
  { id: 'importable', label: '可接管' },
  { id: 'unmanaged', label: '未管理' },
  { id: 'conflict', label: '冲突' },
  { id: 'managed', label: '已管理' },
]

function statusTone(item: AgentSkillInventoryItem) {
  if (item.status === 'conflict') return 'conflict'
  return item.managed ? 'ok' : 'unmanaged'
}

function canOpenAdopt(item: AgentSkillInventoryItem) {
  return !item.managed && (item.canImport || item.status === 'conflict')
}

function installedAgentInventory(agents: AgentSkillInventoryAgent[]) {
  return agents
    .filter((agent) => agent.installed && agent.agentId !== SHARED_SKILLS_AGENT_ID)
    .sort((a, b) => {
      const skillCountDiff = localSkillCount(b) - localSkillCount(a)
      if (skillCountDiff !== 0) return skillCountDiff
      const importableDiff = b.importableCount - a.importableCount
      if (importableDiff !== 0) return importableDiff
      return a.displayName.localeCompare(b.displayName)
    })
}

/** Agent skill sources whose own program was detected. Config-only and
 *  not-installed Agents stay behind the "+" control. */
function programAgentInventory(agents: AgentSkillInventoryAgent[]) {
  return agents.filter(agentProgramDetected)
}

function otherAgentInventory(agents: AgentSkillInventoryAgent[]) {
  return agents.filter((agent) => !agentProgramDetected(agent))
}

function sharedAgentInventory(agents: AgentSkillInventoryAgent[]) {
  return agents.find((agent) => agent.installed && agent.agentId === SHARED_SKILLS_AGENT_ID) ?? null
}

function localSkillCount(agent: AgentSkillInventoryAgent) {
  return agent.managedCount + agent.unmanagedCount + (agent.readOnlyCount ?? 0)
}

function pluralSkill(count: number) {
  return `${count} 个`
}

function agentAttentionLabel(agent: AgentSkillInventoryAgent) {
  const conflicts = agentConflictCount(agent)
  if (agent.importableCount > 0 && conflicts > 0) return `${agent.importableCount} 可接管 · ${conflicts} 冲突`
  if (agent.importableCount > 0) return `${agent.importableCount} 可接管`
  if (conflicts > 0) return `${conflicts} 冲突`
  return '健康'
}

function agentAttentionTone(agent: AgentSkillInventoryAgent) {
  if (agentConflictCount(agent) > 0) return 'conflict'
  if (agent.importableCount > 0 || agent.unmanagedCount > 0) return 'attention'
  return 'ok'
}

function agentConflictCount(agent: AgentSkillInventoryAgent) {
  return agent.items.filter((item) => !item.managed && item.status === 'conflict').length
}

function shouldCleanupOnBatchAdopt(item: AgentSkillInventoryItem) {
  return item.agentId === 'agents' || isSharedAgentsSkillsPath(item.path)
}

function isSharedAgentsSkillsPath(path: string) {
  const parts = path.split(/[\\/]+/)
  return parts.some((part, index) => part === '.agents' && parts[index + 1] === 'skills')
}

function canBatchAdopt(item: AgentSkillInventoryItem) {
  return item.canImport && item.status !== 'conflict'
}

function defaultBatchAdoptMode(item: AgentSkillInventoryItem): OneClickOrganizeMode {
  return shouldCleanupOnBatchAdopt(item) ? 'import_cleanup' : 'import_keep'
}

function oneClickAdoptMode(item: AgentSkillInventoryItem, mode: OneClickOrganizeMode): OneClickOrganizeMode {
  return shouldCleanupOnBatchAdopt(item) ? 'import_cleanup' : mode
}

export function AgentSyncPanel({ onDone }: { onDone: InstallDoneHandler }) {
  const { t } = useTranslation()
  const [agents, setAgents] = useState<AgentSkillInventoryAgent[]>([])
  const [sharedAgent, setSharedAgent] = useState<AgentSkillInventoryAgent | null>(null)
  const [selectedAgent, setSelectedAgent] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [viewMode, setViewMode] = useState<AgentSyncViewMode>('cards')
  const [showManaged, setShowManaged] = useState(false)
  const [showOtherAgents, setShowOtherAgents] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [detailRow, setDetailRow] = useState<AgentSyncRow | null>(null)
  const [deleteDetailRow, setDeleteDetailRow] = useState<AgentSyncRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState<AgentSyncImportProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [adoptPreview, setAdoptPreview] = useState<AdoptPreview | null>(null)
  const [adoptOpeningId, setAdoptOpeningId] = useState<string | null>(null)
  const [oneClickOpen, setOneClickOpen] = useState(false)
  const [batchConflictOpen, setBatchConflictOpen] = useState(false)
  const [batchConflictScope, setBatchConflictScope] = useState<BatchConflictScope>('scoped')
  const [cleaningShared, setCleaningShared] = useState(false)
  const [deletingDetailTargetId, setDeletingDetailTargetId] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const inventory = await skillApiV2.listAgentSkillInventory()
      const next = installedAgentInventory(inventory)
      const nextShared = sharedAgentInventory(inventory)
      setAgents(next)
      setSharedAgent(nextShared)
      setSelectedAgent((current) => {
        if (current === 'all') return current
        return next.some((agent) => agent.agentId === current) ? current : 'all'
      })
      setSelectedIds((current) => {
        const sources = nextShared ? [...next, nextShared] : next
        const valid = new Set(sources.flatMap((agent) => agent.items.filter(canBatchAdopt).map((item) => importKey(item))))
        return new Set(Array.from(current).filter((id) => valid.has(id)))
      })
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), AGENT_SYNC_NOTICE_DISMISS_MS)
    return () => window.clearTimeout(timer)
  }, [notice])

  const scan = async () => {
    setScanning(true)
    setError(null)
    setNotice(null)
    try {
      await skillApiV2.refresh()
      await load()
      setNotice('已重新扫描本地 Agent Skills')
    } catch (e) {
      setError(String(e))
    } finally {
      setScanning(false)
    }
  }

  // 默认只列出检测到可执行程序的 Agent；其余（仅发现配置 / 未安装）收在「+」后面。
  const programAgents = useMemo(
    () => programAgentInventory(agents),
    [agents],
  )
  const otherAgents = useMemo(
    () => otherAgentInventory(agents),
    [agents],
  )
  const displayedAgents = showOtherAgents ? agents : programAgents
  const sortedAgents = useMemo(
    () => displayedAgents
      .map((agent, index) => ({ agent, index }))
      .sort((a, b) => {
        const conflictDiff = agentConflictCount(b.agent) - agentConflictCount(a.agent)
        if (conflictDiff !== 0) return conflictDiff
        return a.index - b.index
      })
      .map(({ agent }) => agent),
    [displayedAgents],
  )

  const visibleAgents = useMemo(
    () => selectedAgent === 'all' ? sortedAgents : sortedAgents.filter((agent) => agent.agentId === selectedAgent),
    [selectedAgent, sortedAgents],
  )

  const visibleSources = useMemo(
    () => selectedAgent === 'all' && sharedAgent ? [...visibleAgents, sharedAgent] : visibleAgents,
    [selectedAgent, sharedAgent, visibleAgents],
  )

  const allRows = useMemo(
    () => visibleSources.flatMap((agent) => agent.items.map((item) => ({ agent, item }))),
    [visibleSources],
  )

  const q = query.trim().toLowerCase()
  const matchesQuery = useCallback(({ item }: AgentSyncRow) => {
    if (!q) return true
    return [item.name, item.skillId, item.path, item.statusLabel, item.reason || '']
      .join(' ')
      .toLowerCase()
      .includes(q)
  }, [q])

  const pendingRows = useMemo(
    () => allRows.filter(({ item }) => (!item.managed && !item.readOnly) || item.status === 'conflict'),
    [allRows],
  )
  const baseRows = showManaged ? allRows : pendingRows
  const rows = useMemo(() => {
    return baseRows
      .filter(({ item }) => {
        if (statusFilter === 'managed' && !item.managed) return false
        if (statusFilter === 'importable' && !canBatchAdopt(item)) return false
        if (statusFilter === 'unmanaged' && item.managed) return false
        if (statusFilter === 'conflict' && item.status !== 'conflict') return false
        return true
      })
      .filter(matchesQuery)
      .map((row, index) => ({ row, index }))
      .sort((a, b) => {
        const conflictDiff = Number(b.row.item.status === 'conflict') - Number(a.row.item.status === 'conflict')
        if (conflictDiff !== 0) return conflictDiff
        return a.index - b.index
      })
      .map(({ row }) => row)
  }, [baseRows, matchesQuery, statusFilter])

  useEffect(() => {
    if (!showManaged && statusFilter === 'managed') {
      setStatusFilter('all')
    }
  }, [showManaged, statusFilter])

  const importableRows = useMemo(
    () => rows.filter(({ item }) => canBatchAdopt(item)),
    [rows],
  )
  const visibleConflictRows = useMemo(
    () => rows.filter(({ item }) => !item.managed && item.status === 'conflict'),
    [rows],
  )
  const oneClickConflictRows = useMemo(
    () => pendingRows.filter(({ item }) => !item.managed && item.status === 'conflict'),
    [pendingRows],
  )
  const oneClickItems = pendingRows.map(({ item }) => item)
  const oneClickImportable = oneClickItems.filter(canBatchAdopt)
  const oneClickConflicts = oneClickConflictRows.map(({ item }) => item)
  const batchConflictRows = batchConflictScope === 'visible' ? visibleConflictRows : oneClickConflictRows
  const scopedImportableCount = oneClickImportable.length
  const scopedConflictCount = oneClickConflicts.length
  const allSources = sharedAgent ? [...displayedAgents, sharedAgent] : displayedAgents
  const noInstalledAgents = !loading && allSources.length === 0 && (showOtherAgents || otherAgents.length === 0)
  const totalManaged = allSources.reduce((sum, agent) => sum + agent.managedCount, 0)
  const totalImportable = allSources.reduce((sum, agent) => sum + agent.importableCount, 0)
  const totalConflicts = allSources.reduce(
    (sum, agent) => sum + agent.items.filter((item) => !item.managed && item.status === 'conflict').length,
    0,
  )
  const pendingCount = allSources.reduce(
    (sum, agent) => sum + agent.items.filter((item) => !item.managed || item.status === 'conflict').length,
    0,
  )
  const summaryTitle = noInstalledAgents
    ? '未发现可同步的 Agent Skills 目录'
    : scopedImportableCount > 0
      ? `发现 ${pluralSkill(scopedImportableCount)}可接管 Skill，${scopedConflictCount} 个同名冲突`
      : scopedConflictCount > 0
        ? `发现 ${scopedConflictCount} 个同名冲突`
        : '本机 Agent Skills 已完成整理'
  const summaryRecommendation = noInstalledAgents
    ? '没有找到可同步的 Agent Skills 目录。可以点击「重新扫描」再试。'
    : sharedAgent && selectedAgent === 'all' && sharedAgent.importableCount > 0
      ? '建议先接管 .agents Skills 到中心库，并清理共享目录，避免未安装的 Agent 隐式生效。'
      : scopedImportableCount > 0
      ? '建议使用「软连接」一键整理：中心库作为唯一来源，Agent 目录指向中心库，后续同步最省心。'
      : scopedConflictCount > 0
        ? '建议先进入冲突项确认保留哪一份，再继续接管到中心库。'
        : '当前没有需要接管的 Skill；已管理 Skills 默认隐藏，保持当前状态即可。'
  const allAgentTone = totalConflicts > 0 ? 'conflict' : pendingCount > 0 ? 'attention' : 'ok'
  const primaryActionLabel = noInstalledAgents
    ? '重新扫描'
    : scopedImportableCount > 0
      ? `一键整理 ${scopedImportableCount} 个`
      : scopedConflictCount > 0
        ? '处理冲突'
        : '已完成'
  const primaryActionDisabled = noInstalledAgents
    ? importing || scanning
    : (scopedImportableCount === 0 && scopedConflictCount === 0) || importing || scanning
  const scanDisabled = scanning || importing

  const toggle = (item: AgentSkillInventoryItem) => {
    if (!canBatchAdopt(item)) return
    setSelectedIds((current) => {
      const next = new Set(current)
      const key = importKey(item)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const selectAllVisible = () => {
    setSelectedIds(new Set(importableRows.map(({ item }) => importKey(item))))
  }

  const importSelected = async () => {
    const selected = importableRows.filter(({ item }) => selectedIds.has(importKey(item)))
    if (selected.length === 0) return
    setImporting(true)
    setImportProgress({ current: 0, total: selected.length, currentName: selected[0]?.item.name ?? '' })
    setError(null)
    setNotice(null)
    try {
      let ok = 0
      const failed: string[] = []
      for (const [index, { item }] of selected.entries()) {
        setImportProgress({ current: index + 1, total: selected.length, currentName: item.name })
        try {
          await skillApiV2.executeAdopt(item.agentId, item.id, defaultBatchAdoptMode(item))
          ok += 1
        } catch (e) {
          failed.push(`${item.name}: ${skillErrorMessage(t, e)}`)
        }
      }
      await load()
      onDone()
      setSelectedIds(new Set())
      setDetailRow(null)
      setNotice(`已接管 ${ok} 个 Skill${failed.length ? `，${failed.length} 个失败` : ''}`)
      if (failed.length > 0) setError(failed.slice(0, 3).join('\n'))
    } finally {
      setImporting(false)
      setImportProgress(null)
    }
  }

  const openAdoptPreview = async (item: AgentSkillInventoryItem) => {
    if (!canOpenAdopt(item) || importing || adoptOpeningId) return
    setAdoptOpeningId(importKey(item))
    setError(null)
    setNotice(null)
    try {
      const preview = await skillApiV2.previewAdopt(item.agentId, item.id)
      setAdoptPreview(preview)
    } catch (e) {
      setError(skillErrorMessage(t, e))
    } finally {
      setAdoptOpeningId(null)
    }
  }

  const finishAdoptPreview = async () => {
    setAdoptPreview(null)
    await load()
    await onDone()
    setSelectedIds(new Set())
    setDetailRow(null)
    setNotice('已接管 1 个 Skill')
  }

  const cleanupManagedSharedSkills = async () => {
    if (!sharedAgent || cleaningShared || importing || scanning) return
    const targetIds = sharedAgent.items
      .filter((item) => item.managed && item.targetId)
      .map((item) => item.targetId as string)
    if (targetIds.length === 0) return
    setCleaningShared(true)
    setError(null)
    setNotice(null)
    try {
      const result = await skillApiV2.deleteSkillTargetDistributions(targetIds)
      await load()
      await onDone()
      const failed = result.failures.map((failure) => `${failure.targetId}: ${failure.error}`)
      setNotice(`已清理 ${result.deleted} 个 .agents 已管理 Skill${failed.length ? `，${failed.length} 个失败` : ''}`)
      if (failed.length > 0) setError(failed.slice(0, 3).join('\n'))
    } catch (e) {
      setError(String(e))
    } finally {
      setCleaningShared(false)
    }
  }

  const deleteDetailDistribution = async (row: AgentSyncRow) => {
    const targetId = row.item.targetId
    if (!targetId || deletingDetailTargetId) return
    setDeletingDetailTargetId(targetId)
    setError(null)
    setNotice(null)
    try {
      const result = await skillApiV2.deleteSkillTargetDistributions([targetId])
      await load()
      await onDone()
      setDetailRow(null)
      setDeleteDetailRow(null)
      const failed = result.failures.map((failure) => `${row.item.name}: ${failure.error}`)
      setNotice(`已删除 ${result.deleted} 个 Skill 生效${failed.length ? `，${failed.length} 个失败` : ''}`)
      if (failed.length > 0) setError(failed.slice(0, 3).join('\n'))
    } catch (e) {
      setError(String(e))
    } finally {
      setDeletingDetailTargetId(null)
    }
  }

  const openOneClickOrganize = () => {
    if (oneClickImportable.length === 0) {
      setNotice(null)
      setError(oneClickConflicts.length > 0
        ? `${oneClickConflicts.length} 个 Skill 需要先处理冲突。点击卡片里的「处理冲突」继续。`
        : '当前没有可一键整理的未管理 Skill。')
      return
    }
    setError(null)
    setNotice(null)
    setOneClickOpen(true)
  }

  const handlePrimarySyncAction = () => {
    if (noInstalledAgents) {
      void scan()
      return
    }
    if (scopedImportableCount > 0) {
      openOneClickOrganize()
      return
    }
    if (scopedConflictCount > 0 && oneClickConflicts[0]) {
      void openAdoptPreview(oneClickConflicts[0])
    }
  }

  const openBatchConflicts = (scope: BatchConflictScope) => {
    const count = scope === 'visible' ? visibleConflictRows.length : oneClickConflictRows.length
    if (count === 0) return
    setError(null)
    setNotice(null)
    setBatchConflictScope(scope)
    setBatchConflictOpen(true)
  }

  const executeOneClickOrganize = async (mode: OneClickOrganizeMode) => {
    const importable = oneClickImportable
    const conflicts = oneClickConflicts
    setOneClickOpen(false)
    setImporting(true)
    setImportProgress({ current: 0, total: importable.length, currentName: importable[0]?.name ?? '' })
    setError(null)
    setNotice(null)
    try {
      let ok = 0
      const failed: string[] = []
      for (const [index, item] of importable.entries()) {
        setImportProgress({ current: index + 1, total: importable.length, currentName: item.name })
        try {
          await skillApiV2.executeAdopt(item.agentId, item.id, oneClickAdoptMode(item, mode), null)
          ok += 1
        } catch (e) {
          failed.push(`${item.name}: ${skillErrorMessage(t, e)}`)
        }
      }
      await load()
      onDone()
      setSelectedIds(new Set())
      setDetailRow(null)
      setNotice(`已整理 ${ok} 个 Skill${modeNoticeSuffix(mode)}${conflicts.length ? `，${conflicts.length} 个需要处理冲突` : ''}${failed.length ? `，${failed.length} 个失败` : ''}`)
      if (failed.length > 0) setError(failed.slice(0, 3).join('\n'))
    } finally {
      setImporting(false)
      setImportProgress(null)
    }
  }

  const executeBatchConflicts = async (mode: BatchConflictMode) => {
    const conflicts = batchConflictRows
    if (conflicts.length === 0) return
    setBatchConflictOpen(false)
    setImporting(true)
    setImportProgress({ current: 0, total: conflicts.length, currentName: conflicts[0]?.item.name ?? '' })
    setError(null)
    setNotice(null)
    try {
      let ok = 0
      const failed: string[] = []
      for (const [index, { item }] of conflicts.entries()) {
        setImportProgress({ current: index + 1, total: conflicts.length, currentName: item.name })
        try {
          await skillApiV2.executeAdopt(
            item.agentId,
            item.id,
            mode,
            mode === 'rename' ? batchConflictRenameId(item) : null,
          )
          ok += 1
        } catch (e) {
          failed.push(`${item.name}: ${skillErrorMessage(t, e)}`)
        }
      }
      await load()
      await onDone()
      setSelectedIds(new Set())
      setDetailRow(null)
      setNotice(`${batchConflictDoneVerb(mode)} ${ok} 个冲突 Skill${failed.length ? `，${failed.length} 个失败` : ''}`)
      if (failed.length > 0) setError(failed.slice(0, 3).join('\n'))
    } finally {
      setImporting(false)
      setImportProgress(null)
    }
  }

  return (
    <div className="sm2__agent-sync sm2__install-market">
      <div className="sm2__agent-sync-summary">
        <div className="sm2__agent-sync-summary-main">
          <strong>{summaryTitle}</strong>
          <span>{summaryRecommendation}</span>
          <div className="sm2__agent-sync-summary-chips" aria-label="同步摘要">
            <em>{displayedAgents.length} Agent</em>
            {sharedAgent && <em>.agents Skills {localSkillCount(sharedAgent)}</em>}
            <em>{totalManaged} 已管理，默认隐藏</em>
            <em>{sharedAgent && sharedAgent.importableCount > 0 ? '.agents 清理推荐' : totalImportable > 0 ? '软连接推荐' : `${pendingCount} 待处理`}</em>
          </div>
        </div>
        <div className="sm2__agent-sync-summary-actions">
          {!noInstalledAgents && (
            <button className="sm2__btn" onClick={scan} disabled={scanDisabled}>
              {scanning ? '扫描中…' : '重新扫描'}
            </button>
          )}
          <button
            className="sm2__btn sm2__btn--featured"
            onClick={handlePrimarySyncAction}
            disabled={primaryActionDisabled}
          >
            {importing ? '整理中…' : primaryActionLabel}
          </button>
        </div>
      </div>

      <div className="sm2__agent-sync-agent-strip" aria-label="Agent 筛选">
        <button
          type="button"
          className={`sm2__agent-sync-agent-card sm2__agent-sync-agent-card--${allAgentTone}${selectedAgent === 'all' ? ' sm2__agent-sync-agent-card--active' : ''}`}
          onClick={() => setSelectedAgent('all')}
          disabled={scanning}
          aria-pressed={selectedAgent === 'all'}
        >
          <AgentIconBadge iconKey="agents" size={28} title="全部 Agent" />
          <span>
            <strong>全部 Agent</strong>
            <small>{pendingCount > 0 ? `${pendingCount} 待处理` : '健康'}</small>
          </span>
        </button>
        {sortedAgents.map((agent) => {
          const tone = agentAttentionTone(agent)
          return (
            <button
              key={agent.agentId}
              type="button"
              className={`sm2__agent-sync-agent-card sm2__agent-sync-agent-card--${tone}${selectedAgent === agent.agentId ? ' sm2__agent-sync-agent-card--active' : ''}`}
              onClick={() => setSelectedAgent(agent.agentId)}
              disabled={scanning}
              aria-pressed={selectedAgent === agent.agentId}
            >
              <AgentIconBadge iconKey={agent.iconKey} size={28} title={agent.displayName} />
              <span>
                <strong>{agent.displayName}</strong>
                <small>{agentAttentionLabel(agent)}</small>
              </span>
            </button>
          )
        })}
        {otherAgents.length > 0 && (
          <button
            type="button"
            className={`sm2__agent-sync-agent-card sm2__agent-sync-agent-card--more${showOtherAgents ? ' sm2__agent-sync-agent-card--active' : ''}`}
            aria-expanded={showOtherAgents}
            title="显示未检测到程序的 Agent"
            onClick={() => setShowOtherAgents((open) => !open)}
          >
            <span className="sm2__agent-sync-agent-card-more-mark" aria-hidden="true">＋</span>
            <span>
              <strong>其他 Agent</strong>
              <small>{showOtherAgents ? '收起' : `${otherAgents.length} 个未检测到程序`}</small>
            </span>
          </button>
        )}
      </div>

      {sharedAgent && (
        <div className="sm2__agent-sync-shared-source">
          <AgentIconBadge iconKey={sharedAgent.iconKey} size={28} title={sharedAgent.displayName} />
          <div>
            <strong>本地 .agents Skills</strong>
            <span>{sharedAgent.skillsDir || '~/.agents/skills'} · {sharedAgent.importableCount} 可接管，{sharedAgent.unmanagedCount} 未管理</span>
          </div>
          {sharedAgent.managedCount > 0 && (
            <button
              type="button"
              className="sm2__btn sm2__btn--small sm2__btn--danger"
              disabled={cleaningShared || importing || scanning}
              onClick={() => void cleanupManagedSharedSkills()}
            >
              {cleaningShared ? '清理中…' : '清理已管理 .agents Skills'}
            </button>
          )}
        </div>
      )}

      <section className="sm2__agent-sync-inbox" aria-labelledby="agent-sync-inbox-title">
        <div className="sm2__agent-sync-inbox-head">
          <div>
            <h3 id="agent-sync-inbox-title">待处理收纳箱</h3>
            <p>只显示需要用户决策的 Skill。已选择 {selectedIds.size} 个。</p>
          </div>
          <div className="sm2__agent-sync-inbox-tools">
            <div className="sm2__search-wrapper">
              <span className="sm2__search-icon">⌕</span>
              <input
                className="sm2__search sm2__search--with-icon"
                aria-label="搜索待处理 Skill"
                placeholder="搜索待处理 Skill…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <label className="sm2__agent-select sm2__agent-select--compact">
              <span>选择 Agent</span>
              <select
                aria-label="选择 Agent"
                value={selectedAgent}
                onChange={(e) => setSelectedAgent(e.target.value)}
                disabled={scanning}
              >
                <option value="all">全部 Agent</option>
                {sortedAgents.map((agent) => (
                  <option key={agent.agentId} value={agent.agentId}>
                    {agent.displayName} · {agent.importableCount} 可接管
                  </option>
                ))}
              </select>
            </label>
            <div className="sm2__view-toggle sm2__view-toggle--soft" aria-label="切换待处理视图">
              <button aria-pressed={viewMode === 'list'} className={viewMode === 'list' ? 'active' : ''} onClick={() => setViewMode('list')}>列表</button>
              <button aria-pressed={viewMode === 'cards'} className={viewMode === 'cards' ? 'active' : ''} onClick={() => setViewMode('cards')}>卡片</button>
            </div>
            <div className="sm2__agent-sync-batch-actions">
              <button className="sm2__btn" onClick={selectAllVisible} disabled={importableRows.length === 0 || importing}>选择当前可接管</button>
              <button className="sm2__btn" onClick={() => openBatchConflicts('visible')} disabled={visibleConflictRows.length === 0 || importing}>批量处理冲突</button>
              <button className="sm2__btn" onClick={() => setSelectedIds(new Set())} disabled={selectedIds.size === 0 || importing}>清空</button>
              <button className="sm2__btn sm2__btn--primary" onClick={importSelected} disabled={selectedIds.size === 0 || importing}>
                {importing ? '接管中…' : '接管到中心库'}
              </button>
            </div>
            {notice && <AgentSyncNotice notice={notice} onDismiss={() => setNotice(null)} />}
          </div>
        </div>

        <div className="sm2__agent-sync-advanced">
          <button
            className="sm2__btn sm2__btn--ghost"
            type="button"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((open) => !open)}
          >
            高级查看
          </button>
          {advancedOpen && (
            <div className="sm2__agent-sync-advanced-panel">
              <label className="sm2__agent-sync-managed-toggle">
                <input
                  type="checkbox"
                  checked={showManaged}
                  onChange={(e) => setShowManaged(e.target.checked)}
                />
                <span>显示已管理 Skills</span>
              </label>
              <div className="sm2__view-toggle sm2__market-boardtabs">
                {AGENT_STATUS_TABS.map((tab) => {
                  const managedLocked = tab.id === 'managed' && !showManaged
                  return (
                    <button
                      key={tab.id}
                      className={statusFilter === tab.id ? 'active' : ''}
                      aria-pressed={statusFilter === tab.id}
                      disabled={managedLocked}
                      onClick={() => setStatusFilter(tab.id)}
                    >
                      {tab.label}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        {importProgress && <AgentSyncProgress progress={importProgress} />}

        {error && <div className="sm2__error" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{error}</div>}

        {loading ? (
          <div className="sm2__empty">加载本地 Agent Skills…</div>
        ) : noInstalledAgents ? (
          <div className="sm2__empty">没有找到可同步的 Agent Skills 目录。可以点击「重新扫描」再试。</div>
        ) : rows.length === 0 ? (
          <div className="sm2__empty">{showManaged ? '没有匹配的本地 Skill。' : '没有需要接管的 Skill。可以在高级查看中显示已管理 Skills。'}</div>
        ) : viewMode === 'cards' ? (
          <div className="sm2__install-grid">
            {rows.map(({ agent, item }) => {
              const key = importKey(item)
              const checked = selectedIds.has(key)
              const tone = statusTone(item)
              return (
                <div
                  key={key}
                  className={`sm2__install-card sm2__agent-sync-card sm2__agent-sync-card--${tone}${checked ? ' sm2__agent-sync-card--selected' : ''}`}
                  onClick={() => setDetailRow({ agent, item })}
                >
                  <div className="sm2__agent-sync-card-head">
                    <input
                      type="checkbox"
                      className="sm2__agent-sync-checkbox"
                      aria-label={`选择 ${item.name}`}
                      checked={checked}
                      disabled={!canBatchAdopt(item) || importing}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggle(item)}
                    />
                    <AgentIconBadge iconKey={agent.iconKey} size={34} title={agent.displayName} />
                    <div className="sm2__agent-sync-card-title">{item.name}</div>
                    {canBatchAdopt(item) && (
                      <button
                        className="sm2__icon-btn sm2__icon-btn--add"
                        title="接管到中心库"
                        aria-label={`接管到中心库：${item.name}`}
                        disabled={importing || adoptOpeningId === key}
                        onClick={(e) => { e.stopPropagation(); void openAdoptPreview(item) }}
                      >
                        +
                      </button>
                    )}
                    {!canBatchAdopt(item) && item.status === 'conflict' && (
                      <button
                        className="sm2__btn sm2__btn--small"
                        title="处理同名冲突"
                        disabled={importing || adoptOpeningId === key}
                        onClick={(e) => { e.stopPropagation(); void openAdoptPreview(item) }}
                      >
                        处理冲突
                      </button>
                    )}
                  </div>
                  <div className="sm2__agent-sync-card-meta">
                    <span className="sm2__source-pill">{agent.displayName}</span>
                    <span className={`sm2__tag sm2__tag--${tone}`}>{item.statusLabel}</span>
                    {item.actualMode && <span className="sm2__tag">{skillModeLabel(t, item.actualMode)}</span>}
                  </div>
                  <code className="sm2__agent-sync-card-path">{item.path}</code>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="sm2__market-list sm2__agent-sync-listview">
            {rows.map(({ agent, item }) => {
              const key = importKey(item)
              const checked = selectedIds.has(key)
              const tone = statusTone(item)
              return (
                <div
                  key={key}
                  className="sm2__market-item sm2__agent-sync-item"
                  onClick={() => setDetailRow({ agent, item })}
                  style={{ cursor: 'pointer' }}
                >
                  <input
                    type="checkbox"
                    className="sm2__agent-sync-checkbox"
                    aria-label={`选择 ${item.name}`}
                    checked={checked}
                    disabled={!canBatchAdopt(item) || importing}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggle(item)}
                  />
                  <AgentIconBadge iconKey={agent.iconKey} size={34} title={agent.displayName} />
                  <div className="sm2__market-item-main">
                    <div className="sm2__market-item-title">
                      <strong>{item.name}</strong>
                    </div>
                    <div className="sm2__market-item-meta">
                      <span className="sm2__source-pill">{agent.displayName}</span>
                      <span className={`sm2__tag sm2__tag--${tone}`}>{item.statusLabel}</span>
                      {item.actualMode && <span className="sm2__tag">{skillModeLabel(t, item.actualMode)}</span>}
                      <code className="sm2__agent-sync-item-path">{item.path}</code>
                    </div>
                  </div>
                  {canBatchAdopt(item) && (
                    <button
                      className="sm2__icon-btn sm2__icon-btn--add"
                      title="接管到中心库"
                      aria-label={`接管到中心库：${item.name}`}
                      disabled={importing || adoptOpeningId === key}
                      onClick={(e) => { e.stopPropagation(); void openAdoptPreview(item) }}
                    >
                      +
                    </button>
                  )}
                  {!canBatchAdopt(item) && item.status === 'conflict' && (
                    <button
                      className="sm2__btn sm2__btn--small"
                      disabled={importing || adoptOpeningId === key}
                      onClick={(e) => { e.stopPropagation(); void openAdoptPreview(item) }}
                    >
                      处理冲突
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      <AgentSkillDetail
        row={detailRow}
        importing={importing}
        opening={Boolean(adoptOpeningId)}
        deleting={Boolean(deletingDetailTargetId)}
        onClose={() => setDetailRow(null)}
        onAdopt={(item) => void openAdoptPreview(item)}
        onDelete={(row) => setDeleteDetailRow(row)}
      />

      {deleteDetailRow && (
        <PreviewDialog
          title={`从 Agent 移除「${deleteDetailRow.item.name}」`}
          confirmLabel="确认删除"
          busyLabel="删除中…"
          destructive
          busy={deletingDetailTargetId === deleteDetailRow.item.targetId}
          onCancel={() => setDeleteDetailRow(null)}
          onConfirm={() => void deleteDetailDistribution(deleteDetailRow)}
        >
          <p>将从 <strong>{deleteDetailRow.agent.displayName}</strong> 移除这个 Skill，并删除对应的本地目标。之后仍可从中心库重新安装。</p>
        </PreviewDialog>
      )}

      {adoptPreview && (
        <AdoptDialog
          preview={adoptPreview}
          onClose={() => setAdoptPreview(null)}
          onDone={finishAdoptPreview}
        />
      )}
      {oneClickOpen && (
        <OneClickOrganizeDialog
          importableCount={oneClickImportable.length}
          conflictCount={oneClickConflicts.length}
          busy={importing}
          onClose={() => setOneClickOpen(false)}
          onConfirm={(mode) => void executeOneClickOrganize(mode)}
        />
      )}
      {batchConflictOpen && (
        <BatchConflictDialog
          conflictCount={batchConflictRows.length}
          visibleOnly={batchConflictScope === 'visible'}
          busy={importing}
          onClose={() => setBatchConflictOpen(false)}
          onConfirm={(mode) => void executeBatchConflicts(mode)}
        />
      )}
    </div>
  )
}

function batchConflictRenameId(item: AgentSkillInventoryItem) {
  const raw = `${item.skillId || item.name || item.id}-${item.agentId || 'agent'}`
  const normalized = raw
    .trim()
    .replace(/[\s./\\]+/g, '-')
    .replace(/[^A-Za-z0-9_-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return normalized || `${item.id}-import`
}

function batchConflictDoneVerb(mode: BatchConflictMode) {
  switch (mode) {
    case 'rename':
      return '已新增'
    case 'center_over_agent':
      return '已用中心库版本接管'
    case 'overwrite_center':
      return '已覆盖中心库并接管'
    case 'skip':
      return '已跳过'
  }
}

function modeNoticeSuffix(mode: OneClickOrganizeMode) {
  switch (mode) {
    case 'import_link':
      return ' 为中心库软连接'
    case 'import_copy':
      return ' 为中心库副本'
    case 'import_keep':
      return ' 并保留现有文件'
    case 'import_cleanup':
      return ' 并清理 .agents 原目录'
  }
}

function OneClickOrganizeDialog({
  importableCount,
  conflictCount,
  busy,
  onClose,
  onConfirm,
}: {
  importableCount: number
  conflictCount: number
  busy: boolean
  onClose: () => void
  onConfirm: (mode: OneClickOrganizeMode) => void
}) {
  const [mode, setMode] = useState<OneClickOrganizeMode>('import_link')

  return (
    <PreviewDialog
      title="一键整理 Skills"
      confirmLabel="开始整理"
      modalClassName="sm2__modal--adopt sm2__modal--one-click"
      busy={busy}
      onConfirm={() => onConfirm(mode)}
      onCancel={onClose}
    >
      <div className="sm2-oneclick">
        <div className="sm2-oneclick__summary">
          <strong>将整理 {importableCount} 个可接管 Skill</strong>
          <span>Vibe Board 会先同步到中心库，再按你选择的方式更新当前 Agent 目录。</span>
          {conflictCount > 0 && (
            <em>{conflictCount} 个同名冲突会保留给原来的冲突处理流程。</em>
          )}
        </div>

        <div className="sm2-oneclick__options" role="radiogroup" aria-label="一键整理方式">
          {ONE_CLICK_ORGANIZE_OPTIONS.map((option) => {
            const active = mode === option.value
            return (
              <button
                key={option.value}
                type="button"
                className={`sm2-oneclick__option${active ? ' sm2-oneclick__option--active' : ''}`}
                role="radio"
                aria-checked={active}
                aria-label={option.label}
                onClick={() => setMode(option.value)}
              >
                <span className="sm2-oneclick__radio" />
                <span className="sm2-oneclick__option-main">
                  <strong>{option.label}</strong>
                  <span>{option.description}</span>
                </span>
                {option.badge && <em>{option.badge}</em>}
              </button>
            )
          })}
        </div>
      </div>
    </PreviewDialog>
  )
}

function BatchConflictDialog({
  conflictCount,
  visibleOnly,
  busy,
  onClose,
  onConfirm,
}: {
  conflictCount: number
  visibleOnly: boolean
  busy: boolean
  onClose: () => void
  onConfirm: (mode: BatchConflictMode) => void
}) {
  const [mode, setMode] = useState<BatchConflictMode>('center_over_agent')
  const selected = BATCH_CONFLICT_OPTIONS.find((option) => option.value === mode)

  return (
    <PreviewDialog
      title="批量处理冲突"
      confirmLabel={mode === 'rename' ? '批量新增' : '开始处理'}
      modalClassName="sm2__modal--adopt sm2__modal--one-click sm2__modal--batch-conflict"
      destructive={selected?.destructive}
      busy={busy}
      onConfirm={() => onConfirm(mode)}
      onCancel={onClose}
    >
      <div className="sm2-oneclick">
        <div className="sm2-oneclick__summary sm2-oneclick__summary--conflict">
          <strong>将处理 {conflictCount} 个同名冲突 Skill</strong>
          <span>{visibleOnly ? '范围为当前筛选结果中的冲突项。' : '范围为当前 Agent 范围内的全部冲突项。'}</span>
          <em>默认“中心库为准”会保留中心库已有版本，并把 Agent 目录替换为指向中心库的链接。</em>
        </div>

        <div className="sm2-oneclick__options" role="radiogroup" aria-label="批量冲突处理方式">
          {BATCH_CONFLICT_OPTIONS.map((option) => {
            const active = mode === option.value
            return (
              <button
                key={option.value}
                type="button"
                className={`sm2-oneclick__option${active ? ' sm2-oneclick__option--active' : ''}${option.destructive ? ' sm2-oneclick__option--warn' : ''}`}
                role="radio"
                aria-checked={active}
                aria-label={option.label}
                onClick={() => setMode(option.value)}
              >
                <span className="sm2-oneclick__radio" />
                <span className="sm2-oneclick__option-main">
                  <strong>{option.label}</strong>
                  <span>{option.description}</span>
                </span>
                <em>{option.badge}</em>
              </button>
            )
          })}
        </div>
      </div>
    </PreviewDialog>
  )
}

const BATCH_CONFLICT_OPTIONS: Array<{
  value: BatchConflictMode
  label: string
  description: string
  badge: string
  destructive: boolean
}> = [
  {
    value: 'center_over_agent',
    label: '中心库为准（推荐）',
    description: '保留中心库已有版本，并把 Agent 目录替换为指向中心库的链接。',
    badge: '推荐',
    destructive: true,
  },
  {
    value: 'rename',
    label: '重命名新增',
    description: '按 skill-agent 形式生成新 ID 导入中心库，中心库原同名 Skill 不会被覆盖。',
    badge: '新增',
    destructive: false,
  },
  {
    value: 'overwrite_center',
    label: '覆盖中心库',
    description: '用当前 Agent 文件覆盖中心库里的同名 Skill，再把它纳入管理。',
    badge: '覆盖',
    destructive: true,
  },
  {
    value: 'skip',
    label: '跳过',
    description: '不改动中心库和 Agent 目录，这些冲突项仍保持未管理。',
    badge: '跳过',
    destructive: false,
  },
]

const ONE_CLICK_ORGANIZE_OPTIONS: Array<{
  value: OneClickOrganizeMode
  label: string
  description: string
  badge?: string
}> = [
  {
    value: 'import_link',
    label: '软连接（推荐）',
    description: '中心库作为唯一来源，Agent 目录改成指向中心库的软连接，后续同步最省心。',
    badge: '推荐',
  },
  {
    value: 'import_copy',
    label: '复制到 Agent',
    description: '中心库保存一份，再复制一份到 Agent 目录，适合不想使用软连接的环境。',
  },
  {
    value: 'import_keep',
    label: '保留现有文件',
    description: '只把现有 Skill 纳入管理，Agent 目录里的文件先不替换。',
  },
]

function AgentSyncNotice({ notice, onDismiss }: { notice: string; onDismiss: () => void }) {
  return (
    <div className="sm2__agent-sync-notice" role="status" aria-live="polite">
      <span className="sm2__agent-sync-notice-mark" aria-hidden="true">✓</span>
      <span>{notice}</span>
      <button type="button" onClick={onDismiss} aria-label="关闭提示">×</button>
    </div>
  )
}

function AgentSyncProgress({ progress }: { progress: AgentSyncImportProgress }) {
  const percent = progress.total > 0
    ? Math.max(4, Math.round((progress.current / progress.total) * 100))
    : 4

  return (
    <div className="sm2__agent-sync-progress sm2__agent-sync-progress--floating" role="status" aria-live="polite">
      <div className="sm2__agent-sync-progress-main">
        <span>正在接管 {progress.current} / {progress.total}</span>
        <strong>{progress.currentName || '准备中'}</strong>
      </div>
      <div
        className="sm2__agent-sync-progress-bar"
        aria-hidden="true"
        style={{ '--sm2-agent-sync-progress': `${percent}%` } as CSSProperties}
      >
        <span />
      </div>
    </div>
  )
}

function AgentSkillDetail({ row, importing, opening, deleting, onClose, onAdopt, onDelete }: {
  row: AgentSyncRow | null
  importing: boolean
  opening: boolean
  deleting: boolean
  onClose: () => void
  onAdopt: (item: AgentSkillInventoryItem) => void
  onDelete: (row: AgentSyncRow) => void
}) {
  const agent = row?.agent
  const item = row?.item
  const canDelete = Boolean(row && item?.managed && item.targetId)
  const [revealBusy, setRevealBusy] = useState(false)
  const [revealError, setRevealError] = useState<string | null>(null)

  useEffect(() => {
    setRevealBusy(false)
    setRevealError(null)
  }, [item?.path])

  const revealInFinder = async () => {
    if (!item) return
    setRevealBusy(true)
    setRevealError(null)
    try {
      await skillApiV2.revealPath(item.path)
    } catch (e) {
      setRevealError(`无法在 Finder 中打开：${String(e)}`)
    } finally {
      setRevealBusy(false)
    }
  }

  return (
    <SlideOver
      open={!!row}
      onClose={onClose}
      width={1040}
      className="sm2__slideover--skill-detail"
      title={item?.name || ''}
      subtitle={agent?.displayName || undefined}
      actions={
        item ? (
          <>
            <button
              className="sm2__btn sm2__btn--primary"
              disabled={!canOpenAdopt(item) || importing || opening}
              onClick={() => onAdopt(item)}
            >
              {importing || opening ? '准备中…' : canBatchAdopt(item) ? '接管到中心库' : item.status === 'conflict' ? '处理冲突' : item.managed ? '已被管理' : '无法接管'}
            </button>
            <button className="sm2__btn sm2__btn--ghost" disabled={revealBusy} onClick={() => void revealInFinder()}>
              {revealBusy ? '打开中…' : '打开目录 ↗'}
            </button>
            {canDelete && row && (
              <button className="sm2__btn sm2__btn--danger" disabled={importing || opening || deleting} onClick={() => onDelete(row)}>
                {deleting ? '删除中…' : '移除'}
              </button>
            )}
          </>
        ) : undefined
      }
    >
      {agent && item && (
        <>
          {revealError && <div className="sm2__error" style={{ margin: 0 }}>{revealError}</div>}
          <AgentSkillDetailBody key={`${agent.agentId}:${item.id}:${item.path}`} agent={agent} item={item} />
        </>
      )}
    </SlideOver>
  )
}

function AgentSkillDetailBody({ agent, item }: { agent: AgentSkillInventoryAgent; item: AgentSkillInventoryItem }) {
  const { t } = useTranslation()
  const tone = statusTone(item)
  const [tab, setTab] = useState<AgentSkillDetailTab>('overview')
  const skillMdPath = `${item.path}/SKILL.md`
  const [fileTree, setFileTree] = useState<FileTreeNode | null>(null)
  const [activeFile, setActiveFile] = useState<string | null>(skillMdPath)
  const [fileContent, setFileContent] = useState('')
  const [fileLoading, setFileLoading] = useState(true)
  const [fileViewMode, setFileViewMode] = useState<FileViewMode>('preview')
  const [doc, setDoc] = useState<{ content: string; loading: boolean; error: string | null }>({
    content: '',
    loading: true,
    error: null,
  })
  const tabs: Array<{ id: AgentSkillDetailTab; label: string }> = [
    { id: 'overview', label: '概览' },
    { id: 'files', label: '文件' },
    { id: 'source', label: '来源' },
  ]
  const reason = unmanagedReasonLabel(t, item.reason)
  const mode = item.actualMode ? skillModeLabel(t, item.actualMode) : ''
  const docDescription = extractSkillDescription(doc.content)

  useEffect(() => {
    let alive = true
    Promise.allSettled([
      skillApiV2.readFileTree(item.path),
      skillApiV2.readFileContent(skillMdPath),
    ]).then(([treeResult, contentResult]) => {
      if (!alive) return
      if (treeResult.status === 'fulfilled') {
        setFileTree(treeResult.value)
      } else {
        setFileTree(localSkillFallbackTree(item.path))
      }
      if (contentResult.status === 'fulfilled') {
        setDoc({ content: contentResult.value, loading: false, error: null })
        setFileContent(contentResult.value)
      } else {
        const error = String(contentResult.reason)
        setDoc({ content: '', loading: false, error })
        setFileContent(`无法读取文件：${error}`)
      }
      setFileLoading(false)
    })
    return () => {
      alive = false
    }
  }, [item.path, skillMdPath])

  const loadFile = (path: string) => {
    setActiveFile(path)
    setFileViewMode(isMarkdownPath(path) ? 'preview' : 'source')
    setFileLoading(true)
    skillApiV2
      .readFileContent(path)
      .then((content) => {
        setFileContent(content)
        if (path === skillMdPath) {
          setDoc({ content, loading: false, error: null })
        }
      })
      .catch((e) => {
        setFileContent(`无法读取文件：${e}`)
        if (path === skillMdPath) {
          setDoc({ content: '', loading: false, error: String(e) })
        }
      })
      .finally(() => {
        setFileLoading(false)
      })
  }

  return (
    <div className="sm2__skill-detail sm2__local-skill-detail">
      <div className="sm2__detail-pills">
        <span className={`sm2__tag sm2__tag--${tone}`}>{item.statusLabel}</span>
        <span className="sm2__tag">本地 Agent Skill</span>
        <span className="sm2__tag">{agent.displayName}</span>
        {mode && <span className="sm2__tag">{mode}</span>}
      </div>

      <div className="sm2__subtabs">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            className={`sm2__subtab${tab === entry.id ? ' sm2__subtab--active' : ''}`}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="sm2__detail-overview sm2__detail-overview--reader">
          <section className="sm2__skill-doc">
            <div className="sm2__skill-doc-head">
              <div>
                <span>SKILL.md</span>
                <strong>说明文档</strong>
              </div>
              <small>{item.statusLabel}</small>
            </div>
            <div className="sm2__markdown sm2__markdown--document sm2__markdown--skilldoc selectable">
              {doc.loading ? (
                <div className="sm2__empty sm2__empty--compact">读取说明文档…</div>
              ) : doc.content ? (
                <>
                  <LocalSkillIntro description={docDescription} />
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={localMarkdownComponents}>{stripSkillFrontmatter(doc.content)}</ReactMarkdown>
                </>
              ) : (
                <div className="sm2__empty sm2__empty--compact">{doc.error ? `无法读取说明文档：${doc.error}` : '未找到说明文档'}</div>
              )}
            </div>
          </section>

          <aside className="sm2__skill-aside">
            <section className="sm2__aside-panel">
              <div className="sm2__aside-head">
                <h3>Agent 安装</h3>
                <span>1</span>
              </div>
              <div className="sm2__install-mini-list">
                <div className="sm2__install-mini">
                  <AgentIconBadge iconKey={agent.iconKey} mode={item.actualMode || undefined} size={26} />
                  <div>
                    <strong>{agent.displayName}</strong>
                    <span>{mode ? `${mode} · ${item.statusLabel}` : item.statusLabel}</span>
                  </div>
                </div>
              </div>
            </section>

            <section className="sm2__aside-panel">
              <div className="sm2__aside-head">
                <h3>信息</h3>
              </div>
              <div className="sm2__compact-info">
                <CompactInfoRow label="来源" value={agent.skillsDir || agent.displayName} mono={Boolean(agent.skillsDir)} />
                <CompactInfoRow label="本地目录" value={item.path} mono />
                <CompactInfoRow label="Skill ID" value={item.skillId} />
                {item.hash && <CompactInfoRow label="Hash" value={item.hash} mono short />}
              </div>
            </section>
          </aside>
        </div>
      )}

      {tab === 'files' && (
        <LocalFilesTab
          rootPath={item.path}
          files={fileTree}
          activeFile={activeFile}
          fileContent={fileContent}
          fileLoading={fileLoading}
          viewMode={fileViewMode}
          onViewModeChange={setFileViewMode}
          onSelect={loadFile}
        />
      )}

      {tab === 'source' && (
        <section className="sm2__skill-source">
          <div className="sm2__skill-source-grid">
            <div className="sm2__skill-source-card">
              <span>类型</span>
              <strong>本地 Agent Skill</strong>
            </div>
            <div className="sm2__skill-source-card">
              <span>导入 Agent</span>
              <strong>{agent.displayName}</strong>
            </div>
            <div className="sm2__skill-source-card">
              <span>接管</span>
              <strong>{canBatchAdopt(item) ? '可接管' : '不可接管'}</strong>
            </div>
            <div className="sm2__skill-source-card">
              <span>状态</span>
              <strong>{item.statusLabel}</strong>
            </div>
          </div>
          <div className="sm2__skill-source-stack">
            <div className="sm2__skill-source-card sm2__skill-source-card--wide">
              <span>本地路径</span>
              <code title={item.path}>{item.path}</code>
            </div>
            {agent.skillsDir && (
              <div className="sm2__skill-source-card sm2__skill-source-card--wide">
                <span>Agent Skills 目录</span>
                <code title={agent.skillsDir}>{agent.skillsDir}</code>
              </div>
            )}
            {reason && (
              <div className="sm2__skill-source-card sm2__skill-source-card--wide">
                <span>说明</span>
                <code title={reason}>{reason}</code>
              </div>
            )}
            {item.hash && (
              <div className="sm2__skill-source-card sm2__skill-source-card--wide">
                <span>Hash</span>
                <code title={item.hash}>{item.hash}</code>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  )
}

function LocalFilesTab({
  rootPath,
  files,
  activeFile,
  fileContent,
  fileLoading,
  viewMode,
  onViewModeChange,
  onSelect,
}: {
  rootPath: string
  files: FileTreeNode | null
  activeFile: string | null
  fileContent: string
  fileLoading: boolean
  viewMode: FileViewMode
  onViewModeChange: (mode: FileViewMode) => void
  onSelect: (path: string) => void
}) {
  const canPreview = Boolean(activeFile && isMarkdownPath(activeFile))
  const effectiveMode = canPreview ? viewMode : 'source'
  const activeName = activeFile ? pathBasename(activeFile) || activeFile : '未选择文件'
  const activeDisplayPath = activeFile ? relativeFilePath(activeFile, rootPath) : '选择左侧文件查看内容'
  const fileCount = countFiles(files)
  return (
    <section className="sm2__panel sm2__panel--flush">
      <div className="sm2__panel-head sm2__panel-head--filebrowser">
        <div>
          <h3>目录与文件</h3>
          <span>{activeFile ? activeDisplayPath : '选择文件后查看内容'}</span>
        </div>
        <strong>{fileCount} 个文件</strong>
      </div>
      <div className="sm2__filebrowser sm2__filebrowser--expansive">
        <div className="sm2__filetree-pane">
          <div className="sm2__filetree-head">
            <span>目录</span>
            <strong>{fileCount}</strong>
          </div>
          <div className="sm2__filetree settings-scroll">
            {files ? (
              <LocalFileTree node={files} depth={0} active={activeFile} onSelect={onSelect} />
            ) : (
              <div className="sm2__empty sm2__empty--compact">读取目录…</div>
            )}
          </div>
        </div>
        <div className="sm2__fileview">
          <div className="sm2__fileview-header">
            <div className="sm2__fileview-title">
              <strong>{activeName}</strong>
              <span>{activeDisplayPath}</span>
            </div>
            <div className="sm2__filemode-toggle">
              <button
                className={effectiveMode === 'preview' ? 'active' : ''}
                disabled={!canPreview}
                onClick={() => onViewModeChange('preview')}
              >
                预览
              </button>
              <button
                className={effectiveMode === 'source' ? 'active' : ''}
                onClick={() => onViewModeChange('source')}
              >
                源码
              </button>
            </div>
          </div>
          <div className="sm2__filecontent settings-scroll">
            {fileLoading ? (
              <div className="sm2__empty sm2__empty--compact">加载中…</div>
            ) : effectiveMode === 'preview' && canPreview ? (
              <div className={`sm2__markdown sm2__markdown--file selectable${isSkillMarkdownPath(activeFile) ? ' sm2__markdown--file-skill' : ''}`}>
                {isSkillMarkdownPath(activeFile) && (
                  <LocalSkillIntro description={extractSkillDescription(fileContent)} compact />
                )}
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={localMarkdownComponents}>{stripSkillFrontmatter(fileContent || '（空）')}</ReactMarkdown>
              </div>
            ) : (
              <pre className="sm2__fileview-content selectable">{fileContent || '（空）'}</pre>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

function LocalFileTree({
  node,
  depth,
  active,
  onSelect,
}: {
  node: FileTreeNode
  depth: number
  active: string | null
  onSelect: (path: string) => void
}) {
  const [expanded, setExpanded] = useState(depth < 1)
  const isDir = node.nodeType === 'dir'
  const activeDescendant = Boolean(active && isDir && node.children?.some((child) => nodeContainsPath(child, active)))
  const isActive = active === node.path
  return (
    <div className={`sm2__filetree-node${isDir ? ' sm2__filetree-node--dir' : ' sm2__filetree-node--file'}`}>
      <button
        type="button"
        className={`sm2__filetree-row${isActive ? ' sm2__filetree-row--active' : ''}${activeDescendant ? ' sm2__filetree-row--contains-active' : ''}${isDir ? ' sm2__filetree-row--branch' : ''}`}
        style={{ paddingLeft: 10 + depth * 16 }}
        onClick={() => {
          if (isDir) setExpanded((value) => !value)
          else onSelect(node.path)
        }}
      >
        <span className="sm2__filetree-caret">{isDir ? (expanded ? '⌄' : '›') : ''}</span>
        <span className="sm2__filetree-icon">{isDir ? '▣' : '▪'}</span>
        <span className="sm2__filetree-name">{node.name || node.path}</span>
      </button>
      {isDir && expanded && node.children && (
        <div className="sm2__filetree-children">
          {node.children.map((child) => (
            <LocalFileTree key={child.path} node={child} depth={depth + 1} active={active} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  )
}

const localMarkdownComponents = {
  a: LocalMarkdownLink,
}

function LocalSkillIntro({ description, compact = false }: { description?: string; compact?: boolean }) {
  const text = description?.trim()
  if (!text) return null
  return (
    <div className={`sm2__skill-frontmatter${compact ? ' sm2__skill-frontmatter--compact' : ''}`}>
      <span>说明</span>
      <p>{text}</p>
    </div>
  )
}

function CompactInfoRow({
  label,
  value,
  mono = false,
  short = false,
}: {
  label: string
  value: string
  mono?: boolean
  short?: boolean
}) {
  const display = short && value.length > 12 ? value.slice(0, 12) : value
  return (
    <div className="sm2__compact-row">
      <span>{label}</span>
      {mono ? <code title={value}>{display}</code> : <strong title={value}>{display}</strong>}
    </div>
  )
}

function LocalMarkdownLink({ href, children, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (event.defaultPrevented || !href || href.startsWith('#')) return
    event.preventDefault()
    openExternal(href)
  }

  return (
    <a {...props} href={href} target="_blank" rel="noreferrer" onClick={handleClick}>
      {children}
    </a>
  )
}

function countFiles(node: FileTreeNode | null): number {
  if (!node) return 0
  if (node.nodeType === 'file') return 1
  return node.children?.reduce((sum, child) => sum + countFiles(child), 0) || 0
}

function pathBasename(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).pop() || ''
}

function relativeFilePath(path: string, root: string): string {
  const normalizedPath = path.replace(/\\/g, '/')
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalizedPath === normalizedRoot) return pathBasename(path) || path
  const prefix = `${normalizedRoot}/`
  if (normalizedPath.startsWith(prefix)) return normalizedPath.slice(prefix.length)
  return normalizedPath
}

function isMarkdownPath(path: string | null): boolean {
  return Boolean(path && /\.(md|mdx|markdown)$/i.test(path))
}

function isSkillMarkdownPath(path: string | null): boolean {
  return Boolean(path && /(^|\/)SKILL\.md$/i.test(path))
}

function nodeContainsPath(node: FileTreeNode, path: string): boolean {
  if (node.path === path) return true
  return Boolean(node.children?.some((child) => nodeContainsPath(child, path)))
}

function localSkillFallbackTree(skillPath: string): FileTreeNode {
  return {
    name: pathBasename(skillPath) || 'skill',
    nodeType: 'dir',
    path: skillPath,
    children: [
      {
        name: 'SKILL.md',
        nodeType: 'file',
        path: `${skillPath}/SKILL.md`,
        children: null,
      },
    ],
  }
}

function importKey(item: AgentSkillInventoryItem) {
  return `${item.agentId}:${item.id}`
}

// ── Local ────────────────────────────────────────────────────────

export function LocalPanel({ onDone }: { onDone: InstallDoneHandler }) {
  const [sourcePath, setSourcePath] = useState('')
  const [importMode, setImportMode] = useState<LocalImportMode>('copy')
  const [preview, setPreview] = useState<AddCenterSkillPreview | null>(null)
  const [localViewMode, setLocalViewMode] = useState<LocalPreviewViewMode>('cards')
  const [renames, setRenames] = useState<Record<string, string>>({})
  const [conflictResolutions, setConflictResolutions] = useState<Record<string, LocalConflictResolution>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const chooseFolder = async () => {
    const dir = await open({ directory: true, multiple: false })
    if (typeof dir === 'string') setSourcePath(dir)
  }
  const chooseZip = async () => {
    const f = await open({ filters: [{ name: '压缩包', extensions: ['zip'] }], multiple: false })
    if (typeof f === 'string') setSourcePath(f)
  }

  const sourceType = sourcePath.trim().toLowerCase().endsWith('.zip') ? 'archive' : 'local_folder'
  const effectiveImportMode: LocalImportMode = sourceType === 'archive' ? 'copy' : importMode
  const sourceUri = sourceType === 'local_folder' ? sourcePath : undefined
  const addInput: AddCenterSkillInput = {
    sourcePath,
    sourceType,
    sourceUri,
    importMode: effectiveImportMode,
  }

  const runPreview = async () => {
    if (!sourcePath) {
      setError('请先选择来源')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const p = await skillApiV2.previewAddCenterSkill(addInput)
      setPreview(p)
      setConflictResolutions(Object.fromEntries(p.blockers.map((b) => [b.skillId, 'rename'])))
      setRenames({})
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const execute = async () => {
    if (!preview) return
    setBusy(true)
    setError(null)
    try {
      const decisions: AddCenterSkillDecision[] = preview.blockers.map((b) => {
        const resolution = conflictResolutions[b.skillId] || 'rename'
        if (resolution === 'overwrite') return { skillId: b.skillId, resolution: 'update' }
        if (resolution === 'skip') return { skillId: b.skillId, resolution: 'skip' }
        const renamed = renames[b.skillId]?.trim()
        return renamed
          ? { skillId: b.skillId, proposedSkillId: renamed, resolution: 'create' }
          : { skillId: b.skillId, resolution: 'skip' }
      })
      const r = await skillApiV2.executeAddCenterSkill(addInput, decisions)
      alert(`导入完成：新增 ${r.skillIds.length}，更新 ${r.updated.length}，跳过 ${r.skipped.length}`)
      onDone()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  if (preview) {
    const totalChanges = preview.candidates.length + preview.blockers.length
    const createCount = preview.candidates.filter((candidate) => candidate.action === 'create').length
    const updateCount = preview.candidates.filter((candidate) => candidate.action === 'update').length
    const blockerCount = preview.blockers.length
    const overwriteAll = blockerCount > 0 && preview.blockers.every((b) => (conflictResolutions[b.skillId] || 'rename') === 'overwrite')
    const setConflictResolution = (skillId: string, resolution: LocalConflictResolution) => {
      setConflictResolutions((current) => ({ ...current, [skillId]: resolution }))
    }
    const setAllConflictResolutions = (resolution: LocalConflictResolution) => {
      setConflictResolutions((current) => {
        const next = { ...current }
        for (const blocker of preview.blockers) next[blocker.skillId] = resolution
        return next
      })
    }
    return (
      <div className="sm2__local-preview">
        <div className="sm2__local-preview-head">
          <div>
            <h3 className="sm2__install-h">确认导入预览</h3>
            <p className="sm2__install-sub">
              将导入到中心库：{preview.centerPath || '中心 Skill 库'} · {effectiveImportMode === 'link'
                ? '软链到本地源目录'
                : '复制到中心库'}
            </p>
          </div>
          <div className="sm2__local-preview-actions">
            <div className="sm2__local-preview-stats">
              <span><strong>{createCount}</strong> 新增</span>
              <span><strong>{updateCount}</strong> 更新</span>
              <span><strong>{preview.blockers.length}</strong> 需处理</span>
            </div>
            {blockerCount > 0 && (
              <label className="sm2__local-overwrite-toggle">
                <input
                  type="checkbox"
                  checked={overwriteAll}
                  onChange={(e) => setAllConflictResolutions(e.target.checked ? 'overwrite' : 'rename')}
                />
                <span>覆盖冲突项</span>
              </label>
            )}
            <div className="sm2__view-toggle sm2__view-toggle--soft">
              <button className={localViewMode === 'list' ? 'active' : ''} onClick={() => setLocalViewMode('list')}>列表</button>
              <button className={localViewMode === 'cards' ? 'active' : ''} onClick={() => setLocalViewMode('cards')}>卡片</button>
            </div>
          </div>
        </div>

        {totalChanges === 0 ? (
          <div className="sm2__empty">
            没有检测到新增或变更{preview.unchangedCount ? `，${preview.unchangedCount} 个 Skill 均无需重复导入` : ''}。
          </div>
        ) : localViewMode === 'cards' ? (
          <div className="sm2__local-preview-grid">
            {preview.candidates.map((c) => (
              <LocalCandidateCard key={c.skillId} candidate={c} />
            ))}
            {preview.blockers.map((b) => (
              <LocalBlockerCard
                key={b.skillId}
                blocker={b}
                value={renames[b.skillId] || ''}
                onChange={(value) => setRenames((current) => ({ ...current, [b.skillId]: value }))}
                resolution={conflictResolutions[b.skillId] || 'rename'}
                onResolutionChange={(resolution) => setConflictResolution(b.skillId, resolution)}
              />
            ))}
          </div>
        ) : (
          <div className="sm2__local-preview-list">
            {preview.candidates.map((c) => (
              <LocalCandidateRow key={c.skillId} candidate={c} />
            ))}
            {preview.blockers.map((b) => (
              <LocalBlockerRow
                key={b.skillId}
                blocker={b}
                value={renames[b.skillId] || ''}
                onChange={(value) => setRenames((current) => ({ ...current, [b.skillId]: value }))}
                resolution={conflictResolutions[b.skillId] || 'rename'}
                onResolutionChange={(resolution) => setConflictResolution(b.skillId, resolution)}
              />
            ))}
          </div>
        )}

        {error && <div className="sm2__error" style={{ margin: 0 }}>{error}</div>}
        <div className="sm2__btn-row sm2__local-preview-footer">
          <button className="sm2__btn" onClick={() => { setPreview(null); setConflictResolutions({}) }} disabled={busy}>返回</button>
          <button className="sm2__btn sm2__btn--primary" onClick={execute} disabled={busy || totalChanges === 0}>
            {busy ? '处理中…' : totalChanges === 0 ? '无需导入' : '执行导入'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="sm2__install-form">
      <h3 className="sm2__install-h">从本地导入</h3>
      <p className="sm2__install-sub">
        支持文件夹、压缩包；选择包含多个 Skill 的目录时会自动批量预览。
      </p>

      <div className="sm2__install-options">
        <button className="sm2__install-option" onClick={chooseFolder}>
          <span className="sm2__install-option-icon" aria-hidden="true">📁</span>
          <span className="sm2__install-option-label">选择文件夹</span>
        </button>
        <button className="sm2__install-option" onClick={chooseZip}>
          <span className="sm2__install-option-icon" aria-hidden="true">🗜️</span>
          <span className="sm2__install-option-label">选择压缩包 (.zip)</span>
        </button>
      </div>

      <div className="sm2__field">
        <label htmlFor="local-skill-source-path">来源路径</label>
        <input
          id="local-skill-source-path"
          value={sourcePath}
          onChange={(e) => setSourcePath(e.target.value)}
          placeholder="选择或粘贴包含 SKILL.md 的目录 / .zip"
        />
      </div>

      {sourceType === 'local_folder' && (
        <div className="sm2__local-import-mode" role="radiogroup" aria-label="导入方式">
          <label className={`sm2__local-import-option${effectiveImportMode === 'copy' ? ' sm2__local-import-option--active' : ''}`}>
            <input
              type="radio"
              name="local-import-mode"
              aria-label="复制导入"
              checked={effectiveImportMode === 'copy'}
              onChange={() => setImportMode('copy')}
            />
            <span>
              <strong>复制导入</strong>
              <em>
                把当前文件复制到本机中心库。适合稳定 Skill；之后修改原始目录不会自动同步。
              </em>
            </span>
          </label>
          <label className={`sm2__local-import-option${effectiveImportMode === 'link' ? ' sm2__local-import-option--active' : ''}`}>
            <input
              type="radio"
              name="local-import-mode"
              aria-label="软链导入，本地目录作为源"
              checked={effectiveImportMode === 'link'}
              onChange={() => setImportMode('link')}
            />
            <span>
              <strong>软链导入，本地目录作为源</strong>
              <em>
                中心库链接到这个目录。以后修改本地 Skill 会立即影响中心库；让 Skill 对 Agent
                生效时也选择软连接，Agent 才会实时读到同一份源目录。
              </em>
              <small>
                常见使用场景：本地已有 Skill，并且需要持续修改、调试、立即生效时，选择这个方式更合适。
              </small>
            </span>
          </label>
        </div>
      )}
      <div className="sm2__local-import-note">
        {sourceType === 'archive'
          ? '压缩包会解压后复制导入中心库，不支持软链导入。'
          : effectiveImportMode === 'link'
            ? '请保留这个本地源目录的位置。移动或删除源目录后，中心库和已用软链生效的 Agent 都会变成坏链接。'
            : '复制导入会保留一份中心库副本；后续要同步本地修改，需要重新导入或覆盖中心库。'}
      </div>

      {error && <div className="sm2__error" style={{ margin: 0 }}>{error}</div>}
      <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
        每个 Skill 目录必须包含 SKILL.md。同名不同来源会被阻止并要求选择处理方式。
      </p>
      <div className="sm2__btn-row">
        <button className="sm2__btn sm2__btn--primary" onClick={runPreview} disabled={busy || !sourcePath}>
          {busy ? '处理中…' : '预览导入'}
        </button>
      </div>
    </div>
  )
}

function LocalCandidateCard({ candidate }: { candidate: AddCenterSkillPreview['candidates'][number] }) {
  const tone = localActionTone(candidate.action)
  return (
    <div className={`sm2__local-skill-card sm2__local-skill-card--${tone}`}>
      <div className="sm2__local-skill-card-head">
        <div className="sm2__market-skill-icon">{initials(candidate.name || candidate.skillId)}</div>
        <div className="sm2__local-skill-titleblock">
          <strong>{candidate.name || candidate.skillId}</strong>
          <code>{candidate.skillId} → {candidate.proposedSkillId}</code>
        </div>
        <span className={`sm2__tag sm2__tag--${tone}`}>{localActionLabel(candidate.action)}</span>
      </div>
      {candidate.description && <p className="sm2__local-skill-desc">{candidate.description}</p>}
      <code className="sm2__local-skill-path">{candidate.sourceDir}</code>
    </div>
  )
}

function LocalCandidateRow({ candidate }: { candidate: AddCenterSkillPreview['candidates'][number] }) {
  const tone = localActionTone(candidate.action)
  return (
    <div className={`sm2__local-skill-row sm2__local-skill-row--${tone}`}>
      <div className="sm2__market-skill-icon">{initials(candidate.name || candidate.skillId)}</div>
      <div className="sm2__local-skill-row-main">
        <div className="sm2__local-skill-row-title">
          <strong>{candidate.name || candidate.skillId}</strong>
          <code>{candidate.skillId} → {candidate.proposedSkillId}</code>
        </div>
        <code className="sm2__local-skill-path">{candidate.sourceDir}</code>
      </div>
      <span className={`sm2__tag sm2__tag--${tone}`}>{localActionLabel(candidate.action)}</span>
    </div>
  )
}

function LocalBlockerCard({
  blocker,
  value,
  onChange,
  resolution,
  onResolutionChange,
}: {
  blocker: AddCenterSkillPreview['blockers'][number]
  value: string
  onChange: (value: string) => void
  resolution: LocalConflictResolution
  onResolutionChange: (resolution: LocalConflictResolution) => void
}) {
  return (
    <div className="sm2__local-skill-card sm2__local-skill-card--conflict">
      <div className="sm2__local-skill-card-head">
        <div className="sm2__market-skill-icon">!</div>
        <div className="sm2__local-skill-titleblock">
          <strong>{blocker.name || blocker.skillId}</strong>
          <code>{blocker.skillId}</code>
        </div>
        <span className="sm2__tag sm2__tag--conflict">需处理</span>
      </div>
      <p className="sm2__local-skill-desc">{blocker.reason || '同名 Skill 需要选择处理方式。'}</p>
      <LocalConflictControls
        blocker={blocker}
        value={value}
        onChange={onChange}
        resolution={resolution}
        onResolutionChange={onResolutionChange}
      />
    </div>
  )
}

function LocalBlockerRow({
  blocker,
  value,
  onChange,
  resolution,
  onResolutionChange,
}: {
  blocker: AddCenterSkillPreview['blockers'][number]
  value: string
  onChange: (value: string) => void
  resolution: LocalConflictResolution
  onResolutionChange: (resolution: LocalConflictResolution) => void
}) {
  return (
    <div className="sm2__local-skill-row sm2__local-skill-row--conflict">
      <div className="sm2__market-skill-icon">!</div>
      <div className="sm2__local-skill-row-main">
        <div className="sm2__local-skill-row-title">
          <strong>{blocker.name || blocker.skillId}</strong>
          <span>{blocker.reason || '同名 Skill 需要选择处理方式。'}</span>
        </div>
        <LocalConflictControls
          blocker={blocker}
          value={value}
          onChange={onChange}
          resolution={resolution}
          onResolutionChange={onResolutionChange}
          inline
        />
      </div>
      <span className="sm2__tag sm2__tag--conflict">需处理</span>
    </div>
  )
}

function LocalConflictControls({
  blocker,
  value,
  onChange,
  resolution,
  onResolutionChange,
  inline,
}: {
  blocker: AddCenterSkillPreview['blockers'][number]
  value: string
  onChange: (value: string) => void
  resolution: LocalConflictResolution
  onResolutionChange: (resolution: LocalConflictResolution) => void
  inline?: boolean
}) {
  return (
    <div className={`sm2__local-conflict-controls${inline ? ' sm2__local-conflict-controls--inline' : ''}`}>
      <div className="sm2__local-conflict-modes" role="radiogroup" aria-label={`${blocker.skillId} 处理方式`}>
        <button
          type="button"
          className={resolution === 'overwrite' ? 'active' : ''}
          onClick={() => onResolutionChange('overwrite')}
        >
          覆盖
        </button>
        <button
          type="button"
          className={resolution === 'rename' ? 'active' : ''}
          onClick={() => onResolutionChange('rename')}
        >
          重命名
        </button>
        <button
          type="button"
          className={resolution === 'skip' ? 'active' : ''}
          onClick={() => onResolutionChange('skip')}
        >
          跳过
        </button>
      </div>
      {resolution === 'rename' && (
        <label className={`sm2__local-rename-field${inline ? ' sm2__local-rename-field--inline' : ''}`}>
          <span>重命名为</span>
          <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={`${blocker.skillId}-rename`} />
        </label>
      )}
    </div>
  )
}

function localActionLabel(action: string) {
  if (action === 'update') return '更新'
  if (action === 'create') return '新增'
  return action
}

function localActionTone(action: string) {
  return action === 'update' ? 'ok' : 'unmanaged'
}

// ── Git ──────────────────────────────────────────────────────────

type GitRepoSkill = GitHubRepoPreview['skills'][number]
type GitStage = 'input' | 'select' | 'done'
type ConflictMode = 'rename' | 'overwrite'

interface GitDoneSummary {
  imported: number
  skipped: number
  skills: string[]
}

function buildGitRef(url: string, branch: string): string {
  const trimmedUrl = url.trim().replace(/\/+$/, '')
  const trimmedBranch = branch.trim()
  if (!trimmedBranch || /\/tree\//.test(trimmedUrl)) return trimmedUrl
  return `${trimmedUrl}/tree/${trimmedBranch}`
}

function urlHasSubpath(ref: string): boolean {
  const match = ref.match(/\/tree\/[^/]+\/(.+)$/)
  return Boolean(match && match[1])
}

export function GitPanel({ initialUrl, onDone }: { initialUrl?: string; onDone: InstallDoneHandler }) {
  const [url, setUrl] = useState(initialUrl || '')
  const [branch, setBranch] = useState('')
  const [token, setToken] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('cards')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [stage, setStage] = useState<GitStage>('input')
  const [repo, setRepo] = useState<GitHubRepoPreview | null>(null)
  const [activeRef, setActiveRef] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [conflictMode, setConflictMode] = useState<Record<string, ConflictMode>>({})
  const [renames, setRenames] = useState<Record<string, string>>({})
  const [summary, setSummary] = useState<GitDoneSummary | null>(null)

  const resetToInput = () => {
    setStage('input')
    setRepo(null)
    setSelected(new Set())
    setConflictMode({})
    setRenames({})
    setSummary(null)
    setError(null)
  }

  const buildSelections = (skills: GitRepoSkill[], picked: Set<string>) =>
    skills
      .filter((s) => picked.has(s.sourcePath))
      .map((s) => {
        if (!s.conflict) return { sourcePath: s.sourcePath, resolution: 'overwrite' as const }
        const mode = conflictMode[s.sourcePath] || 'rename'
        if (mode === 'overwrite') return { sourcePath: s.sourcePath, resolution: 'overwrite' as const }
        const renamed = renames[s.sourcePath]?.trim()
        if (!renamed) return { sourcePath: s.sourcePath, resolution: 'skip' as const }
        return { sourcePath: s.sourcePath, resolution: 'rename' as const, renamedSkillId: renamed }
      })

  const importSelections = async (
    ref: string,
    selections: ReturnType<typeof buildSelections>,
    skills: GitRepoSkill[],
    picked: Set<string>,
  ) => {
    const result = await skillApiV2.importGitHubRepoSkills(ref, selections, token)
    await skillApiV2.refresh()
    const importedCount = result.importedSkills.length || selections.filter((s) => s.resolution !== 'skip').length
    const skippedCount = result.skippedSkills.length || selections.filter((s) => s.resolution === 'skip').length
    setSummary({
      imported: importedCount,
      skipped: skippedCount,
      skills: skills.filter((s) => picked.has(s.sourcePath)).map((s) => s.skillName),
    })
    setToken('')
    setStage('done')
    onDone()
  }

  const detect = async () => {
    if (!url.trim()) {
      setError('请输入 Git 仓库 URL')
      return
    }
    const ref = buildGitRef(url, branch)
    setBusy(true)
    setError(null)
    try {
      const preview = await skillApiV2.previewGitHubRepoImport(ref, token)
      if (preview.skills.length === 0) {
        setError('该仓库未检测到任何 Skill（需含 SKILL.md）')
        return
      }
      setActiveRef(ref)
      setRepo(preview)

      const single = preview.skills[0]
      // 具体 skill 路径 + 唯一 + 无冲突 → 直接安装，零额外点击
      if (preview.skills.length === 1 && urlHasSubpath(ref) && !single.conflict) {
        const picked = new Set([single.sourcePath])
        setSelected(picked)
        await importSelections(
          ref,
          [{ sourcePath: single.sourcePath, resolution: 'overwrite' as const }],
          preview.skills,
          picked,
        )
        return
      }

      // 默认勾选无冲突项；冲突项默认不勾选
      setSelected(new Set(preview.skills.filter((s) => !s.conflict).map((s) => s.sourcePath)))
      setConflictMode({})
      setRenames({})
      setStage('select')
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const installSelected = async () => {
    if (!repo) return
    const selections = buildSelections(repo.skills, selected)
    const effective = selections.filter((s) => s.resolution !== 'skip')
    if (effective.length === 0) {
      setError('请至少选择一个可安装的 Skill（冲突项需选择覆盖或填写新名称）')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await importSelections(activeRef, selections, repo.skills, selected)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const toggle = (sourcePath: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(sourcePath)) next.delete(sourcePath)
      else next.add(sourcePath)
      return next
    })
  }

  const renderConflictControls = (s: GitRepoSkill, mode: ConflictMode) => (
    <div className="sm2__git-conflict-ctrl" onClick={(e) => e.stopPropagation()}>
      <div className="sm2__git-conflict-modes">
        <button
          className={mode === 'rename' ? 'active' : ''}
          onClick={() => setConflictMode((m) => ({ ...m, [s.sourcePath]: 'rename' }))}
        >
          重命名
        </button>
        <button
          className={mode === 'overwrite' ? 'active' : ''}
          onClick={() => setConflictMode((m) => ({ ...m, [s.sourcePath]: 'overwrite' }))}
        >
          覆盖
        </button>
      </div>
      {mode === 'rename' && (
        <input
          className="sm2__git-rename-input"
          value={renames[s.sourcePath] || ''}
          onChange={(e) => setRenames((r) => ({ ...r, [s.sourcePath]: e.target.value }))}
          placeholder={`${s.skillId}-copy（留空则跳过）`}
        />
      )}
    </div>
  )

  // ── done ───────────────────────────────────────────────────────
  if (stage === 'done' && summary) {
    return (
      <div className="sm2__git">
        <div className="sm2__git-done">
          <div className="sm2__git-done-icon">✓</div>
          <h3>已导入 {summary.imported} 个 Skill</h3>
          <p>
            导入到中心 Skill 库{summary.skipped > 0 ? `，跳过 ${summary.skipped} 个` : ''}。
            可在「Skill 库」中让 Skill 对各个 Agent 生效。
          </p>
          {summary.skills.length > 0 && (
            <div className="sm2__git-done-chips">
              {summary.skills.map((name) => (
                <span key={name} className="sm2__git-chip">{name}</span>
              ))}
            </div>
          )}
          <div className="sm2__btn-row" style={{ justifyContent: 'center' }}>
            <button className="sm2__btn sm2__btn--primary" onClick={resetToInput}>继续安装</button>
          </div>
        </div>
      </div>
    )
  }

  // ── select ─────────────────────────────────────────────────────
  if (stage === 'select' && repo) {
    const owner = repo.repo.owner
    const total = repo.skills.length
    const selectedCount = repo.skills.filter((s) => selected.has(s.sourcePath)).length
    const allSelected = selectedCount === total && total > 0
    return (
      <div className="sm2__git">
        <div className="sm2__git-manifest">
          <GitOwnerAvatar owner={owner} />
          <div className="sm2__git-manifest-main">
            <div className="sm2__git-manifest-repo">
              <strong>{owner}/{repo.repo.repo}</strong>
              <span className="sm2__git-branch-chip">⑂ {repo.repo.branch}</span>
            </div>
            <span className="sm2__git-manifest-count">
              检测到 <strong>{total}</strong> 个 Skill · 已选 <strong>{selectedCount}</strong>
            </span>
          </div>
          <div className="sm2__git-manifest-actions">
            <div className="sm2__view-toggle sm2__view-toggle--soft">
              <button className={viewMode === 'list' ? 'active' : ''} onClick={() => setViewMode('list')}>列表</button>
              <button className={viewMode === 'cards' ? 'active' : ''} onClick={() => setViewMode('cards')}>卡片</button>
            </div>
            <button
              className="sm2__btn sm2__btn--ghost"
              onClick={() =>
                setSelected(allSelected ? new Set() : new Set(repo.skills.map((s) => s.sourcePath)))
              }
            >
              {allSelected ? '全不选' : '全选'}
            </button>
          </div>
        </div>

        {viewMode === 'cards' ? (
          <div className="sm2__git-skill-grid">
            {repo.skills.map((s) => {
              const checked = selected.has(s.sourcePath)
              const mode = conflictMode[s.sourcePath] || 'rename'
              return (
                <div
                  key={s.sourcePath}
                  className={`sm2__git-skill-card${checked ? ' sm2__git-skill-card--on' : ''}${s.conflict ? ' sm2__git-skill-card--conflict' : ''}`}
                >
                  <div className="sm2__git-skill-card-head">
                    <label className="sm2__git-skill-check" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={checked} onChange={() => toggle(s.sourcePath)} />
                    </label>
                    <div className="sm2__git-skill-main" onClick={() => toggle(s.sourcePath)}>
                      <div className="sm2__git-skill-titleline">
                        <strong>{s.skillName}</strong>
                        {s.conflict && <span className="sm2__tag sm2__tag--conflict">中心库已存在</span>}
                      </div>
                      {s.description && <p className="sm2__git-skill-desc">{s.description}</p>}
                      <code className="sm2__git-skill-path">{s.sourcePath || repo.repo.repo}</code>
                    </div>
                  </div>
                  {checked && s.conflict && renderConflictControls(s, mode)}
                </div>
              )
            })}
          </div>
        ) : (
          <div className="sm2__git-skill-list">
            {repo.skills.map((s) => {
              const checked = selected.has(s.sourcePath)
              const mode = conflictMode[s.sourcePath] || 'rename'
              return (
                <div
                  key={s.sourcePath}
                  className={`sm2__git-skill-row${checked ? ' sm2__git-skill-row--on' : ''}${s.conflict ? ' sm2__git-skill-row--conflict' : ''}`}
                >
                  <label className="sm2__git-skill-check">
                    <input type="checkbox" checked={checked} onChange={() => toggle(s.sourcePath)} />
                  </label>
                  <div className="sm2__git-skill-main" onClick={() => toggle(s.sourcePath)}>
                    <div className="sm2__git-skill-titleline">
                      <strong>{s.skillName}</strong>
                      {s.conflict && <span className="sm2__tag sm2__tag--conflict">中心库已存在</span>}
                    </div>
                    {s.description && <p className="sm2__git-skill-desc">{s.description}</p>}
                    <code className="sm2__git-skill-path">{s.sourcePath || repo.repo.repo}</code>
                  </div>
                  {checked && s.conflict && renderConflictControls(s, mode)}
                </div>
              )
            })}
          </div>
        )}

        {error && <div className="sm2__error" style={{ margin: 0 }}>{error}</div>}
        <div className="sm2__git-footer">
          <button className="sm2__btn sm2__btn--ghost" onClick={resetToInput} disabled={busy}>← 重新输入</button>
          <button className="sm2__btn sm2__btn--primary" onClick={installSelected} disabled={busy || selectedCount === 0}>
            {busy ? '安装中…' : `安装所选 (${selectedCount})`}
          </button>
        </div>
      </div>
    )
  }

  // ── input ──────────────────────────────────────────────────────
  return (
    <div className="sm2__git">
      <div className="sm2__git-intro">
        <h3 className="sm2__install-h">从 Git 仓库导入 Skill</h3>
        <p className="sm2__install-sub">
          粘贴仓库地址检测其中的 Skill。给整个仓库会列出全部供你勾选；给具体 Skill 路径
          （如 <code>.../tree/main/skills/pdf</code>）则直接安装。
        </p>
      </div>

      <div className="sm2__git-input-card">
        <div className="sm2__git-url-field">
          <span className="sm2__git-url-icon">⑂</span>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/anthropics/skills/tree/main"
            onKeyDown={(e) => e.key === 'Enter' && !busy && detect()}
          />
        </div>
        <div className="sm2__git-input-row">
          <label className="sm2__git-branch-field">
            <span>分支</span>
            <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" />
          </label>
          <button
            className="sm2__git-advanced-toggle"
            onClick={() => setShowAdvanced((v) => !v)}
            type="button"
          >
            {showAdvanced ? '收起高级' : '高级（私有仓库令牌）'}
          </button>
        </div>
        {showAdvanced && (
          <label className="sm2__git-token-field">
            <span>访问令牌</span>
            <input value={token} onChange={(e) => setToken(e.target.value)} type="password" placeholder="ghp_..." />
          </label>
        )}
      </div>

      {error && <div className="sm2__error" style={{ margin: 0 }}>{error}</div>}
      <div className="sm2__btn-row">
        <button className="sm2__btn sm2__btn--primary" onClick={detect} disabled={busy}>
          {busy ? '检测中…' : '检测 Skill'}
        </button>
      </div>
    </div>
  )
}

function GitOwnerAvatar({ owner }: { owner: string }) {
  const [failed, setFailed] = useState(false)
  if (!owner || failed) {
    return <div className="sm2__market-skill-icon">{initials(owner || 'git')}</div>
  }
  return (
    <img
      src={`https://github.com/${owner}.png?size=80`}
      alt={owner}
      className="sm2__market-avatar"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  )
}
