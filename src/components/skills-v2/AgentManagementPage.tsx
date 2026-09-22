import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { open } from '@tauri-apps/plugin-dialog'
import { useSkillStoreV2 } from '../../stores/skillStoreV2'
import { skillApiV2 } from '../../services/skillApiV2'
import { agentApi, type AgentOutputEvent, type AgentProgramInfo, type CustomAgentConfig } from '../../services/agentApi'
import type { AgentDetail, AdoptPreview, ConflictBlocker, DistributionPreview, SkillSummary, UnmanagedItemDto } from '../../services/skillApiV2'
import { useSessionStore } from '../../stores/sessionStore'
import { AgentIconBadge } from './AgentIconBadge'
import { AdoptDialog } from './AdoptDialog'
import { PreviewDialog } from './PreviewDialog'
import { SkillDetailSlider, type SkillDetailFallback } from './SkillDetailSlider'
import { distributionBlockerReason, isAdoptOptionUnavailableError, skillErrorMessage, skillModeLabel, skillSourceTypeLabel, skillStatusLabel, targetClaimLabel, unmanagedReasonLabel } from './skillLabels'
import { buildAgentUsageScores, readStoredAgentOrder, sortAgentSummaries } from '../../utils/agentOrdering'

// The Agent view now only shows which Skills are in effect for it; the tab id
// stays so the section keeps its label, count and test hook.
type DetailTab = 'skills'
type AgentSkillViewMode = 'cards' | 'list'
type AgentSkillSource = 'agent' | 'shared'
type AgentSkillStatus = 'managed' | 'unmanaged' | 'builtin'
type AgentLibraryScope = 'uninstalled' | 'installed' | 'all'
type InstallBlockerDecision = 'overwrite' | 'skip'
type AdoptDialogState = {
  preview: AdoptPreview
  runtimeEnvironmentId: string
}

const PAGE_SIZE = 28
const SHARED_SKILLS_AGENT_ID = 'agents'
const NOTICE_DISMISS_MS = 3200
const AGENT_DETECTION_LABELS = {
  installed: '已安装',
  updateAvailable: '可更新',
  configOnly: '仅发现配置',
  notInstalled: '未安装',
  unavailable: '不可用',
  undetected: '未检测到',
} as const

const AGENT_DETECTION_CLASSES = {
  installed: 'installed',
  updateAvailable: 'update-available',
  configOnly: 'config-only',
  notInstalled: 'not-installed',
  unavailable: 'unavailable',
  undetected: 'undetected',
} as const

type AgentDetectionStatus = keyof typeof AGENT_DETECTION_LABELS

interface AgentInventoryEntry {
  id: string
  displayName: string
  iconKey: string
  installed: boolean
  status: AgentDetectionStatus
  programDetected: boolean
  detectedByInventory: boolean
  version: string | null
  hooksInstalled: boolean
  managedSkillCount: number
  unmanagedSkillCount: number
}

// 技能库存（skills/配置文件）只能证明本机发现过该 Agent 的配置；程序是否真的
// 安装以 agent_refresh 的二进制/应用检测为准。installed 必须来自程序检测，
// 库存命中只用于区分「仅发现配置/Skills」，绝不把库存当成程序已安装。
function agentDetection(
  program: AgentProgramInfo | null | undefined,
  detectedByInventory: boolean,
): { status: AgentDetectionStatus; installed: boolean } {
  if (program?.status === 'updateAvailable') {
    return { status: 'updateAvailable', installed: true }
  }
  if (program?.status === 'installed') {
    return { status: 'installed', installed: true }
  }
  if (detectedByInventory) {
    return { status: 'configOnly', installed: false }
  }
  if (program?.status === 'unavailable') {
    return { status: 'unavailable', installed: false }
  }
  return { status: program ? 'notInstalled' : 'undetected', installed: false }
}

function inventoryMetaLabel(agent: AgentInventoryEntry): string {
  const skillCount = agent.managedSkillCount + agent.unmanagedSkillCount
  if (agent.installed) {
    return skillCount > 0 ? `Skills ${skillCount}` : '暂未发现 Skill'
  }
  if (agent.status === 'configOnly') {
    return skillCount > 0 ? `发现 Skills ${skillCount}` : '仅发现配置'
  }
  if (agent.status === 'unavailable') {
    return '本机未安装，且没有可用的安装方式'
  }
  if (agent.status === 'notInstalled') {
    return '程序未安装'
  }
  return '未检测到本机程序'
}

function assertRuntimeEnvironment(expectedId: string, message: string) {
  if (useSkillStoreV2.getState().runtimeEnvironmentId !== expectedId) {
    throw new Error(message)
  }
}

export function AgentManagementPage() {
  const { t } = useTranslation()
  const state = useSkillStoreV2()
  const allSessions = useSessionStore((s) => s.sessionList)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const sessionList = allSessions
  const agentUsageScores = useMemo(() => buildAgentUsageScores(sessionList, activeSessionId), [sessionList, activeSessionId])
  const agents = useMemo(() => sortAgentSummaries(
    state.agents.filter((agent) => agent.id !== SHARED_SKILLS_AGENT_ID),
    { manualOrder: readStoredAgentOrder(), usageScores: agentUsageScores },
  ), [agentUsageScores, state.agents])
  const detail = state.selectedAgentDetail?.id === SHARED_SKILLS_AGENT_ID ? null : state.selectedAgentDetail
  const [tab, setTab] = useState<DetailTab>('skills')
  const [showOtherAgents, setShowOtherAgents] = useState(false)
  const [adopt, setAdopt] = useState<AdoptDialogState | null>(null)
  const [detailSkillId, setDetailSkillId] = useState<string | null>(null)
  const [detailFallback, setDetailFallback] = useState<SkillDetailFallback | null>(null)
  const [busy, setBusy] = useState(false)
  const [refreshingOverview, setRefreshingOverview] = useState(false)
  const [refreshingAll, setRefreshingAll] = useState(false)
  const [scanningAgentId, setScanningAgentId] = useState<string | null>(null)
  const [uninstallingAgentId, setUninstallingAgentId] = useState<string | null>(null)
  const [adoptingUnmanagedId, setAdoptingUnmanagedId] = useState<string | null>(null)
  const [programs, setPrograms] = useState<Record<string, AgentProgramInfo>>({})
  const [programLoading, setProgramLoading] = useState(false)
  const [agentOutput, setAgentOutput] = useState<string[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [customDialogOpen, setCustomDialogOpen] = useState(false)
  const [uninstallAgentTarget, setUninstallAgentTarget] = useState<AgentDetail | null>(null)
  const [deleteAgentTarget, setDeleteAgentTarget] = useState<AgentDetail | null>(null)
  const [deletingAgentId, setDeletingAgentId] = useState<string | null>(null)
  const selectedAgentIdRef = useRef<string | null>(null)
  const actionBusy = busy || refreshingOverview || refreshingAll || scanningAgentId !== null || uninstallingAgentId !== null || deletingAgentId !== null
  const inventory = useMemo<AgentInventoryEntry[]>(() => (
    agents.map((agent) => {
      const program = programs[agent.id] ?? null
      const detection = agentDetection(program, agent.installed)
      return {
        id: agent.id,
        displayName: agent.displayName,
        iconKey: agent.iconKey,
        installed: detection.installed,
        status: detection.status,
        programDetected: program !== null,
        detectedByInventory: agent.installed,
        version: program?.installedVersion ?? agent.version,
        hooksInstalled: Boolean(program?.hooksInstalled),
        managedSkillCount: agent.managedSkillCount,
        unmanagedSkillCount: agent.unmanagedSkillCount,
      }
    }).sort((a, b) => Number(b.installed) - Number(a.installed))
  ), [agents, programs])
  const programInfoLoaded = Object.keys(programs).length > 0
  // 默认只显示检测到可执行程序（或应用）的 Agent；其余收在「+」后面。程序信息
  // 尚未取到时不做过滤，避免把已安装的 Agent 误藏起来。
  const detectedInventory = useMemo(() => inventory.filter((agent) => agent.installed), [inventory])
  const hiddenInventory = useMemo(() => inventory.filter((agent) => !agent.installed), [inventory])
  const visibleInventory = showOtherAgents || !programInfoLoaded ? inventory : detectedInventory
  const installedProgramCount = detectedInventory.length
  const configOnlyCount = inventory.filter((agent) => agent.status === 'configOnly').length

  const loadPrograms = useCallback(async () => {
    setProgramLoading(true)
    try {
      const next = await agentApi.list()
      setPrograms(Object.fromEntries(next.map((agent) => [agent.id, agent])))
    } catch (e) {
      state.setError(skillErrorMessage(t, e))
    } finally {
      setProgramLoading(false)
    }
  }, [state, t])

  useEffect(() => {
    state.loadOverview()
    loadPrograms()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (state.customAgentDialogRequest <= 0) return
    setCustomDialogOpen(true)
    useSkillStoreV2.setState({ customAgentDialogRequest: 0 })
  }, [state.customAgentDialogRequest])

  useEffect(() => {
    selectedAgentIdRef.current = state.selectedAgentId
  }, [state.selectedAgentId])

  useEffect(() => {
    let unlisten: (() => void) | null = null
    let alive = true
    agentApi.onOutput((event) => {
      if (event.agentId !== selectedAgentIdRef.current) return
      setAgentOutput((prev) => [...prev, formatAgentOutput(event)].slice(-10))
    }).then((next) => {
      if (alive) unlisten = next
      else next()
    }).catch(() => {
      // Output streaming is best-effort; the awaited install/update command
      // still reports failure through the action itself.
    })
    return () => {
      alive = false
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    if (inventory.length === 0) {
      if (state.selectedAgentId === SHARED_SKILLS_AGENT_ID) state.selectAgent(null)
      return
    }
    if (state.selectedAgentId && inventory.some((agent) => agent.id === state.selectedAgentId)) return
    const first = programInfoLoaded
      ? detectedInventory[0] ?? inventory[0]
      : inventory.find((agent) => agent.installed) || inventory[0]
    if (first) state.selectAgent(first.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inventory, programInfoLoaded, state.selectedAgentId])

  useEffect(() => {
    setTab('skills')
    setNotice(null)
    setAgentOutput([])
  }, [state.selectedAgentId])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), NOTICE_DISMISS_MS)
    return () => window.clearTimeout(timer)
  }, [notice])

  const openAdopt = async (agentId: string, unmanagedId: string) => {
    const previewRuntimeEnvironmentId = useSkillStoreV2.getState().runtimeEnvironmentId
    setAdoptingUnmanagedId(unmanagedId)
    setBusy(true)
    try {
      assertRuntimeEnvironment(
        previewRuntimeEnvironmentId,
        '运行环境已切换，已忽略原环境的接管预览；请在当前环境重新扫描。',
      )
      const p = await skillApiV2.previewAdopt(agentId, unmanagedId)
      assertRuntimeEnvironment(
        previewRuntimeEnvironmentId,
        '运行环境已切换，已忽略原环境的接管预览；请在当前环境重新扫描。',
      )
      setAdopt({
        preview: p,
        runtimeEnvironmentId: previewRuntimeEnvironmentId,
      })
    } catch (e) {
      state.setError(String(e))
    } finally {
      setAdoptingUnmanagedId(null)
      setBusy(false)
    }
  }

  const scanAgent = async (agentId: string) => {
    setScanningAgentId(agentId)
    setNotice(null)
    state.setError(null)
    try {
      const result = await skillApiV2.scanAgentInventory(agentId)
      const unmanaged = await skillApiV2.listUnmanaged()
      useSkillStoreV2.setState({ unmanaged })
      await state.loadAgentDetail(agentId, true)
      await state.loadOverview(true)
      const readOnlyCount = result.readOnly ?? 0
      const sharedReadOnlyCount = result.sharedReadOnly ?? 0
      setNotice(t(
        result.includedShared
          ? readOnlyCount > 0 || sharedReadOnlyCount > 0
            ? 'skills.agentManagement.scanCompleteSharedReadOnly'
            : 'skills.agentManagement.scanCompleteShared'
          : readOnlyCount > 0
          ? 'skills.agentManagement.scanCompleteReadOnly'
          : 'skills.agentManagement.scanComplete',
        {
          managed: result.managed,
          unmanaged: result.unmanaged,
          readOnly: readOnlyCount,
          sharedManaged: result.sharedManaged ?? 0,
          sharedUnmanaged: result.sharedUnmanaged ?? 0,
          sharedReadOnly: sharedReadOnlyCount,
        },
      ))
    } catch (e) {
      state.setError(String(e))
    } finally {
      setScanningAgentId(null)
    }
  }

  const uninstallAgent = async (agent: AgentDetail) => {
    setUninstallingAgentId(agent.id)
    setNotice(null)
    state.setError(null)
    setAgentOutput([])
    const failures: string[] = []
    let removedSkills = 0
    try {
      const program = programs[agent.id]
      const programInstalled = program?.status === 'installed' || program?.status === 'updateAvailable'
      if (programInstalled && program.uninstallCommand) {
        try {
          await agentApi.uninstall(agent.id)
        } catch (error) {
          failures.push(`程序：${skillErrorMessage(t, error)}`)
        }
      }

      const targetIds = agent.skills.map((skill) => skill.id)
      if (targetIds.length > 0) {
        try {
          const result = await skillApiV2.deleteSkillTargetDistributions(targetIds)
          removedSkills += result.deleted
          failures.push(...result.failures.map((failure) => `Skill：${failure.error}`))
        } catch (error) {
          failures.push(`已管理 Skills：${skillErrorMessage(t, error)}`)
        }
      }

      const unmanagedItems = useSkillStoreV2.getState().unmanaged
        .filter((item) => item.agentId === agent.id && !isReadOnlyUnmanaged(item) && (item.itemType === 'agent_skill' || item.itemType === 'skill'))
      for (const item of unmanagedItems) {
        try {
          await skillApiV2.deleteUnmanagedAgentSkill(agent.id, item.id)
          removedSkills += 1
        } catch (error) {
          failures.push(`${item.inferredSkillId || item.path}：${skillErrorMessage(t, error)}`)
        }
      }

      if (program?.hooksInstalled) {
        try {
          await agentApi.uninstallHook(agent.id)
        } catch (error) {
          failures.push(`Hook：${skillErrorMessage(t, error)}`)
        }
      }

      const remainingUnmanaged = await skillApiV2.listUnmanaged()
      useSkillStoreV2.setState({ unmanaged: remainingUnmanaged })
      setUninstallAgentTarget(null)
      await Promise.all([loadPrograms(), state.loadOverview(true)])
      if (failures.length > 0) {
        if (useSkillStoreV2.getState().selectedAgentId === agent.id) {
          await state.loadAgentDetail(agent.id, true)
        }
        state.setError(`部分卸载失败：${failures.slice(0, 3).join('；')}`)
      } else {
        const programRemoved = !programInstalled || Boolean(program?.uninstallCommand)
        if (programRemoved) {
          const current = useSkillStoreV2.getState()
          const nextAgents = current.agents.map((item) => item.id === agent.id
            ? {
                ...item,
                enabled: false,
                installed: false,
                version: null,
                managedSkillCount: 0,
                unmanagedSkillCount: 0,
              }
            : item)
          useSkillStoreV2.setState({ agents: nextAgents })
          if (current.selectedAgentId === agent.id) {
            const nextAgent = nextAgents.find((item) => item.installed && item.id !== SHARED_SKILLS_AGENT_ID)
            await state.selectAgent(nextAgent?.id ?? null)
          }
        }
        const cleanup = removedSkills > 0 ? `，已清理 ${removedSkills} 个 Skills` : ''
        setNotice(`Agent「${agent.displayName}」已卸载${cleanup}`)
      }
    } catch (e) {
      state.setError(`卸载失败：${skillErrorMessage(t, e)}`)
    } finally {
      setUninstallingAgentId(null)
    }
  }

  const refreshAll = async () => {
    setRefreshingAll(true)
    setNotice(null)
    state.setError(null)
    try {
      await Promise.all([state.loadOverview(true), loadPrograms()])
      if (state.selectedAgentId && state.selectedAgentId !== SHARED_SKILLS_AGENT_ID) {
        await state.loadAgentDetail(state.selectedAgentId, true)
      }
    } finally {
      setRefreshingAll(false)
    }
  }

  const refreshOverview = async () => {
    setRefreshingOverview(true)
    setNotice(null)
    state.setError(null)
    try {
      await Promise.all([state.refresh(), loadPrograms()])
    } finally {
      setRefreshingOverview(false)
    }
  }

  const openSkillDetail = (skillId: string, fallback?: SkillDetailFallback | null) => {
    setDetailSkillId(skillId)
    setDetailFallback(fallback || null)
  }

  const addCustomAgent = async (config: CustomAgentConfig) => {
    setBusy(true)
    setNotice(null)
    state.setError(null)
    try {
      const added = await agentApi.addCustom(config)
      await Promise.all([state.loadOverview(true), loadPrograms()])
      if (useSkillStoreV2.getState().agents.some((agent) => agent.id === added.id)) {
        await state.selectAgent(added.id)
      }
      setCustomDialogOpen(false)
      setNotice(config.category === 'claude-compatible'
        ? 'Claude Code 实例已添加，Hook 已安装'
        : '自定义 Agent 已添加')
    } catch (e) {
      state.setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const deleteCustomAgent = async (agent: AgentDetail) => {
    setDeletingAgentId(agent.id)
    setNotice(null)
    state.setError(null)
    try {
      await agentApi.removeCustom(agent.id)
      useSkillStoreV2.setState((current) => ({
        agents: current.agents.filter((item) => item.id !== agent.id),
      }))
      setDeleteAgentTarget(null)
      await state.selectAgent(null)
      await Promise.all([state.loadOverview(true), loadPrograms()])
      setNotice(`已删除自定义 Agent「${agent.displayName}」`)
    } catch (e) {
      state.setError(String(e))
    } finally {
      setDeletingAgentId(null)
    }
  }

  const selectedProgram = detail ? programs[detail.id] ?? null : null
  const selectedProgramInstalled = selectedProgram?.status === 'installed' || selectedProgram?.status === 'updateAvailable'
  const selectedUnmanagedItems = detail
    ? state.unmanaged.filter((item) => item.agentId === detail.id && (item.itemType === 'agent_skill' || item.itemType === 'skill'))
    : []
  const selectedHasResiduals = Boolean(detail && (
    detail.skills.length > 0
    || selectedUnmanagedItems.length > 0
    || selectedProgram?.hooksInstalled
  ))
  const canUninstallSelectedAgent = Boolean(
    selectedProgram
    && !selectedProgram.isCustom
    && ((selectedProgramInstalled && selectedProgram?.uninstallCommand) || selectedHasResiduals),
  )
  const uninstallProgram = uninstallAgentTarget ? programs[uninstallAgentTarget.id] ?? null : null
  const uninstallProgramInstalled = uninstallProgram?.status === 'installed' || uninstallProgram?.status === 'updateAvailable'
  const uninstallUnmanagedItems = uninstallAgentTarget
    ? state.unmanaged.filter((item) => item.agentId === uninstallAgentTarget.id && (item.itemType === 'agent_skill' || item.itemType === 'skill'))
    : []

  return (
    <div className="sm2 sm2--agents">
      <div className="sm2__header sm2__header--stacked">
        <div>
          <h2 className="sm2__title">Agent 管理</h2>
          <p className="sm2__header-subtitle">查看每个 Agent 上生效了哪些 Skill，并处理接管与移除。</p>
        </div>
        <div className="sm2__tabs">
          {detail && canUninstallSelectedAgent && (
            <ActionButton
              className="sm2__btn sm2__btn--danger"
              disabled={state.loading || actionBusy}
              busy={uninstallingAgentId === detail.id}
              busyLabel="卸载中"
              onClick={() => setUninstallAgentTarget(detail)}
            >
              卸载 Agent
            </ActionButton>
          )}
          <ActionButton className="sm2__btn" onClick={refreshOverview} disabled={state.loading || actionBusy} busy={refreshingOverview} busyLabel="刷新中">
            刷新总览
          </ActionButton>
          <ActionButton className="sm2__btn" onClick={refreshAll} disabled={state.loading || actionBusy || programLoading} busy={refreshingAll || programLoading} busyLabel="扫描中">
            重新扫描
          </ActionButton>
        </div>
      </div>

      <AgentToastStack
        error={state.error}
        notice={notice}
        onDismissError={() => state.setError(null)}
        onDismissNotice={() => setNotice(null)}
      />

      <div className="sm2__main sm2__main--full settings-scroll">
        <section className="sm2-agent-inventory" aria-label="本机 Agent 检测总览">
          <div className="sm2-agent-inventory__head">
            <div>
              <h3>本机 Agent</h3>
              <p>
                默认只列出检测到可执行程序（或应用）的 Agent。「仅发现配置」表示只找到本机配置或 Skills 目录，不代表程序已安装；
                「未安装 / 不可用 / 未检测到」只代表本机没有检测到对应程序，不是在线状态。这些 Agent 收在「＋」后面，点开即可查看。
              </p>
            </div>
            <span className="sm2-agent-inventory__count">
              程序已安装 {installedProgramCount} / {inventory.length}
              {configOnlyCount > 0 ? ` · 仅发现配置 ${configOnlyCount}` : ''}
            </span>
          </div>
          <div className="sm2-agent-inventory__grid">
            {visibleInventory.map((agent) => (
              <button
                key={agent.id}
                type="button"
                className={`sm2-agent-inventory__card${detail?.id === agent.id ? ' is--selected' : ''}`}
                aria-pressed={detail?.id === agent.id}
                title={`${agent.displayName} · ${AGENT_DETECTION_LABELS[agent.status]}`}
                onClick={() => state.selectAgent(agent.id)}
              >
                <AgentIconBadge iconKey={agent.iconKey} title={agent.displayName} size={22} />
                <span className="sm2-agent-inventory__copy">
                  <span className="sm2-agent-inventory__name">{agent.displayName}</span>
                  <span className="sm2-agent-inventory__meta">{inventoryMetaLabel(agent)}</span>
                </span>
                <span className={`sm2-agent-inventory__status sm2-agent-inventory__status--${AGENT_DETECTION_CLASSES[agent.status]}`}>
                  {AGENT_DETECTION_LABELS[agent.status]}
                </span>
              </button>
            ))}
            {hiddenInventory.length > 0 && (
              <button
                type="button"
                className={`sm2-agent-inventory__card sm2-agent-inventory__card--more${showOtherAgents ? ' is--selected' : ''}`}
                aria-expanded={showOtherAgents}
                title="显示未检测到程序的 Agent"
                onClick={() => setShowOtherAgents((open) => !open)}
              >
                <span className="sm2-agent-inventory__more-mark" aria-hidden="true">＋</span>
                <span className="sm2-agent-inventory__copy">
                  <span className="sm2-agent-inventory__name">其他 Agent</span>
                  <span className="sm2-agent-inventory__meta">{showOtherAgents ? '收起' : '未检测到程序或仅发现配置'}</span>
                </span>
                <span className="sm2-agent-inventory__status sm2-agent-inventory__status--unavailable">
                  {hiddenInventory.length}
                </span>
              </button>
            )}
          </div>
        </section>
        {!detail ? (
          <div className="sm2__empty">
            {state.agentDetailLoading ? '加载 Agent 详情…' : '从上方选择一个 Agent 查看详情'}
          </div>
        ) : (
          <AgentDetailView
            detail={detail}
            tab={tab}
            onTab={setTab}
            busy={actionBusy}
            scanning={scanningAgentId === detail.id}
            adoptingUnmanagedId={adoptingUnmanagedId}
            program={programs[detail.id] || null}
            agentInstalled={inventory.find((agent) => agent.id === detail.id)?.installed ?? false}
            agentDetected={inventory.find((agent) => agent.id === detail.id)?.detectedByInventory ?? false}
            agentOutput={agentOutput}
            onAdopt={openAdopt}
            onScan={scanAgent}
            onOpenSkillDetail={openSkillDetail}
            deleting={deletingAgentId === detail.id}
            onRequestDelete={setDeleteAgentTarget}
          />
        )}
      </div>

      <SkillDetailSlider
        skillId={detailSkillId}
        open={!!detailSkillId}
        fallbackSkill={detailFallback}
        onClose={() => {
          setDetailSkillId(null)
          setDetailFallback(null)
        }}
      />

      {adopt && (
        <AdoptDialog
          preview={adopt.preview}
          onClose={() => setAdopt(null)}
          validateContext={() => {
            assertRuntimeEnvironment(
              adopt.runtimeEnvironmentId,
              '运行环境已切换，已停止原环境的接管后续操作；请在当前环境重新扫描。',
            )
          }}
          onDone={async () => {
            const refreshRuntimeEnvironmentId = adopt.runtimeEnvironmentId
            const ensureRefreshRuntime = () => {
              assertRuntimeEnvironment(
                refreshRuntimeEnvironmentId,
                '运行环境已切换，已丢弃原环境的刷新结果；请在当前环境重新扫描。',
              )
            }
            ensureRefreshRuntime()
            const agentId = adopt.preview.agentId
            const visibleDetailId = detail?.id
            const unmanaged = await skillApiV2.listUnmanaged()
            ensureRefreshRuntime()
            const detailIds = new Set<string>()
            if (agentId !== SHARED_SKILLS_AGENT_ID) {
              detailIds.add(agentId)
            }
            if (visibleDetailId && visibleDetailId !== agentId) {
              detailIds.add(visibleDetailId)
            }
            for (const detailId of detailIds) {
              const refreshedDetail = await skillApiV2.getAgentDetail(detailId)
              ensureRefreshRuntime()
              if (useSkillStoreV2.getState().selectedAgentId === detailId) {
                useSkillStoreV2.setState({
                  selectedAgentDetail: refreshedDetail,
                  agentDetailLoading: false,
                })
              }
            }
            const overview = await skillApiV2.overview()
            ensureRefreshRuntime()
            useSkillStoreV2.setState({
              overview,
              skills: overview.skills,
              agents: overview.agents,
              issues: overview.issues,
              unmanaged,
              settings: overview.settings,
              lastOverviewLoadedAt: Date.now(),
              initialized: true,
              error: null,
            })
            setAdopt(null)
          }}
        />
      )}
      {customDialogOpen && (
        <CustomAgentDialog
          busy={busy}
          onClose={() => setCustomDialogOpen(false)}
          onSubmit={addCustomAgent}
        />
      )}
      {uninstallAgentTarget && (
        <PreviewDialog
          title={`卸载 Agent「${uninstallAgentTarget.displayName}」`}
          confirmLabel="确认卸载"
          busyLabel="卸载中"
          modalClassName="sm2__modal--agent-uninstall"
          destructive
          busy={uninstallingAgentId === uninstallAgentTarget.id}
          onCancel={() => setUninstallAgentTarget(null)}
          onConfirm={() => uninstallAgent(uninstallAgentTarget)}
        >
          <p className="sm2-agent-uninstall__intro">卸载会移除支持自动卸载的程序，并清理 Vibe Board 检测到的本地能力残留。</p>
          <div className="sm2-agent-uninstall__summary" aria-label="卸载清理范围">
            {uninstallProgramInstalled && uninstallProgram?.uninstallCommand && (
              <div><strong>程序</strong><span>{uninstallProgram.kind === 'app' ? '移到废纸篓' : '执行卸载命令'}</span></div>
            )}
            {uninstallProgramInstalled && !uninstallProgram?.uninstallCommand && (
              <div><strong>程序</strong><span>不支持自动卸载，将保留</span></div>
            )}
            {uninstallAgentTarget.skills.length > 0 && (
              <div><strong>{uninstallAgentTarget.skills.length}</strong><span>已管理 Skills</span></div>
            )}
            {uninstallUnmanagedItems.length > 0 && (
              <div className="sm2-agent-uninstall__danger-count"><strong>{uninstallUnmanagedItems.length}</strong><span>未管理 Skills</span></div>
            )}
            {uninstallProgram?.hooksInstalled && (
              <div><strong>Hook</strong><span>移除 Vibe Board Hook</span></div>
            )}
            {!uninstallProgramInstalled && (
              <div><strong>程序</strong><span>未安装，仅清理残留</span></div>
            )}
          </div>
          {uninstallUnmanagedItems.length > 0 && (
            <div className="sm2-agent-uninstall__warning">未管理 Skills 会直接删除；若中心库没有副本，删除后无法从 Vibe Board 恢复。</div>
          )}
          <div className="sm2-agent-uninstall__preserved">保留：中心技能库、Agent 配置与会话记录。</div>
          {uninstallProgramInstalled && uninstallProgram?.uninstallCommand && (
            <code className="sm2__command-preview">
              {uninstallProgram.kind === 'app'
                ? `移到废纸篓：${uninstallProgram.appPath}`
                : uninstallProgram.uninstallCommand}
            </code>
          )}
        </PreviewDialog>
      )}
      {deleteAgentTarget && (
        <PreviewDialog
          title={`删除 Agent「${deleteAgentTarget.displayName}」`}
          confirmLabel="确认删除"
          busyLabel="删除中"
          destructive
          busy={deletingAgentId === deleteAgentTarget.id}
          onCancel={() => setDeleteAgentTarget(null)}
          onConfirm={() => deleteCustomAgent(deleteAgentTarget)}
        >
          <p>会移除 Vibe Board 注册并清理该实例的 Vibe Board Hook，不会删除配置目录、会话记录或 Skills 文件。</p>
        </PreviewDialog>
      )}
    </div>
  )
}

function CustomAgentDialog({
  busy,
  onClose,
  onSubmit,
}: {
  busy: boolean
  onClose: () => void
  onSubmit: (config: CustomAgentConfig) => Promise<void>
}) {
  const { t } = useTranslation()
  const [displayName, setDisplayName] = useState('')
  const [configRoot, setConfigRoot] = useState('')
  const [skillsDir, setSkillsDir] = useState('')
  const [settingsFile, setSettingsFile] = useState('')
  const [error, setError] = useState<string | null>(null)

  const applyRoot = (root: string) => {
    setConfigRoot(root)
    const paths = deriveCustomAgentPaths(root)
    setSkillsDir(paths.skillsDir)
    setSettingsFile(paths.settingsFile)
  }

  const chooseRoot = async () => {
    try {
      const selected = await open({ directory: true, multiple: false })
      if (typeof selected === 'string') applyRoot(selected)
    } catch (nextError) {
      setError(String(nextError))
    }
  }

  const submit = async () => {
    const name = displayName.trim()
    const root = configRoot.trim()
    const skillPath = skillsDir.trim()
    if (!name) {
      setError('请填写显示名称')
      return
    }
    if (!root) {
      setError('请填写配置根目录')
      return
    }
    if (!skillPath) {
      setError('请填写 Skills 目录')
      return
    }
    setError(null)
    await onSubmit({
      id: null,
      displayName: name,
      category: 'claude-compatible',
      globalSkillsDir: skillPath,
      iconName: 'claude-code',
      configDir: root,
      settingsFile: settingsFile.trim() || null,
    })
  }

  return (
    <div className="skills-dialog-overlay sm2-custom-agent-overlay" onClick={onClose}>
      <div
        aria-labelledby="custom-agent-dialog-title"
        className="skills-dialog custom-agent-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="skills-dialog__header">
          <div>
            <div className="skills-dialog__title" id="custom-agent-dialog-title">{t('settings.addEngineBranch')}</div>
            <p className="custom-agent-dialog__subtitle">让企业封装版 Claude Code 使用自己的配置目录，同时复用 Vibe Board 的 Hook、会话和 Skills 管理。</p>
          </div>
        </div>
        <div className="skills-dialog__body">
          <div className="custom-agent-compatibility" role="note">
            <AgentIconBadge iconKey="claude-code" size={28} />
            <div>
              <strong>沿用 Claude Code 能力</strong>
              <span>保存后自动写入该目录的 settings.json，并监听独立的 projects 与 Skills 目录。</span>
            </div>
            <em>自动安装 Hook</em>
          </div>
          <div className="install-form-row">
            <label className="install-form-label" htmlFor="custom-agent-name">显示名称</label>
            <input
              className="install-form-input"
              id="custom-agent-name"
              placeholder="例如研发团队 Claude Code"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <div className="install-form-row">
            <label className="install-form-label" htmlFor="custom-agent-root">配置根目录</label>
            <div className="custom-agent-path-input">
              <input
                className="install-form-input"
                id="custom-agent-root"
                placeholder="例如 ~/.codefuse/engine/cc/"
                value={configRoot}
                onChange={(e) => applyRoot(e.target.value)}
              />
              <button className="skills-btn custom-agent-path-input__browse" type="button" disabled={busy} onClick={chooseRoot}>
                选择目录
              </button>
            </div>
            <div className="custom-agent-hint">请选择实际存在的 Claude 配置根目录；其下通常包含 settings.json、projects 和 skills。</div>
          </div>
          <details className="custom-agent-advanced">
            <summary>高级路径设置</summary>
            <div className="custom-agent-advanced__fields">
              <div className="install-form-row">
                <label className="install-form-label" htmlFor="custom-agent-skills">Skills 目录</label>
                <input
                  className="install-form-input"
                  id="custom-agent-skills"
                  value={skillsDir}
                  onChange={(e) => setSkillsDir(e.target.value)}
                />
              </div>
              <div className="install-form-row">
                <label className="install-form-label" htmlFor="custom-agent-settings">Settings 文件</label>
                <input
                  className="install-form-input"
                  id="custom-agent-settings"
                  value={settingsFile}
                  onChange={(e) => setSettingsFile(e.target.value)}
                />
              </div>
            </div>
          </details>
          {error && <div className="custom-agent-error">{error}</div>}
        </div>
        <div className="skills-dialog__footer">
          <button className="skills-btn" disabled={busy} onClick={onClose} type="button">取消</button>
          <ActionButton className="skills-btn skills-btn--primary" busy={busy} busyLabel="保存中" onClick={submit}>
            保存 Agent
          </ActionButton>
        </div>
      </div>
    </div>
  )
}

function deriveCustomAgentPaths(root: string) {
  const normalized = root.trim().replace(/\/+$/, '')
  if (!normalized) {
    return { skillsDir: '', settingsFile: '' }
  }
  const settingsFile = `${normalized}/settings.json`
  return {
    skillsDir: `${normalized}/skills`,
    settingsFile,
  }
}

function formatAgentOutput(event: AgentOutputEvent) {
  const prefix = event.stream === 'stderr' ? '!' : event.stream === 'stdout' ? '>' : '*'
  return `${prefix} ${event.line}`
}

interface ActionButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  busy?: boolean
  busyLabel?: ReactNode
}

function ActionButton({
  busy = false,
  busyLabel,
  className = 'sm2__btn',
  children,
  disabled,
  type = 'button',
  ...props
}: ActionButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={className}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      data-busy={busy ? 'true' : undefined}
    >
      {busy && <span className="sm2__spinner" aria-hidden="true" />}
      <span className="sm2__btn-label">{busy ? busyLabel ?? children : children}</span>
    </button>
  )
}

function AgentToastStack({
  error,
  notice,
  onDismissError,
  onDismissNotice,
  local = false,
}: {
  error?: string | null
  notice?: string | null
  onDismissError?: () => void
  onDismissNotice?: () => void
  local?: boolean
}) {
  if (!error && !notice) return null
  return (
    <div className={`sm2__agent-toast-stack${local ? ' sm2__agent-toast-stack--local' : ''}`} aria-live="polite">
      {error && (
        <div className="sm2__agent-toast sm2__agent-toast--error" role="alert">
          <span>{error}</span>
          {onDismissError && (
            <button type="button" className="sm2__agent-toast-close" onClick={onDismissError} aria-label="关闭错误提示">
              ×
            </button>
          )}
        </div>
      )}
      {notice && (
        <div className="sm2__agent-toast sm2__agent-toast--ok" role="status">
          <span>{notice}</span>
          {onDismissNotice && (
            <button type="button" className="sm2__agent-toast-close" onClick={onDismissNotice} aria-label="关闭提示">
              ×
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function AgentDetailView({
  detail,
  tab,
  onTab,
  busy,
  scanning,
  adoptingUnmanagedId,
  program,
  agentInstalled,
  agentDetected,
  agentOutput,
  onAdopt,
  onScan,
  onOpenSkillDetail,
  deleting,
  onRequestDelete,
}: {
  detail: AgentDetail
  tab: DetailTab
  onTab: (tab: DetailTab) => void
  busy: boolean
  scanning: boolean
  adoptingUnmanagedId: string | null
  program: AgentProgramInfo | null
  agentInstalled: boolean
  agentDetected: boolean
  agentOutput: string[]
  onAdopt: (agentId: string, unmanagedId: string) => void
  onScan: (agentId: string) => void
  onOpenSkillDetail: (skillId: string, fallback?: SkillDetailFallback | null) => void
  deleting: boolean
  onRequestDelete: (agent: AgentDetail) => void
}) {
  const { t } = useTranslation()
  const showUnmanaged = useSkillStoreV2((s) => s.settings?.showUnmanaged ?? true)
  const observedSkills = useSkillStoreV2((s) => s.unmanaged).filter((u) => u.agentId === detail.id)
  const unmanaged = observedSkills.filter((item) => showUnmanaged && !isReadOnlyUnmanaged(item))
  const readOnlySkills = observedSkills.filter(isReadOnlyUnmanaged)
  const inheritedManagedSkills = detail.inheritedManagedSkills ?? []
  const inheritedUnmanagedSkills = detail.inheritedUnmanagedSkills ?? []
  const inheritedSkillCount = inheritedManagedSkills.length + inheritedUnmanagedSkills.length
  const inheritsSharedSkills = detail.inheritsSharedSkills ?? inheritedSkillCount > 0
  const installed = program ? program.status === 'installed' || program.status === 'updateAvailable' : agentInstalled
  // 扫描针对本机 Skills/配置，即使程序未安装，只要库存发现过配置就仍可扫描。
  const canScan = installed || agentDetected
  const canDeleteCustom = program?.isCustom === true
  const logicalSkillCount = countLogicalAgentSkills(
    detail.skills,
    unmanaged,
    inheritedManagedSkills,
    inheritedUnmanagedSkills,
    readOnlySkills,
  )
  const tabs: Array<{ id: DetailTab; label: string }> = [
    { id: 'skills', label: `Skills (${logicalSkillCount})` },
  ]

  return (
    <div className="sm2__agent-workspace">
      <div className="sm2__agent-hero">
        <AgentIconBadge iconKey={detail.iconKey} size={38} />
        <div className="sm2__agent-hero-main">
          <div className="sm2__agent-hero-title">{detail.displayName}</div>
          <div className="sm2__agent-hero-sub">生效中的 Skill 与接管状态</div>
        </div>
        <div className="sm2__agent-summary-strip" aria-label="Agent Skill 摘要">
          <Stat value={detail.skills.length} label="生效中" />
          {showUnmanaged && <Stat value={unmanaged.length} label="未管理" tone={unmanaged.length > 0 ? 'warn' : 'ok'} />}
          {inheritsSharedSkills && <Stat value={inheritedSkillCount} label={t('skills.agentManagement.inheritedSkills')} />}
          {readOnlySkills.length > 0 && <Stat value={readOnlySkills.length} label={t('skills.agentManagement.builtinSkills')} />}
        </div>
        <div className="sm2__btn-row" style={{ margin: 0 }}>
          <ActionButton className="sm2__btn" disabled={busy || scanning || !canScan} onClick={() => onScan(detail.id)} busy={scanning} busyLabel="正在扫描">
            {scanning ? '正在扫描' : '重新扫描此 Agent'}
          </ActionButton>
          {canDeleteCustom && (
            <ActionButton className="sm2__btn sm2__btn--danger" disabled={busy && !deleting} onClick={() => onRequestDelete(detail)} busy={deleting} busyLabel="删除中">
              删除此 Agent
            </ActionButton>
          )}
        </div>
      </div>

      {agentOutput.length > 0 && (
        <div className="sm2__agent-output" aria-label="安装更新输出">
          {agentOutput.map((line, index) => <code key={`${index}-${line}`}>{line}</code>)}
        </div>
      )}

      {detail.health.length > 0 && (
        <div className="sm2__notice sm2__notice--warn">
          {detail.health.map((h) => h.message).join('；')}
        </div>
      )}

      <div className="sm2__subtabs">
        {tabs.map((item) => (
          <button
            key={item.id}
            className={`sm2__subtab${tab === item.id ? ' sm2__subtab--active' : ''}`}
            onClick={() => onTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="sm2__subtab-body">
        <SkillsTab
          key={detail.id}
          detail={detail}
          unmanaged={unmanaged}
          inheritedManagedSkills={inheritedManagedSkills}
          inheritedUnmanagedSkills={inheritedUnmanagedSkills}
          readOnlySkills={readOnlySkills}
          showUnmanaged={showUnmanaged}
          busy={busy}
          scanning={scanning}
          adoptingUnmanagedId={adoptingUnmanagedId}
          onAdopt={onAdopt}
          onScan={onScan}
          onOpenSkillDetail={onOpenSkillDetail}
        />
      </div>
    </div>
  )
}

function Stat({ value, label, tone }: { value: number; label: string; tone?: 'ok' | 'warn' }) {
  return (
    <div className={`sm2__stat${tone ? ` sm2__stat--${tone}` : ''}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  )
}


function SkillsTab({
  detail,
  unmanaged,
  inheritedManagedSkills,
  inheritedUnmanagedSkills,
  readOnlySkills,
  showUnmanaged,
  busy,
  scanning,
  adoptingUnmanagedId,
  onAdopt,
  onScan,
  onOpenSkillDetail,
}: {
  detail: AgentDetail
  unmanaged: UnmanagedItemDto[]
  inheritedManagedSkills: AgentDetail['skills']
  inheritedUnmanagedSkills: UnmanagedItemDto[]
  readOnlySkills: UnmanagedItemDto[]
  showUnmanaged: boolean
  busy: boolean
  scanning: boolean
  adoptingUnmanagedId: string | null
  onAdopt: (agentId: string, unmanagedId: string) => void
  onScan: (agentId: string) => void
  onOpenSkillDetail: (skillId: string, fallback?: SkillDetailFallback | null) => void
}) {
  const { t } = useTranslation()
  const state = useSkillStoreV2()
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [viewMode, setViewMode] = useState<AgentSkillViewMode>('cards')
  const [source, setSource] = useState<AgentSkillSource>('agent')
  const [status, setStatus] = useState<AgentSkillStatus>('managed')
  const [selectedManagedIds, setSelectedManagedIds] = useState<Set<string>>(() => new Set())
  const [selectedUnmanagedIds, setSelectedUnmanagedIds] = useState<Set<string>>(() => new Set())
  const [managedSelectionMode, setManagedSelectionMode] = useState(false)
  const [unmanagedSelectionMode, setUnmanagedSelectionMode] = useState(false)
  const [installDialogOpen, setInstallDialogOpen] = useState(false)
  const [deletingIds, setDeletingIds] = useState<Set<string>>(() => new Set())
  const [deletingUnmanagedIds, setDeletingUnmanagedIds] = useState<Set<string>>(() => new Set())
  const [adoptingIds, setAdoptingIds] = useState<Set<string>>(() => new Set())
  const [batchDeleteTargets, setBatchDeleteTargets] = useState<AgentDetail['skills'] | null>(null)
  const [batchDeleteUnmanagedTargets, setBatchDeleteUnmanagedTargets] = useState<UnmanagedItemDto[] | null>(null)
  const [batchAdoptItems, setBatchAdoptItems] = useState<UnmanagedItemDto[] | null>(null)
  const [quickTakeoverItems, setQuickTakeoverItems] = useState<UnmanagedItemDto[] | null>(null)
  const [deleteUnmanagedTarget, setDeleteUnmanagedTarget] = useState<UnmanagedItemDto | null>(null)
  const [deleteUnmanagedError, setDeleteUnmanagedError] = useState<string | null>(null)
  const reconciliationGenerationRef = useRef(0)
  const [localNotice, setLocalNotice] = useState<string | null>(null)
  const inheritedSkillCount = inheritedManagedSkills.length + inheritedUnmanagedSkills.length
  const inheritsSharedSkills = detail.inheritsSharedSkills ?? inheritedSkillCount > 0
  const activeManagedSkills = source === 'agent' ? detail.skills : inheritedManagedSkills
  const activeUnmanagedSkills = source === 'agent' ? unmanaged : inheritedUnmanagedSkills
  const capabilities = {
    addSkill: source === 'agent',
    quickTakeover: source === 'agent',
  }
  const q = query.trim().toLowerCase()
  const searchedManaged = useMemo(() => {
    if (!q) return activeManagedSkills
    return activeManagedSkills.filter((s) =>
      [
        s.skillId,
        s.targetPath,
        s.status,
        s.actualMode,
        ...s.claims.map((claim) => claim.packName || claim.claimType),
      ].filter(Boolean).join(' ').toLowerCase().includes(q),
    )
  }, [activeManagedSkills, q])
  const filteredManaged = searchedManaged
  const filteredUnmanaged = useMemo(() => {
    if (!q) return activeUnmanagedSkills
    return activeUnmanagedSkills.filter((u) =>
      [u.inferredSkillId, u.path, u.reason, unmanagedReasonLabel(t, u.reason), unmanagedSourceLabel(t, u)]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q),
    )
  }, [activeUnmanagedSkills, q, t])
  const filteredReadOnly = useMemo(() => {
    if (!q) return readOnlySkills
    return readOnlySkills.filter((item) =>
      [item.inferredSkillId, item.path, item.reason, unmanagedReasonLabel(t, item.reason)]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q),
    )
  }, [q, readOnlySkills, t])
  const [pageResetKey, setPageResetKey] = useState(`${q}|${detail.id}|${source}|${status}`)
  const currentResetKey = `${q}|${detail.id}|${source}|${status}`
  if (pageResetKey !== currentResetKey) {
    setPageResetKey(currentResetKey)
    if (page !== 1) setPage(1)
  }
  const shownManaged = filteredManaged.slice(0, page * PAGE_SIZE)
  const shownUnmanaged = filteredUnmanaged.slice(0, page * PAGE_SIZE)
  const shownReadOnly = filteredReadOnly.slice(0, page * PAGE_SIZE)
  const canManageUnmanaged = filteredUnmanaged
  const quickTakeoverCandidates = useMemo(
    () => unmanaged.filter((item) => item.reason === 'same_name_as_center_skill'),
    [unmanaged],
  )
  const managedDeleting = deletingIds.size > 0
  const unmanagedDeleting = deletingUnmanagedIds.size > 0
  const unmanagedAdopting = adoptingIds.size > 0
  const actionBusy = busy || managedDeleting || unmanagedDeleting || unmanagedAdopting
  const collectionBusy = busy || unmanagedAdopting

  useEffect(() => {
    reconciliationGenerationRef.current += 1
    setManagedSelectionMode(false)
    setUnmanagedSelectionMode(false)
    setSelectedManagedIds(new Set())
    setSelectedUnmanagedIds(new Set())
    setBatchDeleteTargets(null)
    setBatchDeleteUnmanagedTargets(null)
    setQuickTakeoverItems(null)
    setDeleteUnmanagedTarget(null)
    setDeleteUnmanagedError(null)
  }, [detail.id, source, status])

  useEffect(() => {
    if (!inheritsSharedSkills && source === 'shared') {
      setSource('agent')
      setStatus('managed')
    }
  }, [inheritsSharedSkills, source])

  useEffect(() => {
    if (status === 'builtin' && (source === 'shared' || readOnlySkills.length === 0)) {
      setStatus('managed')
    }
    if (status === 'unmanaged' && source === 'agent' && !showUnmanaged) {
      setStatus('managed')
    }
  }, [readOnlySkills.length, showUnmanaged, source, status])

  useEffect(() => {
    if (!localNotice) return
    const timer = window.setTimeout(() => setLocalNotice(null), NOTICE_DISMISS_MS)
    return () => window.clearTimeout(timer)
  }, [localNotice])

  const refreshAgentSkills = async () => {
    const nextUnmanaged = await skillApiV2.listUnmanaged()
    useSkillStoreV2.setState({ unmanaged: nextUnmanaged })
    await state.loadAgentDetail(detail.id, true)
    await state.loadOverview(true)
  }

  const reconcileDeletedAgentSkills = (agentId: string, runtimeEnvironmentId: string) => {
    const generation = reconciliationGenerationRef.current + 1
    reconciliationGenerationRef.current = generation
    void (async () => {
      let lastError: unknown = null
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const snapshot = await skillApiV2.refreshAgentSkillView(agentId)
          if (reconciliationGenerationRef.current !== generation) return
          useSkillStoreV2.getState().applyAgentSkillViewSnapshot(runtimeEnvironmentId, agentId, snapshot)
          return
        } catch (error) {
          lastError = error
        }
      }
      if (
        reconciliationGenerationRef.current === generation
        && useSkillStoreV2.getState().runtimeEnvironmentId === runtimeEnvironmentId
        && useSkillStoreV2.getState().selectedAgentId === agentId
      ) {
        state.setError(t('skills.agentManagement.deleteRefreshFailed', {
          error: skillErrorMessage(t, lastError),
        }))
      }
    })()
  }

  const deleteManaged = async (targets: AgentDetail['skills']) => {
    if (targets.length === 0) return
    const ids = targets.map((target) => target.id)
    const runtimeEnvironmentId = state.runtimeEnvironmentId
    const agentId = detail.id
    setDeletingIds((current) => new Set([...current, ...ids]))
    setLocalNotice(`正在移除 ${targets.length} 个 Skill 生效...`)
    state.setError(null)
    try {
      const targetNames = new Map(targets.map((target) => [target.id, pathBasename(target.targetPath) || target.skillId]))
      const result = await skillApiV2.deleteSkillTargetDistributions(ids)
      const failed = result.failures.map((failure) => `${targetNames.get(failure.targetId) || failure.targetId}: ${failure.error}`)
      const failedIds = new Set(result.failures.map((failure) => failure.targetId))
      const deletedIds = ids.filter((id) => !failedIds.has(id))
      useSkillStoreV2.getState().removeAgentSkillItems(runtimeEnvironmentId, agentId, deletedIds, [])
      setSelectedManagedIds(failedIds)
      setManagedSelectionMode(failedIds.size > 0)
      setLocalNotice(`已删除 ${result.deleted} 个 Skill 生效${failed.length ? `，${failed.length} 个失败` : ''}`)
      if (failed.length === 0) state.setError(null)
      if (failed.length > 0) state.setError(failed.slice(0, 3).join('\n'))
      if (deletedIds.length > 0) reconcileDeletedAgentSkills(agentId, runtimeEnvironmentId)
    } catch (e) {
      if (useSkillStoreV2.getState().runtimeEnvironmentId === runtimeEnvironmentId) {
        state.setError(String(e))
      }
    } finally {
      setDeletingIds((current) => {
        const next = new Set(current)
        ids.forEach((id) => next.delete(id))
        return next
      })
    }
  }

  const adoptUnmanaged = async (items: UnmanagedItemDto[]) => {
    if (items.length === 0) return
    const ids = items.map((item) => item.id)
    setAdoptingIds(new Set(ids))
    setLocalNotice(null)
    state.setError(null)
    try {
      let ok = 0
      const requiresIndividualReview: string[] = []
      const failed: string[] = []
      const itemsById = new Map(items.map((item) => [item.id, item]))
      const result = await skillApiV2.executeAdoptBatch(items.map((item) => ({
        agentId: adoptOwnerAgentId(detail.id, item),
        unmanagedId: item.id,
        option: defaultAgentDetailAdoptMode(item),
        renamedId: null,
      })))
      for (const itemResult of result.items) {
        const item = itemsById.get(itemResult.unmanagedId)
        const name = item?.inferredSkillId || (item ? pathBasename(item.path) : '') || itemResult.unmanagedId
        if (itemResult.skillId !== null) {
          ok += 1
        } else if (isAdoptOptionUnavailableError(itemResult.error)) {
          requiresIndividualReview.push(name)
        } else {
          failed.push(`${name}: ${skillErrorMessage(t, itemResult.error)}`)
        }
      }
      if (result.finalizationError) {
        failed.push(`批量刷新失败: ${skillErrorMessage(t, result.finalizationError)}`)
      }
      await refreshAgentSkills()
      setSelectedUnmanagedIds(new Set())
      setUnmanagedSelectionMode(false)
      setLocalNotice(t('skills.batchAdoptPack.complete', {
        adopted: ok,
        review: requiresIndividualReview.length,
        failed: failed.length,
      }))
      const messages: string[] = []
      if (requiresIndividualReview.length > 0) {
        messages.push(t('skills.batchAdoptPack.individualReviewRequired', {
          count: requiresIndividualReview.length,
          names: requiresIndividualReview.join(t('skills.batchAdoptPack.nameSeparator')),
        }))
      }
      if (failed.length > 0) messages.push(failed.slice(0, 3).join('\n'))
      state.setError(messages.length > 0 ? messages.join('\n') : null)
    } catch (e) {
      state.setError(skillErrorMessage(t, e))
    } finally {
      setAdoptingIds(new Set())
    }
  }

  const takeoverExistingCenterSkills = async (items: UnmanagedItemDto[]) => {
    if (items.length === 0) return
    const ids = items.map((item) => item.id)
    const names = new Map(items.map((item) => [
      item.id,
      item.inferredSkillId || pathBasename(item.path) || item.id,
    ]))
    setAdoptingIds(new Set(ids))
    setLocalNotice(t('skills.agentManagement.quickTakeover.running', { count: items.length }))
    state.setError(null)
    try {
      const result = await skillApiV2.takeoverCenterSkills(detail.id, ids)
      const adopted = result.items.filter((item) => item.skillId !== null).length
      const failures = result.items
        .filter((item) => item.skillId === null)
        .map((item) => `${names.get(item.unmanagedId) || item.unmanagedId}: ${skillErrorMessage(t, item.error)}`)
      if (result.finalizationError) {
        failures.push(t('skills.agentManagement.quickTakeover.refreshFailed', {
          error: skillErrorMessage(t, result.finalizationError),
        }))
      }
      try {
        await refreshAgentSkills()
      } catch (error) {
        failures.push(t('skills.agentManagement.quickTakeover.refreshFailed', {
          error: skillErrorMessage(t, error),
        }))
      }
      setSelectedUnmanagedIds(new Set())
      setLocalNotice(t('skills.agentManagement.quickTakeover.complete', {
        adopted,
        failed: failures.length,
      }))
      state.setError(failures.length > 0 ? failures.slice(0, 3).join('\n') : null)
    } catch (error) {
      state.setError(skillErrorMessage(t, error))
      setLocalNotice(null)
    } finally {
      setAdoptingIds(new Set())
    }
  }

  const deleteUnmanaged = async (items: UnmanagedItemDto[]) => {
    if (items.length === 0) return false
    const runtimeEnvironmentId = state.runtimeEnvironmentId
    const agentId = detail.id
    const itemNames = new Map(items.map((item) => [item.id, item.inferredSkillId || pathBasename(item.path) || item.id]))
    const itemIds = new Set(items.map((item) => item.id))
    setDeletingUnmanagedIds((current) => new Set([...current, ...itemIds]))
    setDeleteUnmanagedError(null)
    setLocalNotice(items.length === 1
      ? t('skills.agentManagement.unmanagedDelete.deleting', { name: itemNames.get(items[0].id) })
      : `正在移除 ${items.length} 个未管理 Skill...`)
    state.setError(null)

    const deletedIds = new Set<string>()
    const failed: string[] = []
    const failedIds = new Set<string>()
    const itemsByOwner = new Map<string, UnmanagedItemDto[]>()
    items.forEach((item) => {
      const owner = adoptOwnerAgentId(detail.id, item)
      itemsByOwner.set(owner, [...(itemsByOwner.get(owner) || []), item])
    })
    for (const [owner, ownerItems] of itemsByOwner) {
      try {
        const result = await skillApiV2.deleteUnmanagedAgentSkills(owner, ownerItems.map((item) => item.id))
        const ownerFailedIds = new Set(result.failures.map((failure) => failure.unmanagedId))
        ownerItems.forEach((item) => {
          if (ownerFailedIds.has(item.id)) failedIds.add(item.id)
          else deletedIds.add(item.id)
        })
        failed.push(...result.failures.map((failure) => `${itemNames.get(failure.unmanagedId) || failure.unmanagedId}: ${skillErrorMessage(t, failure.error)}`))
      } catch (e) {
        failed.push(`${owner}: ${skillErrorMessage(t, e)}`)
        ownerItems.forEach((item) => failedIds.add(item.id))
      }
    }
    useSkillStoreV2.getState().removeAgentSkillItems(runtimeEnvironmentId, agentId, [], [...deletedIds])
    setSelectedUnmanagedIds(failedIds)
    if (failed.length === 0) setUnmanagedSelectionMode(false)
    setUnmanagedSelectionMode(failedIds.size > 0)
    setLocalNotice(items.length === 1 && deletedIds.size === 1
      ? t('skills.agentManagement.unmanagedDelete.deleted', { name: itemNames.get(items[0].id) })
      : `已删除 ${deletedIds.size} 个未管理 Skill${failed.length ? `，${failed.length} 个失败` : ''}`)
    if (failed.length === 0) state.setError(null)
    if (failed.length > 0) state.setError(failed.slice(0, 3).join('\n'))
    if (deletedIds.size > 0) reconcileDeletedAgentSkills(agentId, runtimeEnvironmentId)
    setDeletingUnmanagedIds((current) => {
      const next = new Set(current)
      itemIds.forEach((id) => next.delete(id))
      return next
    })
    return deletedIds.size === items.length
  }

  const toggleManaged = (targetId: string) => {
    setSelectedManagedIds((current) => toggleSetValue(current, targetId))
  }

  const toggleUnmanaged = (unmanagedId: string) => {
    setSelectedUnmanagedIds((current) => toggleSetValue(current, unmanagedId))
  }

  const selectedManaged = filteredManaged.filter((item) => selectedManagedIds.has(item.id))
  const selectedUnmanaged = filteredUnmanaged.filter((item) => selectedUnmanagedIds.has(item.id))
  const deletingSharedManaged = batchDeleteTargets?.some(isSharedManagedSkill) ?? false
  const deletingSharedUnmanaged = batchDeleteUnmanagedTargets?.some(isSharedAgentsUnmanaged) ?? false
  const deletingSingleSharedUnmanaged = deleteUnmanagedTarget ? isSharedAgentsUnmanaged(deleteUnmanagedTarget) : false
  const confirmBatchDelete = async () => {
    if (!batchDeleteTargets || batchDeleteTargets.length === 0) return
    const targets = batchDeleteTargets
    setBatchDeleteTargets(null)
    await deleteManaged(targets)
  }

  const finishInstallFromLibrary = async () => {
    await refreshAgentSkills()
    setInstallDialogOpen(false)
    setSource('agent')
    setStatus('managed')
    setLocalNotice('Skill 已安装到当前 Agent')
  }

  return (
    <div className="sm2__skills-tab">
      {inheritsSharedSkills && (
        <div
          className="sm2__view-toggle sm2__agent-skill-scope-tabs sm2__agent-skill-source-tabs"
          aria-label={t('skills.agentManagement.skillSource')}
        >
          <button
            className={source === 'agent' ? 'active' : ''}
            aria-pressed={source === 'agent'}
            onClick={() => setSource('agent')}
          >
            {t('skills.agentManagement.agentSkills')} {detail.skills.length + unmanaged.length + readOnlySkills.length}
          </button>
          <button
            className={source === 'shared' ? 'active' : ''}
            aria-pressed={source === 'shared'}
            onClick={() => {
              setSource('shared')
              if (status === 'builtin') setStatus('managed')
            }}
          >
            {t('skills.agentManagement.inheritedSkills')} {inheritedSkillCount}
          </button>
        </div>
      )}
      <div className="sm2__view-toggle sm2__agent-skill-scope-tabs" aria-label={t('skills.agentManagement.skillStatus')}>
        <button
          className={status === 'managed' ? 'active' : ''}
          aria-pressed={status === 'managed'}
          onClick={() => setStatus('managed')}
        >
          {t('skills.agentManagement.managedSkills')} {activeManagedSkills.length}
        </button>
        {(source === 'shared' || showUnmanaged) && (
          <button
            className={status === 'unmanaged' ? 'active' : ''}
            aria-pressed={status === 'unmanaged'}
            onClick={() => setStatus('unmanaged')}
          >
            {t('skills.agentManagement.unmanagedSkills')} {activeUnmanagedSkills.length}
          </button>
        )}
        {source === 'agent' && readOnlySkills.length > 0 && (
          <button
            className={status === 'builtin' ? 'active' : ''}
            aria-pressed={status === 'builtin'}
            onClick={() => setStatus('builtin')}
          >
            {t('skills.agentManagement.builtinSkills')} {readOnlySkills.length}
          </button>
        )}
      </div>
      <div className="sm2__toolbar sm2__toolbar--inset sm2__toolbar--split">
        <input className="sm2__search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索 Skill 名称 / 路径 / 来源 / 原因" />
        <div className="sm2__agent-skill-actions">
          {status === 'managed' ? (
            <>
              {capabilities.addSkill && (
                <button className="sm2__btn sm2__btn--primary" disabled={actionBusy || state.skills.length === 0} onClick={() => setInstallDialogOpen(true)}>
                  新增SKILL
                </button>
              )}
              {managedSelectionMode ? (
              <>
                <span>{t('skills.agentManagement.actions.selected', { count: selectedManagedIds.size })}</span>
                <button className="sm2__btn" disabled={filteredManaged.length === 0 || actionBusy} onClick={() => setSelectedManagedIds(new Set(filteredManaged.map((item) => item.id)))}>
                  {t('skills.agentManagement.actions.selectCurrent')}
                </button>
                <button className="sm2__btn" disabled={selectedManagedIds.size === 0 || actionBusy} onClick={() => setSelectedManagedIds(new Set())}>
                  {t('skills.agentManagement.actions.clear')}
                </button>
                <ActionButton className="sm2__btn sm2__btn--danger" disabled={selectedManaged.length === 0 || actionBusy} busy={managedDeleting} busyLabel={t('skills.agentManagement.actions.deleting')} onClick={() => setBatchDeleteTargets(selectedManaged)}>
                  {t('skills.agentManagement.actions.batchDelete', { count: selectedManaged.length })}
                </ActionButton>
                <button className="sm2__btn sm2__btn--ghost" disabled={actionBusy} onClick={() => {
                  setSelectedManagedIds(new Set())
                  setManagedSelectionMode(false)
                }}>
                  {t('skills.agentManagement.actions.cancelSelection')}
                </button>
              </>
              ) : (
                <button className="sm2__btn" disabled={filteredManaged.length === 0 || actionBusy} onClick={() => setManagedSelectionMode(true)}>
                  {t('skills.agentManagement.actions.batchSelect')}
                </button>
              )}
            </>
          ) : status === 'unmanaged' ? (
            unmanagedSelectionMode ? (
              <>
                <span>{t('skills.agentManagement.actions.selected', { count: selectedUnmanagedIds.size })}</span>
                <button className="sm2__btn" disabled={canManageUnmanaged.length === 0 || actionBusy} onClick={() => setSelectedUnmanagedIds(new Set(canManageUnmanaged.map((item) => item.id)))}>
                  {t('skills.agentManagement.actions.selectCurrentAdoptable')}
                </button>
                <button className="sm2__btn" disabled={selectedUnmanagedIds.size === 0 || actionBusy} onClick={() => setSelectedUnmanagedIds(new Set())}>
                  {t('skills.agentManagement.actions.clear')}
                </button>
                <ActionButton className="sm2__btn sm2__btn--primary" disabled={selectedUnmanaged.length === 0 || actionBusy} busy={unmanagedAdopting} busyLabel={t('skills.agentManagement.actions.adopting')} onClick={() => setBatchAdoptItems(selectedUnmanaged)}>
                  {t('skills.agentManagement.actions.adoptToCenter')}
                </ActionButton>
                <ActionButton className="sm2__btn sm2__btn--danger" disabled={selectedUnmanaged.length === 0 || actionBusy} busy={unmanagedDeleting} busyLabel={t('skills.agentManagement.actions.deleting')} onClick={() => setBatchDeleteUnmanagedTargets(selectedUnmanaged)}>
                  {t('skills.agentManagement.actions.batchDelete', { count: selectedUnmanaged.length })}
                </ActionButton>
                <button className="sm2__btn sm2__btn--ghost" disabled={actionBusy} onClick={() => {
                  setSelectedUnmanagedIds(new Set())
                  setUnmanagedSelectionMode(false)
                }}>
                  {t('skills.agentManagement.actions.cancelSelection')}
                </button>
              </>
            ) : (
              <>
                {capabilities.quickTakeover && (
                  <ActionButton
                    className="sm2__btn sm2__btn--primary"
                    disabled={quickTakeoverCandidates.length === 0 || actionBusy}
                    busy={unmanagedAdopting}
                    busyLabel={t('skills.agentManagement.quickTakeover.busy')}
                    onClick={() => setQuickTakeoverItems(quickTakeoverCandidates)}
                  >
                    {t('skills.agentManagement.quickTakeover.action', { count: quickTakeoverCandidates.length })}
                  </ActionButton>
                )}
                <button className="sm2__btn" disabled={canManageUnmanaged.length === 0 || actionBusy} onClick={() => setUnmanagedSelectionMode(true)}>
                  {t('skills.agentManagement.actions.batchManage')}
                </button>
              </>
            )
          ) : null}
          <div className="sm2__view-toggle sm2__view-toggle--soft">
            <button className={viewMode === 'cards' ? 'active' : ''} onClick={() => setViewMode('cards')}>卡片</button>
            <button className={viewMode === 'list' ? 'active' : ''} onClick={() => setViewMode('list')}>列表</button>
          </div>
        </div>
      </div>
      <AgentToastStack
        notice={localNotice}
        onDismissNotice={() => setLocalNotice(null)}
        local
      />

      {source === 'shared' && inheritsSharedSkills && status !== 'builtin' && (
        <div className="sm2__notice sm2__notice--info">
          {t('skills.agentManagement.inheritedSkillsNotice', { agent: detail.displayName })}
        </div>
      )}

      {status === 'managed' && (
        <>
          <ManagedSkillCollection
            skills={shownManaged}
            mode={viewMode}
            selectable={managedSelectionMode}
            selectedIds={selectedManagedIds}
            deletingIds={deletingIds}
            busy={collectionBusy}
            emptyMessage={source === 'shared'
              ? t('skills.agentManagement.inheritedManagedNoResults')
              : q
                ? t('skills.agentManagement.packFilter.noResults')
                : undefined}
            onToggle={toggleManaged}
            onDelete={(skill) => {
              if (source === 'shared') setBatchDeleteTargets([skill])
              else void deleteManaged([skill])
            }}
            onOpenSkillDetail={onOpenSkillDetail}
          />
          {shownManaged.length < filteredManaged.length && (
            <button className="sm2__btn sm2__btn--ghost sm2__load-more" onClick={() => setPage((p) => p + 1)}>
              继续显示 {Math.min(PAGE_SIZE, filteredManaged.length - shownManaged.length)} 个
            </button>
          )}
        </>
      )}

      {status === 'unmanaged' && (source === 'shared' || showUnmanaged) && (
        <>
          {filteredUnmanaged.length === 0 ? (
            <div className="sm2__empty sm2__empty--compact sm2__unmanaged-empty">
              <span>
                {source === 'shared'
                  ? t('skills.agentManagement.inheritedUnmanagedNoResults')
                  : unmanaged.length === 0
                    ? '没有未管理 Skill。若刚手动安装过，可以重新扫描。'
                    : '没有匹配的未管理 Skill'}
              </span>
              {source === 'agent' && unmanaged.length === 0 && (
                <ActionButton className="sm2__btn" disabled={busy} onClick={() => onScan(detail.id)} busy={scanning} busyLabel="正在扫描">
                  {scanning ? '正在扫描' : '重新扫描此 Agent'}
                </ActionButton>
              )}
            </div>
          ) : (
            <>
              <UnmanagedSkillCollection
                skills={shownUnmanaged}
                mode={viewMode}
                agentId={source === 'shared' ? SHARED_SKILLS_AGENT_ID : detail.id}
                busy={collectionBusy}
                selectable={unmanagedSelectionMode}
                selectedIds={selectedUnmanagedIds}
                adoptingIds={adoptingIds}
                adoptingUnmanagedId={adoptingUnmanagedId}
                deletingIds={deletingUnmanagedIds}
                onToggle={toggleUnmanaged}
                onAdopt={onAdopt}
                onDelete={(item) => {
                  setDeleteUnmanagedError(null)
                  setDeleteUnmanagedTarget(item)
                }}
                onOpenSkillDetail={onOpenSkillDetail}
              />
              {shownUnmanaged.length < filteredUnmanaged.length && (
                <button className="sm2__btn sm2__btn--ghost sm2__load-more" onClick={() => setPage((p) => p + 1)}>
                  继续显示 {Math.min(PAGE_SIZE, filteredUnmanaged.length - shownUnmanaged.length)} 个
                </button>
              )}
            </>
          )}
        </>
      )}

      {source === 'agent' && status === 'builtin' && (
        <>
          <div className="sm2__notice sm2__notice--info">
            {t('skills.agentManagement.builtinSkillsNotice', {
              count: readOnlySkills.length,
              agent: detail.displayName,
            })}
          </div>
          {filteredReadOnly.length === 0 ? (
            <div className="sm2__empty sm2__empty--compact">
              {t('skills.agentManagement.builtinSkillsNoResults')}
            </div>
          ) : (
            <>
              <UnmanagedSkillCollection
                skills={shownReadOnly}
                mode={viewMode}
                agentId={detail.id}
                busy={collectionBusy}
                selectable={false}
                selectedIds={new Set<string>()}
                adoptingIds={adoptingIds}
                adoptingUnmanagedId={adoptingUnmanagedId}
                deletingIds={deletingUnmanagedIds}
                onToggle={toggleUnmanaged}
                onAdopt={onAdopt}
                onDelete={() => undefined}
                onOpenSkillDetail={onOpenSkillDetail}
              />
              {shownReadOnly.length < filteredReadOnly.length && (
                <button className="sm2__btn sm2__btn--ghost sm2__load-more" onClick={() => setPage((p) => p + 1)}>
                  继续显示 {Math.min(PAGE_SIZE, filteredReadOnly.length - shownReadOnly.length)} 个
                </button>
              )}
            </>
          )}
        </>
      )}

      {batchDeleteTargets && (
        <PreviewDialog
          title={deletingSharedManaged
            ? t('skills.agentManagement.sharedDelete.managedTitle')
            : '确认批量删除 Skill？'}
          confirmLabel={deletingSharedManaged
            ? t('skills.agentManagement.sharedDelete.confirm')
            : '确认删除'}
          busyLabel={deletingSharedManaged
            ? t('skills.agentManagement.sharedDelete.busy')
            : '删除中'}
          destructive
          busy={managedDeleting}
          disabled={batchDeleteTargets.length === 0}
          onCancel={() => setBatchDeleteTargets(null)}
          onConfirm={confirmBatchDelete}
        >
          {deletingSharedManaged ? (
            <>
              <p>{t('skills.agentManagement.sharedDelete.managedDescription', { count: batchDeleteTargets.length })}</p>
              <p>{t('skills.agentManagement.sharedDelete.managedPreserved')}</p>
            </>
          ) : (
            <p>{batchDeleteTargets.length}个SKILL 将从当前Agent直接删除，您后续仍旧可以从中心库安装</p>
          )}
        </PreviewDialog>
      )}
      {batchAdoptItems && (
        <BatchAdoptDialog
          items={batchAdoptItems}
          agentName={detail.displayName}
          busy={unmanagedAdopting}
          onCancel={() => setBatchAdoptItems(null)}
          onConfirm={async () => {
            const items = batchAdoptItems
            setBatchAdoptItems(null)
            await adoptUnmanaged(items)
          }}
        />
      )}
      {quickTakeoverItems && (
        <PreviewDialog
          title={t('skills.agentManagement.quickTakeover.title', { count: quickTakeoverItems.length })}
          confirmLabel={t('skills.agentManagement.quickTakeover.confirm')}
          busyLabel={t('skills.agentManagement.quickTakeover.busy')}
          busy={unmanagedAdopting}
          disabled={quickTakeoverItems.length === 0}
          modalClassName="sm2__modal--adopt"
          onCancel={() => setQuickTakeoverItems(null)}
          onConfirm={async () => {
            await takeoverExistingCenterSkills(quickTakeoverItems)
            setQuickTakeoverItems(null)
          }}
        >
          <p>{t('skills.agentManagement.quickTakeover.description', {
            count: quickTakeoverItems.length,
            agent: detail.displayName,
          })}</p>
          <p>{t('skills.agentManagement.quickTakeover.preserved', {
            count: Math.max(0, unmanaged.length - quickTakeoverItems.length),
          })}</p>
        </PreviewDialog>
      )}
      {batchDeleteUnmanagedTargets && (
        <PreviewDialog
          title={deletingSharedUnmanaged
            ? t('skills.agentManagement.sharedDelete.unmanagedTitle')
            : '确认批量删除未管理 Skill？'}
          confirmLabel={deletingSharedUnmanaged
            ? t('skills.agentManagement.sharedDelete.confirm')
            : '确认删除'}
          busyLabel={deletingSharedUnmanaged
            ? t('skills.agentManagement.sharedDelete.busy')
            : '删除中'}
          destructive
          busy={unmanagedDeleting}
          disabled={batchDeleteUnmanagedTargets.length === 0}
          onCancel={() => setBatchDeleteUnmanagedTargets(null)}
          onConfirm={async () => {
            const items = batchDeleteUnmanagedTargets
            setBatchDeleteUnmanagedTargets(null)
            await deleteUnmanaged(items)
          }}
        >
          {deletingSharedUnmanaged ? (
            <>
              <p>{t('skills.agentManagement.sharedDelete.unmanagedDescription', { count: batchDeleteUnmanagedTargets.length })}</p>
              <p>{t('skills.agentManagement.sharedDelete.unmanagedPermanent')}</p>
            </>
          ) : (
            <>
              <p><strong>{batchDeleteUnmanagedTargets.length}</strong> 个未管理 Skill 将从当前 Agent 直接删除。</p>
              <p>这些 Skill 不会写入中心库，删除后无法从 Vibe Board 恢复。</p>
            </>
          )}
        </PreviewDialog>
      )}
      {deleteUnmanagedTarget && (
        <PreviewDialog
          title={deletingSingleSharedUnmanaged
            ? t('skills.agentManagement.sharedDelete.unmanagedTitle')
            : t('skills.agentManagement.unmanagedDelete.title', {
              name: deleteUnmanagedTarget.inferredSkillId || pathBasename(deleteUnmanagedTarget.path) || deleteUnmanagedTarget.id,
            })}
          confirmLabel={deletingSingleSharedUnmanaged
            ? t('skills.agentManagement.sharedDelete.confirm')
            : t('skills.agentManagement.unmanagedDelete.confirm')}
          busyLabel={deletingSingleSharedUnmanaged
            ? t('skills.agentManagement.sharedDelete.busy')
            : t('skills.agentManagement.unmanagedDelete.busy')}
          modalClassName="sm2__modal--unmanaged-delete"
          destructive
          busy={deletingUnmanagedIds.has(deleteUnmanagedTarget.id)}
          onCancel={() => {
            setDeleteUnmanagedError(null)
            setDeleteUnmanagedTarget(null)
          }}
          onConfirm={async () => {
            const item = deleteUnmanagedTarget
            setDeleteUnmanagedError(null)
            setDeleteUnmanagedTarget(null)
            await deleteUnmanaged([item])
          }}
        >
          <p>{deletingSingleSharedUnmanaged
            ? t('skills.agentManagement.sharedDelete.unmanagedDescription', { count: 1 })
            : t('skills.agentManagement.unmanagedDelete.description')}</p>
          {deletingSingleSharedUnmanaged && <p>{t('skills.agentManagement.sharedDelete.unmanagedPermanent')}</p>}
          <code>{deleteUnmanagedTarget.path}</code>
          {deleteUnmanagedError && <div className="sm2__error sm2__modal-inline-error">{deleteUnmanagedError}</div>}
        </PreviewDialog>
      )}
      {installDialogOpen && (
        <AgentSkillInstallDialog
          agent={detail}
          skills={state.skills}
          defaultMode={state.settings?.defaultDistributeMode || 'link'}
          onClose={() => setInstallDialogOpen(false)}
          onDone={finishInstallFromLibrary}
        />
      )}
    </div>
  )
}


function BatchAdoptDialog({
  items,
  agentName,
  busy,
  onCancel,
  onConfirm,
}: {
  items: UnmanagedItemDto[]
  agentName: string
  busy: boolean
  onCancel: () => void
  onConfirm: () => Promise<void> | void
}) {
  const { t } = useTranslation()
  const [error, setError] = useState<string | null>(null)
  const visibleItems = items.slice(0, 6)
  const remaining = Math.max(0, items.length - visibleItems.length)

  const execute = async () => {
    setError(null)
    try {
      await Promise.resolve(onConfirm())
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <PreviewDialog
      title={t('skills.batchAdoptPack.title', { count: items.length })}
      confirmLabel={t('skills.batchAdoptPack.confirm')}
      cancelLabel={t('skills.cancel')}
      busy={busy}
      modalClassName="sm2__modal--adopt sm2__modal--batch-adopt-pack"
      onCancel={onCancel}
      onConfirm={execute}
    >
      <div className="sm2-adopt sm2-batch-adopt-pack">
        <div className="sm2-adopt__summary">
          <div>
            <span>{t('skills.batchAdoptPack.agent')}</span>
            <strong>{agentName}</strong>
          </div>
          <div>
            <span>{t('skills.batchAdoptPack.skillCount')}</span>
            <strong>{items.length}</strong>
          </div>
          <div className="sm2-adopt__summary-path">
            <span>{t('skills.batchAdoptPack.summary')}</span>
            <code>{visibleItems.map((item) => item.inferredSkillId || pathBasename(item.path) || item.id).join(', ')}{remaining > 0 ? ` +${remaining}` : ''}</code>
          </div>
        </div>

        <div className="sm2-adopt__impact sm2-adopt__impact--warn">
          <strong>{t('skills.batchAdoptPack.strategyTitle')}</strong>
          <span>{t('skills.batchAdoptPack.strategyHint')}</span>
        </div>

        {error && <div className="sm2__error" style={{ margin: 0 }}>{error}</div>}
      </div>
    </PreviewDialog>
  )
}

function AgentSkillInstallDialog({
  agent,
  skills,
  defaultMode,
  onClose,
  onDone,
}: {
  agent: AgentDetail
  skills: SkillSummary[]
  defaultMode: 'link' | 'copy'
  onClose: () => void
  onDone: () => void | Promise<void>
}) {
  const { t } = useTranslation()
  const [scope, setScope] = useState<AgentLibraryScope>('uninstalled')
  const [query, setQuery] = useState('')
  const [source, setSource] = useState('')
  const [mode, setMode] = useState<'link' | 'copy'>(defaultMode)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [preview, setPreview] = useState<DistributionPreview | null>(null)
  const [blockerDecisions, setBlockerDecisions] = useState<Record<string, InstallBlockerDecision>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sources = useMemo(
    () => Array.from(new Set(skills.map((skill) => skill.sourceType).filter(Boolean))).sort(),
    [skills],
  )
  const counts = useMemo(() => {
    let installed = 0
    for (const skill of skills) {
      if (skillInstalledOnAgent(skill, agent.id)) installed += 1
    }
    return { installed, uninstalled: skills.length - installed, all: skills.length }
  }, [agent.id, skills])
  const filteredSkills = useMemo(() => {
    const q = query.trim().toLowerCase()
    return skills.filter((skill) => {
      const installed = skillInstalledOnAgent(skill, agent.id)
      if (scope === 'installed' && !installed) return false
      if (scope === 'uninstalled' && installed) return false
      if (source && skill.sourceType !== source) return false
      if (!q) return true
      const haystack = [
        skill.id,
        skill.name,
        skill.description,
        skill.sourceType,
        skillSourceTypeLabel(t, skill.sourceType),
        skill.sourceUri,
        skill.skillType,
      ].filter(Boolean).join(' ').toLowerCase()
      return haystack.includes(q)
    })
  }, [agent.id, query, scope, skills, source, t])
  const selectedSkills = useMemo(
    () => skills.filter((skill) => selectedIds.has(skill.id)),
    [selectedIds, skills],
  )
  const unresolvedBlockers = preview?.blockers.filter((blocker) => !blockerDecisions[installBlockerKey(blocker)]).length ?? 0

  useEffect(() => {
    setMode(defaultMode)
  }, [defaultMode])

  useEffect(() => {
    setSelectedIds((current) => {
      const known = new Set(skills.map((skill) => skill.id))
      const next = new Set(Array.from(current).filter((id) => known.has(id)))
      return next.size === current.size ? current : next
    })
  }, [skills])

  const toggleSkill = (skillId: string) => {
    setSelectedIds((current) => toggleSetValue(current, skillId))
  }

  const selectVisible = () => {
    setSelectedIds((current) => {
      const next = new Set(current)
      for (const skill of filteredSkills) next.add(skill.id)
      return next
    })
  }

  const runPreview = async () => {
    if (selectedSkills.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const nextPreview = await skillApiV2.previewDistribute(selectedSkills.map((skill) => skill.id), [agent.id], mode)
      setPreview(nextPreview)
      setBlockerDecisions({})
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
      const blockerDecisionsPayload = preview.blockers
        .map((blocker) => {
          const action = blockerDecisions[installBlockerKey(blocker)]
          return action ? { skillId: blocker.skillId, agentId: blocker.agentId, action } : null
        })
        .filter((item): item is { skillId: string; agentId: string; action: InstallBlockerDecision } => Boolean(item))
      await skillApiV2.executeDistribute({ ...preview, blockerDecisions: blockerDecisionsPayload })
      await Promise.resolve(onDone())
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  if (preview) {
    return (
      <PreviewDialog
        title="确认安装 Skill"
        confirmLabel={preview.blockers.length > 0 ? '按选择执行' : '执行生效'}
        cancelLabel="返回选择"
        busy={busy}
        disabled={unresolvedBlockers > 0}
        modalClassName="sm2__modal--agent-install sm2__modal--light-surface"
        onCancel={() => setPreview(null)}
        onConfirm={execute}
      >
        <div className="sm2-agent-install">
          <div className="sm2-agent-install__target">
            <span>目标：</span>
            <strong>{agent.displayName}</strong>
            <em>{selectedSkills.length} 个 Skill · {skillModeLabel(t, mode)}</em>
          </div>
          <div className="sm2-agent-install__preview-list">
            {preview.changes.map((change) => (
              <div key={`${change.skillId}-${change.agentId}`} className="sm2-agent-install__preview-row">
                <span className="sm2__tag sm2__tag--ok">
                  {change.action === 'create' ? '新增' : change.action === 'reinstall' ? '重装' : change.action === 'convert' ? '转换' : change.action}
                </span>
                <div>
                  <strong>{selectedSkills.find((skill) => skill.id === change.skillId)?.name ?? change.skillId}</strong>
                  <code>{change.targetPath}</code>
                </div>
              </div>
            ))}
            {preview.blockers.map((blocker) => {
              const key = installBlockerKey(blocker)
              const decision = blockerDecisions[key]
              return (
                <div key={key} className="sm2-agent-install__preview-row sm2-agent-install__preview-row--blocked">
                  <span className="sm2__tag sm2__tag--conflict">阻止</span>
                  <div>
                    <strong>{selectedSkills.find((skill) => skill.id === blocker.skillId)?.name ?? blocker.skillId}</strong>
                    <span>{distributionBlockerReason(t, blocker)}</span>
                    {blocker.existingPath && <code>{blocker.existingPath}</code>}
                    <div className="sm2-agent-install__decision-row">
                      {blocker.existingPath && (
                        <button
                          type="button"
                          className={`sm2__btn${decision === 'overwrite' ? ' sm2__btn--active' : ''}`}
                          onClick={() => setBlockerDecisions((current) => ({ ...current, [key]: 'overwrite' }))}
                        >
                          覆盖安装
                        </button>
                      )}
                      <button
                        type="button"
                        className={`sm2__btn${decision === 'skip' ? ' sm2__btn--active' : ''}`}
                        onClick={() => setBlockerDecisions((current) => ({ ...current, [key]: 'skip' }))}
                      >
                        忽略此目标
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
          {error && <div className="sm2__error" style={{ margin: 0 }}>{error}</div>}
        </div>
      </PreviewDialog>
    )
  }

  return (
    <PreviewDialog
      title="从技能库添加"
      confirmLabel={`添加 ${selectedIds.size} 个 Skill`}
      busy={busy}
      disabled={selectedIds.size === 0}
      modalClassName="sm2__modal--agent-install sm2__modal--light-surface"
      onCancel={onClose}
      onConfirm={runPreview}
    >
      <div className="sm2-agent-install">
        <div className="sm2-agent-install__target">
          <span>目标：</span>
          <AgentIconBadge iconKey={agent.iconKey} title={agent.displayName} size={24} />
          <strong>{agent.displayName}</strong>
          <em>{skillModeLabel(t, mode)}</em>
        </div>
        <div className="sm2-agent-install__search">
          <span className="sm2__filter-icon">⌕</span>
          <input
            className="sm2__search sm2__search--quiet"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索技能库..."
          />
        </div>
        <div className="sm2-agent-install__filters">
          <span>状态</span>
          <div className="sm2__view-toggle sm2__view-toggle--soft">
            <button className={scope === 'uninstalled' ? 'active' : ''} onClick={() => setScope('uninstalled')}>未安装 {counts.uninstalled}</button>
            <button className={scope === 'installed' ? 'active' : ''} onClick={() => setScope('installed')}>已安装 {counts.installed}</button>
            <button className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>全部 {counts.all}</button>
          </div>
        </div>
        <div className="sm2-agent-install__filters">
          <span>标签</span>
          <div className="sm2-agent-install__chips">
            <button className={`sm2__source-chip${source === '' ? ' sm2__source-chip--active' : ''}`} onClick={() => setSource('')}>
              全部标签
            </button>
            {sources.map((item) => (
              <button
                key={item}
                className={`sm2__source-chip${source === item ? ' sm2__source-chip--active' : ''}`}
                onClick={() => setSource(item)}
              >
                {skillSourceTypeLabel(t, item)}
              </button>
            ))}
          </div>
        </div>
        <div className="sm2-agent-install__filters">
          <span>安装方式</span>
          <div className="sm2__view-toggle sm2__view-toggle--soft">
            <button className={mode === 'link' ? 'active' : ''} onClick={() => setMode('link')}>{skillModeLabel(t, 'link')}</button>
            <button className={mode === 'copy' ? 'active' : ''} onClick={() => setMode('copy')}>{skillModeLabel(t, 'copy')}</button>
          </div>
        </div>
        <div className="sm2-agent-install__bulk">
          <span>已选择 {selectedIds.size} 个</span>
          <button className="sm2__btn sm2__btn--ghost" disabled={filteredSkills.length === 0} onClick={selectVisible}>
            选择当前
          </button>
          <button className="sm2__btn sm2__btn--ghost" disabled={selectedIds.size === 0} onClick={() => setSelectedIds(new Set())}>
            清空
          </button>
        </div>
        <div className="sm2-agent-install__list">
          {filteredSkills.length === 0 ? (
            <div className="sm2__empty sm2__empty--compact">没有匹配的 Skill</div>
          ) : (
            filteredSkills.map((skill) => {
              const installedRef = skill.installedAgents.find((ref) => ref.agentId === agent.id)
              const checked = selectedIds.has(skill.id)
              return (
                <label key={skill.id} className={`sm2-agent-install__row${checked ? ' sm2-agent-install__row--selected' : ''}${installedRef ? ' sm2-agent-install__row--installed' : ''}`}>
                  <input
                    type="checkbox"
                    aria-label={`选择 ${skill.name}`}
                    checked={checked}
                    onChange={() => toggleSkill(skill.id)}
                  />
                  <span className="sm2-agent-install__check" aria-hidden="true">{checked ? '✓' : ''}</span>
                  <div className="sm2-agent-install__row-main">
                    <strong>{skill.name}</strong>
                    <span>{skill.description || skill.id}</span>
                  </div>
                  <span className="sm2-agent-install__source">{skillSourceTypeLabel(t, skill.sourceType)}</span>
                  <span className={`sm2__tag sm2__tag--${installedRef ? 'ok' : 'unmanaged'}`}>
                    {installedRef ? '已添加' : '未安装'}
                  </span>
                </label>
              )
            })
          )}
        </div>
        {error && <div className="sm2__error" style={{ margin: 0 }}>{error}</div>}
      </div>
    </PreviewDialog>
  )
}

type AgentSkillItemProps = {
  name: string
  description: string
  path: string
  pathTitle?: string
  status?: ReactNode
  metadata?: ReactNode
  actions?: ReactNode
  selectable?: boolean
  selected?: boolean
  selectionLabel?: string
  selectionDisabled?: boolean
  deleting?: boolean
  adopting?: boolean
  unmanaged?: boolean
  onToggle?: () => void
  onOpen: () => void
}

function AgentSkillCard({
  name,
  description,
  path,
  pathTitle,
  status,
  metadata,
  actions,
  selectable = false,
  selected = false,
  selectionLabel,
  selectionDisabled = false,
  deleting = false,
  adopting = false,
  unmanaged = false,
  onToggle,
  onOpen,
}: AgentSkillItemProps) {
  const className = [
    'sm2__agent-skill-card',
    'sm2__agent-skill-card--clickable',
    selected && 'sm2__agent-skill-card--selected',
    deleting && 'sm2__agent-skill-card--deleting',
    adopting && 'sm2__agent-skill-card--adopting',
    unmanaged && 'sm2__agent-skill-card--unmanaged',
  ].filter(Boolean).join(' ')
  return (
    <article
      className={className}
      role="button"
      tabIndex={0}
      aria-busy={deleting || adopting || undefined}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          onOpen()
        }
      }}
    >
      <div className={`sm2__agent-skill-card-head${selectable ? ' sm2__agent-skill-card-head--selectable' : ''}`}>
        {selectable && onToggle && selectionLabel && (
          <input
            type="checkbox"
            className="sm2__agent-skill-select"
            aria-label={selectionLabel}
            checked={selected}
            disabled={selectionDisabled}
            onClick={(event) => event.stopPropagation()}
            onChange={onToggle}
          />
        )}
        <div className="sm2__agent-skill-icon">{initials(name || 'SK')}</div>
        <div className="sm2__agent-skill-card-titleline">
          <strong>{name}</strong>
          <span>{description}</span>
        </div>
        {status && <div className="sm2__tag-row">{status}</div>}
      </div>
      {metadata && <div className="sm2__agent-skill-meta">{metadata}</div>}
      <code title={pathTitle}>{path}</code>
      {actions && (
        <div
          className="sm2__agent-skill-card-actions"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {actions}
        </div>
      )}
    </article>
  )
}

function AgentSkillListRow({
  name,
  description,
  path,
  pathTitle,
  status,
  actions,
  selectable = false,
  selected = false,
  selectionLabel,
  selectionDisabled = false,
  deleting = false,
  adopting = false,
  onToggle,
  onOpen,
}: AgentSkillItemProps) {
  const className = [
    'sm2__object-row',
    'sm2__object-row--path',
    'sm2__object-row--clickable',
    selected && 'sm2__object-row--selected',
    deleting && 'sm2__object-row--deleting',
    adopting && 'sm2__object-row--adopting',
  ].filter(Boolean).join(' ')
  return (
    <div
      className={className}
      role="button"
      tabIndex={0}
      aria-busy={deleting || adopting || undefined}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          onOpen()
        }
      }}
    >
      {selectable && onToggle && selectionLabel && (
        <input
          type="checkbox"
          className="sm2__agent-skill-select"
          aria-label={selectionLabel}
          checked={selected}
          disabled={selectionDisabled}
          onClick={(event) => event.stopPropagation()}
          onChange={onToggle}
        />
      )}
      <div>
        <strong>{name}</strong>
        <span>{description}</span>
        <code title={pathTitle}>{path}</code>
      </div>
      {(status || actions) && (
        <div
          className="sm2__object-row-actions"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {status}
          {actions}
        </div>
      )}
    </div>
  )
}

function ManagedSkillCollection({
  skills,
  mode,
  selectable,
  selectedIds,
  deletingIds,
  busy,
  emptyMessage,
  onToggle,
  onDelete,
  onOpenSkillDetail,
}: {
  skills: AgentDetail['skills']
  mode: AgentSkillViewMode
  selectable: boolean
  selectedIds: Set<string>
  deletingIds: Set<string>
  busy: boolean
  emptyMessage?: string
  onToggle: (targetId: string) => void
  onDelete: (skill: AgentDetail['skills'][number]) => void
  onOpenSkillDetail: (skillId: string) => void
}) {
  if (skills.length === 0) {
    return <div className="sm2__empty sm2__empty--compact">{emptyMessage || '暂无已管理 Skill'}</div>
  }

  if (mode === 'list') {
    return (
      <div className="sm2__agent-skill-list">
        {skills.map((s) => (
          <ManagedSkillListRow
            key={s.id}
            skill={s}
            selectable={selectable}
            selected={selectable && selectedIds.has(s.id)}
            deleting={deletingIds.has(s.id)}
            busy={busy}
            onToggle={onToggle}
            onDelete={onDelete}
            onOpenSkillDetail={onOpenSkillDetail}
          />
        ))}
      </div>
    )
  }

  return (
    <div className="sm2__agent-skill-grid">
      {skills.map((s) => (
        <ManagedSkillCard
          key={s.id}
          skill={s}
          selectable={selectable}
          selected={selectable && selectedIds.has(s.id)}
          deleting={deletingIds.has(s.id)}
          busy={busy}
          onToggle={onToggle}
          onDelete={onDelete}
          onOpenSkillDetail={onOpenSkillDetail}
        />
      ))}
    </div>
  )
}

function ManagedSkillCard({
  skill,
  selectable,
  selected,
  deleting,
  busy,
  onToggle,
  onDelete,
  onOpenSkillDetail,
}: {
  skill: AgentDetail['skills'][number]
  selectable: boolean
  selected: boolean
  deleting: boolean
  busy: boolean
  onToggle: (targetId: string) => void
  onDelete: (skill: AgentDetail['skills'][number]) => void
  onOpenSkillDetail: (skillId: string) => void
}) {
  const { t } = useTranslation()
  const name = pathBasename(skill.targetPath) || skill.id
  const claims = skill.claims.map((c) => targetClaimLabel(t, c)).filter(Boolean)
  const deleteLabel = t('skills.agentManagement.actions.delete')
  const deletingLabel = t('skills.agentManagement.actions.deleting')
  return (
    <AgentSkillCard
      name={name}
      description={claims.length > 0 ? claims.join(' / ') : targetClaimLabel(t, null)}
      path={skill.targetPath}
      status={<span className={`sm2__tag sm2__tag--${skill.status}`}>{skillStatusLabel(t, skill.status)}</span>}
      metadata={<>
        <span className="sm2__source-pill">{skillModeLabel(t, skill.actualMode)}</span>
        {skill.claims.length > 0
          ? skill.claims.map((claim) => (
            <span key={claim.id} className={`sm2__source-pill sm2__source-pill--claim-${claim.claimType}`}>
              {targetClaimLabel(t, claim)}
            </span>
          ))
          : <span className="sm2__source-pill sm2__source-pill--claim-direct">{targetClaimLabel(t, null)}</span>}
      </>}
      actions={<>
        <ActionButton className="sm2__btn sm2__btn--danger" disabled={busy && !deleting} busy={deleting} busyLabel={deletingLabel} aria-label={t(deleting
          ? 'skills.agentManagement.actions.deletingNamed'
          : 'skills.agentManagement.actions.deleteNamed', { name })} onClick={(e) => {
          e.stopPropagation()
          onDelete(skill)
        }}>
          {deleteLabel}
        </ActionButton>
      </>}
      selectable={selectable}
      selected={selected}
      selectionLabel={t('skills.agentManagement.actions.selectNamed', { name })}
      selectionDisabled={busy}
      deleting={deleting}
      onToggle={() => onToggle(skill.id)}
      onOpen={() => onOpenSkillDetail(skill.skillId)}
    />
  )
}

function ManagedSkillListRow({
  skill,
  selectable,
  selected,
  deleting,
  busy,
  onToggle,
  onDelete,
  onOpenSkillDetail,
}: {
  skill: AgentDetail['skills'][number]
  selectable: boolean
  selected: boolean
  deleting: boolean
  busy: boolean
  onToggle: (targetId: string) => void
  onDelete: (skill: AgentDetail['skills'][number]) => void
  onOpenSkillDetail: (skillId: string) => void
}) {
  const { t } = useTranslation()
  const claims = skill.claims.map((c) => targetClaimLabel(t, c)).filter(Boolean)
  const name = pathBasename(skill.targetPath) || skill.id
  const deleteLabel = t('skills.agentManagement.actions.delete')
  const deletingLabel = t('skills.agentManagement.actions.deleting')
  return (
    <AgentSkillListRow
      name={name}
      description={`${skillModeLabel(t, skill.actualMode)} · ${skillStatusLabel(t, skill.status)} · ${claims.join(' / ')}`}
      path={skill.targetPath}
      actions={<>
        <ActionButton className="sm2__btn sm2__btn--danger" disabled={busy && !deleting} busy={deleting} busyLabel={deletingLabel} aria-label={t(deleting
          ? 'skills.agentManagement.actions.deletingNamed'
          : 'skills.agentManagement.actions.deleteNamed', { name })} onClick={(e) => {
          e.stopPropagation()
          onDelete(skill)
        }}>
          {deleteLabel}
        </ActionButton>
      </>}
      selectable={selectable}
      selected={selected}
      selectionLabel={t('skills.agentManagement.actions.selectNamed', { name })}
      selectionDisabled={busy}
      deleting={deleting}
      onToggle={() => onToggle(skill.id)}
      onOpen={() => onOpenSkillDetail(skill.skillId)}
    />
  )
}

function UnmanagedSkillCollection({
  skills,
  mode,
  agentId,
  busy,
  selectable,
  selectedIds,
  adoptingIds,
  adoptingUnmanagedId,
  deletingIds,
  onToggle,
  onAdopt,
  onDelete,
  onOpenSkillDetail,
}: {
  skills: UnmanagedItemDto[]
  mode: AgentSkillViewMode
  agentId: string
  busy: boolean
  selectable: boolean
  selectedIds: Set<string>
  adoptingIds: Set<string>
  adoptingUnmanagedId: string | null
  deletingIds: Set<string>
  onToggle: (unmanagedId: string) => void
  onAdopt: (agentId: string, unmanagedId: string) => void
  onDelete: (item: UnmanagedItemDto) => void
  onOpenSkillDetail: (skillId: string, fallback?: SkillDetailFallback | null) => void
}) {
  const { t } = useTranslation()
  return (
    <div className={mode === 'list' ? 'sm2__agent-skill-list' : 'sm2__agent-skill-grid'}>
      {skills.map((u) => {
        const name = u.inferredSkillId || pathBasename(u.path) || u.id
        const readOnly = isReadOnlyUnmanaged(u)
        const adopting = adoptingUnmanagedId === u.id || adoptingIds.has(u.id)
        const deleting = deletingIds.has(u.id)
        const sourceLabel = unmanagedSourceLabel(t, u)
        const actions = readOnly ? undefined : (
          <>
            <ActionButton className="sm2__btn sm2__btn--primary" disabled={busy && !adopting} busy={adopting} busyLabel={t('skills.agentManagement.actions.preparingAdopt')} onClick={(event) => {
              event.stopPropagation()
              onAdopt(adoptOwnerAgentId(agentId, u), u.id)
            }}>
              {t('skills.agentManagement.actions.adopt')}
            </ActionButton>
            <ActionButton className="sm2__btn sm2__btn--danger" disabled={busy && !deleting} busy={deleting} busyLabel={t('skills.agentManagement.actions.deleting')} aria-label={t(deleting
              ? 'skills.agentManagement.actions.deletingNamed'
              : 'skills.agentManagement.actions.deleteNamed', { name })} onClick={(event) => {
              event.stopPropagation()
              onDelete(u)
            }}>
              {t('skills.agentManagement.actions.delete')}
            </ActionButton>
          </>
        )
        if (mode === 'list') {
          return (
            <AgentSkillListRow
              key={u.id}
              name={name}
              description={`${unmanagedReasonLabel(t, u.reason)}${sourceLabel ? ` · ${sourceLabel}` : ''}`}
              path={u.path}
              status={readOnly ? <span className="sm2__tag sm2__tag--shared">{unmanagedReasonLabel(t, u.reason)}</span> : undefined}
              actions={actions}
              selectable={selectable && !readOnly}
              selected={selectable && selectedIds.has(u.id)}
              selectionLabel={t('skills.agentManagement.actions.selectNamed', { name })}
              selectionDisabled={busy}
              deleting={deleting}
              adopting={adopting}
              onToggle={() => onToggle(u.id)}
              onOpen={() => openUnmanagedSkill(u, onOpenSkillDetail)}
            />
          )
        }
        return (
          <AgentSkillCard
            key={u.id}
            name={name}
            description={unmanagedReasonLabel(t, u.reason)}
            path={u.path}
            status={(
              <span className={`sm2__tag sm2__tag--${readOnly ? 'shared' : 'unmanaged'}`}>
                {readOnly ? unmanagedReasonLabel(t, u.reason) : '未管理'}
              </span>
            )}
            metadata={sourceLabel ? <span className="sm2__source-pill">{sourceLabel}</span> : undefined}
            actions={actions}
            selectable={selectable && !readOnly}
            selected={selectable && selectedIds.has(u.id)}
            selectionLabel={t('skills.agentManagement.actions.selectNamed', { name })}
            selectionDisabled={busy}
            deleting={deleting}
            adopting={adopting}
            unmanaged
            onToggle={() => onToggle(u.id)}
            onOpen={() => openUnmanagedSkill(u, onOpenSkillDetail)}
          />
        )
      })}
    </div>
  )
}

function toggleSetValue(current: Set<string>, value: string) {
  const next = new Set(current)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

function countLogicalAgentSkills(
  managed: AgentDetail['skills'],
  unmanaged: UnmanagedItemDto[],
  inheritedManaged: AgentDetail['skills'],
  inheritedUnmanaged: UnmanagedItemDto[],
  readOnly: UnmanagedItemDto[],
) {
  return new Set([
    ...managed.map((item) => item.skillId || item.id),
    ...unmanaged.map((item) => item.inferredSkillId || item.id),
    ...inheritedManaged.map((item) => item.skillId || item.id),
    ...inheritedUnmanaged.map((item) => item.inferredSkillId || item.id),
    ...readOnly.map((item) => item.inferredSkillId || item.id),
  ].filter(Boolean)).size
}

function skillInstalledOnAgent(skill: SkillSummary, agentId: string) {
  return skill.installedAgents.some((agent) => agent.agentId === agentId)
}

function installBlockerKey(blocker: ConflictBlocker) {
  return `${blocker.skillId}\u0000${blocker.agentId}`
}

function defaultAgentDetailAdoptMode(item: UnmanagedItemDto) {
  if (item.agentId === SHARED_SKILLS_AGENT_ID) return 'import_cleanup'
  return isSharedAgentsSkillsPath(item.path) ? 'import_link' : 'import_keep'
}

function adoptOwnerAgentId(detailAgentId: string, item: UnmanagedItemDto) {
  return item.agentId || detailAgentId
}

function isSharedAgentsUnmanaged(item: UnmanagedItemDto) {
  return item.agentId === SHARED_SKILLS_AGENT_ID || isSharedAgentsSkillsPath(item.path)
}

function isSharedManagedSkill(item: AgentDetail['skills'][number]) {
  return item.agentId === SHARED_SKILLS_AGENT_ID || isSharedAgentsSkillsPath(item.targetPath)
}

function isReadOnlyUnmanaged(item: UnmanagedItemDto) {
  return item.readOnly === true || item.reason === 'agent_builtin_read_only'
}

function unmanagedSourceLabel(t: Parameters<typeof unmanagedReasonLabel>[0], item: UnmanagedItemDto) {
  return isSharedAgentsUnmanaged(item) ? unmanagedReasonLabel(t, 'shared_agents_directory') : ''
}

function isSharedAgentsSkillsPath(path: string) {
  const parts = path.split(/[\\/]+/)
  return parts.some((part, index) => part === '.agents' && parts[index + 1] === 'skills')
}

function openUnmanagedSkill(
  item: UnmanagedItemDto,
  onOpenSkillDetail: (skillId: string, fallback?: SkillDetailFallback | null) => void,
) {
  const name = item.inferredSkillId || pathBasename(item.path) || item.id
  onOpenSkillDetail(name, {
    id: name,
    name,
    centerPath: item.path,
    currentHash: item.hash,
    sourceType: 'unmanaged_agent',
    sourceUri: item.path,
  })
}

function pathBasename(path: string) {
  return path.split(/[\\/]+/).filter(Boolean).pop() || ''
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
