import { create } from 'zustand'
import type {
  SkillManagerOverview,
  SkillManagerSettings,
  SkillSummary,
  SkillDetail,
  AgentSummary,
  AgentDetail,
  AgentSkillViewSnapshot,
  DiagnosisIssue,
  UnmanagedItemDto,
  DistributionPreview,
  ProjectSummary,
  ProjectDetail,
  SkillUpdateStatus,
  SkillUpdateCheckReport,
  SkillUpdateRunResult,
} from '../services/skillApiV2'
import { skillApiV2 } from '../services/skillApiV2'

// Skill Manager only ever operates on this machine. The id is kept as the
// generation token that long-running loads compare against before applying a
// result; it no longer selects between environments.
export const LOCAL_RUNTIME_ENVIRONMENT_ID = 'local'

export type SkillManagerTab = 'library' | 'install' | 'projects' | 'agents' | 'settings'
export type SkillInstallTab = 'official' | 'agent' | 'local' | 'git'
export type SkillViewMode = 'cards' | 'list'

const OVERVIEW_CACHE_TTL_MS = 60_000

export interface SkillFilters {
  query: string
  source: string
  status: string
  type: string
}

interface SkillV2State {
  runtimeEnvironmentId: string
  activeTab: SkillManagerTab
  activeInstallTab: SkillInstallTab
  viewMode: SkillViewMode
  overview: SkillManagerOverview | null
  settings: SkillManagerSettings | null
  skills: SkillSummary[]
  selectedSkillId: string | null
  selectedSkillDetail: SkillDetail | null
  selectedAgentId: string | null
  selectedAgentDetail: AgentDetail | null
  selectedProjectId: string | null
  selectedProjectDetail: ProjectDetail | null
  agents: AgentSummary[]
  projects: ProjectSummary[]
  issues: DiagnosisIssue[]
  unmanaged: UnmanagedItemDto[]
  filters: SkillFilters
  loading: boolean
  error: string | null
  busyAction: string | null
  lastPreview: DistributionPreview | null
  initialized: boolean
  agentDetailLoading: boolean
  projectDetailLoading: boolean
  startupScanInFlight: boolean
  lastOverviewLoadedAt: number
  customAgentDialogRequest: number
  updateStatus: SkillUpdateStatus | null
  updateChecking: boolean
  updateBusySkillId: string | null
}

interface SkillV2Actions {
  init: () => Promise<void>
  refresh: () => Promise<void>
  loadOverview: (force?: boolean) => Promise<void>
  setTab: (tab: SkillManagerTab) => void
  setInstallTab: (tab: SkillInstallTab) => void
  setViewMode: (mode: SkillViewMode) => void
  setFilter: <K extends keyof SkillFilters>(key: K, value: SkillFilters[K]) => void
  selectSkill: (id: string | null) => Promise<void>
  selectAgent: (id: string | null) => Promise<void>
  loadAgentDetail: (agentId: string, force?: boolean) => Promise<void>
  applyAgentSkillViewSnapshot: (expectedRuntimeEnvironmentId: string, agentId: string, snapshot: AgentSkillViewSnapshot) => boolean
  removeAgentSkillItems: (expectedRuntimeEnvironmentId: string, agentId: string, managedTargetIds: string[], unmanagedIds: string[]) => boolean
  loadProjects: (force?: boolean) => Promise<void>
  addProject: (rootPath: string) => Promise<void>
  removeProject: (projectId: string) => Promise<void>
  selectProject: (id: string | null) => Promise<void>
  scanProject: (projectId: string) => Promise<void>
  runDiagnosis: () => Promise<void>
  updateSettings: (patch: Partial<SkillManagerSettings>) => Promise<void>
  setBusy: (action: string | null) => void
  setError: (err: string | null) => void
  setLastPreview: (p: DistributionPreview | null) => void
  requestCustomAgentDialog: () => void
  loadUpdateStatus: () => Promise<void>
  checkAllUpdates: () => Promise<SkillUpdateCheckReport | null>
  updateSkill: (skillId: string, allowLocalOverwrite: boolean) => Promise<SkillUpdateRunResult>
  setSkillAutoUpdate: (skillId: string, enabled: boolean) => Promise<void>
  runPeriodicCheck: () => Promise<void>
}

export const useSkillStoreV2 = create<SkillV2State & SkillV2Actions>((set, get) => ({
  runtimeEnvironmentId: LOCAL_RUNTIME_ENVIRONMENT_ID,
  activeTab: 'library',
  activeInstallTab: 'git',
  viewMode: 'cards',
  overview: null,
  settings: null,
  skills: [],
  selectedSkillId: null,
  selectedSkillDetail: null,
  selectedAgentId: null,
  selectedAgentDetail: null,
  selectedProjectId: null,
  selectedProjectDetail: null,
  agents: [],
  projects: [],
  issues: [],
  unmanaged: [],
  filters: { query: '', source: '', status: '', type: '' },
  loading: false,
  error: null,
  busyAction: null,
  lastPreview: null,
  initialized: false,
  agentDetailLoading: false,
  projectDetailLoading: false,
  startupScanInFlight: false,
  lastOverviewLoadedAt: 0,
  customAgentDialogRequest: 0,
  updateStatus: null,
  updateChecking: false,
  updateBusySkillId: null,

  init: async () => {
    // Page entry should be cheap: bootstrap only ensures DB/dirs are usable,
    // then reads cached SQLite state. Startup scanning runs in the background
    // so opening the library is not blocked by walking every Agent skill dir.
    if (get().initialized) {
      if (!get().overview) await get().loadOverview(true)
      return
    }
    const runtimeEnvironmentId = get().runtimeEnvironmentId
    set({ loading: true, error: null })
    try {
      await skillApiV2.bootstrap()
      await get().loadOverview(true)
      await get().loadProjects(true)
      if (get().runtimeEnvironmentId !== runtimeEnvironmentId) return
      set({ initialized: true })

      if (get().settings?.startupScan && !get().startupScanInFlight) {
        set({ startupScanInFlight: true, busyAction: get().busyAction ?? 'startupScan' })
        void (async () => {
          try {
            await skillApiV2.init()
            await get().loadOverview(true)
          } catch (e) {
            if (get().runtimeEnvironmentId === runtimeEnvironmentId) {
              set({ error: String(e) })
            }
          } finally {
            if (get().runtimeEnvironmentId === runtimeEnvironmentId) {
              set((s) => ({
                startupScanInFlight: false,
                busyAction: s.busyAction === 'startupScan' ? null : s.busyAction,
              }))
            }
          }
        })()
      }
    } catch (e) {
      set({ error: String(e) })
    } finally {
      if (get().runtimeEnvironmentId === runtimeEnvironmentId) {
        set({ loading: false })
      }
    }
  },
  refresh: async () => {
    const runtimeEnvironmentId = get().runtimeEnvironmentId
    set({ loading: true, error: null })
    try {
      const overview = await skillApiV2.refreshOverview()
      const unmanaged = await skillApiV2.listUnmanaged()
      if (get().runtimeEnvironmentId !== runtimeEnvironmentId) return
      set({
        overview,
        skills: overview.skills,
        agents: overview.agents,
        issues: overview.issues,
        unmanaged,
        settings: overview.settings,
        lastOverviewLoadedAt: Date.now(),
      })
      await get().loadProjects(true)
      set({ initialized: true })
    } catch (e) {
      set({ error: String(e) })
    } finally {
      if (get().runtimeEnvironmentId === runtimeEnvironmentId) {
        set({ loading: false })
      }
    }
  },
  loadOverview: async (force = false) => {
    const runtimeEnvironmentId = get().runtimeEnvironmentId
    const now = Date.now()
    if (!force && get().overview && now - get().lastOverviewLoadedAt < OVERVIEW_CACHE_TTL_MS) {
      return
    }
    try {
      const overview = await skillApiV2.overview()
      const unmanaged = await skillApiV2.listUnmanaged()
      if (get().runtimeEnvironmentId !== runtimeEnvironmentId) return
      set({
        overview,
        skills: overview.skills,
        agents: overview.agents,
        issues: overview.issues,
        unmanaged,
        settings: overview.settings,
        lastOverviewLoadedAt: Date.now(),
        initialized: true,
      })
      void get().loadProjects()
    } catch (e) {
      set({ error: String(e) })
    }
  },
  setTab: (tab) => set({ activeTab: tab }),
  requestCustomAgentDialog: () => set((state) => ({
    customAgentDialogRequest: state.customAgentDialogRequest + 1,
  })),
  setInstallTab: (tab) => set({ activeInstallTab: tab }),
  setViewMode: (mode) => set({ viewMode: mode }),
  setFilter: (key, value) =>
    set((s) => ({ filters: { ...s.filters, [key]: value } })),
  selectSkill: async (id) => {
    const runtimeEnvironmentId = get().runtimeEnvironmentId
    set({ selectedSkillId: id, selectedSkillDetail: null })
    if (!id) return
    try {
      const detail = await skillApiV2.getSkillDetail(id)
      if (get().runtimeEnvironmentId !== runtimeEnvironmentId) return
      set({ selectedSkillDetail: detail })
    } catch (e) {
      set({ error: String(e) })
    }
  },
  selectAgent: async (id) => {
    if (id && get().selectedAgentId === id && get().selectedAgentDetail && !get().agentDetailLoading) {
      return
    }
    set({ selectedAgentId: id, selectedAgentDetail: null, agentDetailLoading: !!id })
    if (id) await get().loadAgentDetail(id)
    else set({ selectedAgentDetail: null })
  },
  loadAgentDetail: async (agentId, force = false) => {
    const runtimeEnvironmentId = get().runtimeEnvironmentId
    if (!force && get().selectedAgentId === agentId && get().selectedAgentDetail && !get().agentDetailLoading) {
      return
    }
    set({ agentDetailLoading: true })
    try {
      const detail = await skillApiV2.getAgentDetail(agentId)
      if (get().runtimeEnvironmentId !== runtimeEnvironmentId) return
      if (get().selectedAgentId === agentId) {
        set({ selectedAgentDetail: detail })
      }
    } catch (e) {
      if (get().selectedAgentId === agentId) {
        set({ error: String(e) })
      }
    } finally {
      if (
        get().runtimeEnvironmentId === runtimeEnvironmentId
        && get().selectedAgentId === agentId
      ) {
        set({ agentDetailLoading: false })
      }
    }
  },
  applyAgentSkillViewSnapshot: (expectedRuntimeEnvironmentId, agentId, snapshot) => {
    if (
      get().runtimeEnvironmentId !== expectedRuntimeEnvironmentId
      || get().selectedAgentId !== agentId
      || snapshot.agentDetail.id !== agentId
    ) {
      return false
    }
    const overview = snapshot.overview
    set({
      selectedAgentDetail: snapshot.agentDetail,
      agentDetailLoading: false,
      overview,
      skills: overview.skills,
      agents: overview.agents,
      issues: overview.issues,
      unmanaged: snapshot.unmanaged,
      settings: overview.settings,
      lastOverviewLoadedAt: Date.now(),
      initialized: true,
    })
    return true
  },
  removeAgentSkillItems: (expectedRuntimeEnvironmentId, agentId, managedTargetIds, unmanagedIds) => {
    const current = get()
    const detail = current.selectedAgentDetail
    if (
      current.runtimeEnvironmentId !== expectedRuntimeEnvironmentId
      || current.selectedAgentId !== agentId
      || detail?.id !== agentId
    ) {
      return false
    }

    const managedIds = new Set(managedTargetIds)
    const unmanagedIdSet = new Set(unmanagedIds)
    const managedTargets = [...detail.skills, ...detail.inheritedManagedSkills]
      .filter((target) => managedIds.has(target.id))
    const unmanagedItems = [...current.unmanaged, ...detail.inheritedUnmanagedSkills]
      .filter((item, index, items) => unmanagedIdSet.has(item.id) && items.findIndex((candidate) => candidate.id === item.id) === index)
    const removedTargetKeys = new Set(managedTargets.map((target) => `${target.skillId}\0${target.agentId}`))
    const managedCounts = new Map<string, number>()
    const unmanagedCounts = new Map<string, number>()
    managedTargets.forEach((target) => managedCounts.set(target.agentId, (managedCounts.get(target.agentId) || 0) + 1))
    unmanagedItems.forEach((item) => {
      if (item.agentId) unmanagedCounts.set(item.agentId, (unmanagedCounts.get(item.agentId) || 0) + 1)
    })

    const overview = current.overview
      ? {
          ...current.overview,
          metrics: {
            ...current.overview.metrics,
            targetCount: Math.max(0, current.overview.metrics.targetCount - managedTargets.length),
            unmanagedCount: Math.max(0, current.overview.metrics.unmanagedCount - unmanagedItems.length),
          },
          skills: current.overview.skills.map((skill) => ({
            ...skill,
            installedAgents: skill.installedAgents.filter((installed) => !removedTargetKeys.has(`${skill.id}\0${installed.agentId}`)),
          })),
          agents: current.overview.agents.map((agent) => ({
            ...agent,
            managedSkillCount: Math.max(0, agent.managedSkillCount - (managedCounts.get(agent.id) || 0)),
            unmanagedSkillCount: Math.max(0, agent.unmanagedSkillCount - (unmanagedCounts.get(agent.id) || 0)),
          })),
        }
      : null
    const skills = overview?.skills ?? current.skills.map((skill) => ({
      ...skill,
      installedAgents: skill.installedAgents.filter((installed) => !removedTargetKeys.has(`${skill.id}\0${installed.agentId}`)),
    }))
    const agents = overview?.agents ?? current.agents.map((agent) => ({
      ...agent,
      managedSkillCount: Math.max(0, agent.managedSkillCount - (managedCounts.get(agent.id) || 0)),
      unmanagedSkillCount: Math.max(0, agent.unmanagedSkillCount - (unmanagedCounts.get(agent.id) || 0)),
    }))

    set({
      selectedAgentDetail: {
        ...detail,
        skills: detail.skills.filter((target) => !managedIds.has(target.id)),
        inheritedManagedSkills: detail.inheritedManagedSkills.filter((target) => !managedIds.has(target.id)),
        inheritedUnmanagedSkills: detail.inheritedUnmanagedSkills.filter((item) => !unmanagedIdSet.has(item.id)),
      },
      overview,
      skills,
      agents,
      unmanaged: current.unmanaged.filter((item) => !unmanagedIdSet.has(item.id)),
    })
    return true
  },
  loadProjects: async () => {
    const runtimeEnvironmentId = get().runtimeEnvironmentId
    try {
      const projects = await skillApiV2.listProjects()
      if (get().runtimeEnvironmentId !== runtimeEnvironmentId) return
      set({ projects })
      const selectedProjectId = get().selectedProjectId
      if (selectedProjectId && !projects.some((project) => project.id === selectedProjectId)) {
        set({ selectedProjectId: null, selectedProjectDetail: null })
      }
    } catch (e) {
      set({ error: String(e) })
    }
  },
  addProject: async (rootPath) => {
    const runtimeEnvironmentId = get().runtimeEnvironmentId
    set({ projectDetailLoading: true, error: null })
    try {
      const detail = await skillApiV2.addProject(rootPath)
      const projects = await skillApiV2.listProjects()
      if (get().runtimeEnvironmentId !== runtimeEnvironmentId) return
      set({
        projects,
        selectedProjectId: detail.id,
        selectedProjectDetail: detail,
      })
    } catch (e) {
      set({ error: String(e) })
    } finally {
      if (get().runtimeEnvironmentId === runtimeEnvironmentId) {
        set({ projectDetailLoading: false })
      }
    }
  },
  removeProject: async (projectId) => {
    const runtimeEnvironmentId = get().runtimeEnvironmentId
    try {
      await skillApiV2.removeProject(projectId)
      const projects = await skillApiV2.listProjects()
      if (get().runtimeEnvironmentId !== runtimeEnvironmentId) return
      set((s) => ({
        projects,
        selectedProjectId: s.selectedProjectId === projectId ? null : s.selectedProjectId,
        selectedProjectDetail: s.selectedProjectId === projectId ? null : s.selectedProjectDetail,
      }))
    } catch (e) {
      set({ error: String(e) })
    }
  },
  selectProject: async (id) => {
    const runtimeEnvironmentId = get().runtimeEnvironmentId
    if (id && get().selectedProjectId === id && get().selectedProjectDetail && !get().projectDetailLoading) {
      return
    }
    set({ selectedProjectId: id, selectedProjectDetail: null, projectDetailLoading: !!id })
    if (!id) {
      set({ selectedProjectDetail: null, projectDetailLoading: false })
      return
    }
    try {
      const detail = await skillApiV2.getProjectDetail(id)
      if (get().runtimeEnvironmentId !== runtimeEnvironmentId) return
      set({ selectedProjectDetail: detail })
    } catch (e) {
      set({ error: String(e) })
    } finally {
      if (get().runtimeEnvironmentId === runtimeEnvironmentId) {
        set({ projectDetailLoading: false })
      }
    }
  },
  scanProject: async (projectId) => {
    const runtimeEnvironmentId = get().runtimeEnvironmentId
    set({ projectDetailLoading: true, error: null })
    try {
      const detail = await skillApiV2.scanProject(projectId)
      const projects = await skillApiV2.listProjects()
      if (get().runtimeEnvironmentId !== runtimeEnvironmentId) return
      set({
        projects,
        selectedProjectId: detail.id,
        selectedProjectDetail: detail,
      })
    } catch (e) {
      set({ error: String(e) })
    } finally {
      if (get().runtimeEnvironmentId === runtimeEnvironmentId) {
        set({ projectDetailLoading: false })
      }
    }
  },
  runDiagnosis: async () => {
    const runtimeEnvironmentId = get().runtimeEnvironmentId
    set({ busyAction: 'diagnosis' })
    try {
      const issues = await skillApiV2.runDiagnosis()
      const unmanaged = await skillApiV2.listUnmanaged()
      if (get().runtimeEnvironmentId !== runtimeEnvironmentId) return
      set({ issues, unmanaged, lastOverviewLoadedAt: 0 })
    } catch (e) {
      set({ error: String(e) })
    } finally {
      if (get().runtimeEnvironmentId === runtimeEnvironmentId) {
        set({ busyAction: null })
      }
    }
  },
  updateSettings: async (patch) => {
    const runtimeEnvironmentId = get().runtimeEnvironmentId
    try {
      const next = await skillApiV2.updateSettings(patch)
      if (get().runtimeEnvironmentId !== runtimeEnvironmentId) return
      set({ settings: next })
    } catch (e) {
      set({ error: String(e) })
    }
  },
  setBusy: (action) => set({ busyAction: action }),
  setError: (err) => set({ error: err }),
  setLastPreview: (p) => set({ lastPreview: p }),
  loadUpdateStatus: async () => {
    const runtimeEnvironmentId = get().runtimeEnvironmentId
    try {
      const status = await skillApiV2.skillUpdateStatus()
      if (get().runtimeEnvironmentId !== runtimeEnvironmentId) return
      set({ updateStatus: status })
    } catch {
      // The update panel is secondary; a failure here must not blank the page.
    }
  },
  checkAllUpdates: async () => {
    const runtimeEnvironmentId = get().runtimeEnvironmentId
    set({ updateChecking: true, error: null })
    try {
      const report = await skillApiV2.checkAllSkillUpdates()
      if (get().runtimeEnvironmentId !== runtimeEnvironmentId) return null
      set((state) => ({
        updateStatus: {
          periodicCheckEnabled: state.updateStatus?.periodicCheckEnabled ?? false,
          lastCheckedAt: report.checkedAt,
          report,
          autoUpdateSkillIds: state.updateStatus?.autoUpdateSkillIds ?? [],
        },
      }))
      return report
    } catch (error) {
      set({ error: String(error) })
      return null
    } finally {
      if (get().runtimeEnvironmentId === runtimeEnvironmentId) {
        set({ updateChecking: false })
      }
    }
  },
  updateSkill: async (skillId, allowLocalOverwrite) => {
    const runtimeEnvironmentId = get().runtimeEnvironmentId
    set({ updateBusySkillId: skillId, error: null })
    try {
      const result = await skillApiV2.updateSkillFromSource(skillId, allowLocalOverwrite)
      if (get().runtimeEnvironmentId === runtimeEnvironmentId) {
        await get().loadOverview(true)
        await get().loadUpdateStatus()
      }
      return result
    } finally {
      if (get().runtimeEnvironmentId === runtimeEnvironmentId) {
        set({ updateBusySkillId: null })
      }
    }
  },
  setSkillAutoUpdate: async (skillId, enabled) => {
    const runtimeEnvironmentId = get().runtimeEnvironmentId
    try {
      const status = await skillApiV2.setSkillAutoUpdate(skillId, enabled)
      if (get().runtimeEnvironmentId !== runtimeEnvironmentId) return
      set({ updateStatus: status })
    } catch (error) {
      set({ error: String(error) })
    }
  },
  runPeriodicCheck: async () => {
    const runtimeEnvironmentId = get().runtimeEnvironmentId
    try {
      const result = await skillApiV2.runPeriodicSkillUpdateCheck()
      if (get().runtimeEnvironmentId !== runtimeEnvironmentId) return
      if (result.ran) {
        await get().loadUpdateStatus()
        await get().loadOverview(true)
      }
    } catch {
      // A startup check is best-effort and must never surface an error bubble.
    }
  },
}))

/** The three origins every Skill falls into exactly one of. */
export type SkillSourceCategory = 'custom' | 'github' | 'agent'

export const SKILL_SOURCE_CATEGORIES: SkillSourceCategory[] = ['custom', 'github', 'agent']

export function isGitHubSkillSource(
  skill: Pick<SkillSummary, 'sourceType' | 'sourceUri'>,
): boolean {
  const sourceType = skill.sourceType?.toLowerCase()
  const sourceUri = skill.sourceUri ?? ''
  return sourceType === 'github' || sourceUri.startsWith('github:') || sourceUri.includes('github.com/')
}

export function skillSourceCategory(
  skill: Pick<SkillSummary, 'sourceType' | 'sourceUri'>,
): SkillSourceCategory {
  if (isGitHubSkillSource(skill)) return 'github'
  if (skill.sourceType === 'agent_import') return 'agent'
  return 'custom'
}

/** Agents whose own program was detected. When the backend has not reported a
 *  program state yet, fall back to the legacy "installed" flag (config or
 *  program) so missing data never hides a real installation. */
export function agentProgramDetected(agent: {
  programInstalled?: boolean
  installed: boolean
}): boolean {
  return agent.programInstalled ?? agent.installed
}

export function splitAgentsByProgram<T extends { programInstalled?: boolean; installed: boolean }>(
  agents: T[],
): { detected: T[]; hidden: T[] } {
  const detected: T[] = []
  const hidden: T[] = []
  for (const agent of agents) {
    if (agentProgramDetected(agent)) detected.push(agent)
    else hidden.push(agent)
  }
  return { detected, hidden }
}

export function filteredSkills(state: SkillV2State): SkillSummary[] {
  const { skills, filters } = state
  return filterSkillsByQuery(skills, filters.query).filter((s) => {
    if (filters.status && s.status !== filters.status) return false
    if (filters.source && skillSourceCategory(s) !== filters.source) return false
    if (filters.type && s.skillType !== filters.type) return false
    return true
  })
}

export function filterSkillsByQuery(skills: SkillSummary[], query: string): SkillSummary[] {
  const q = query.trim().toLowerCase()
  if (!q) return skills
  return skills.filter((s) => {
    const haystack = [
      s.name,
      s.description,
      s.sourceType,
      s.status,
      skillStatusSearchLabel(s.status),
      s.installedAgents.map((a) => a.displayName).join(' '),
      s.installedAgents.map((a) => a.status).join(' '),
      s.installedAgents.map((a) => targetStatusSearchLabel(a.status)).join(' '),
      hasChangedCopyInstall(s) ? 'diff 副本分叉 副本变更 副本已修改 已修改' : '',
    ]
      .join(' ')
      .toLowerCase()
    return haystack.includes(q)
  })
}

function hasChangedCopyInstall(skill: SkillSummary): boolean {
  return skill.installedAgents.some((agent) => (
    agent.mode === 'copy'
    && ['copy_modified', 'copy_diverged', 'copy_outdated', 'copyDiverged'].includes(agent.status)
  ))
}

function skillStatusSearchLabel(status: string): string {
  const labels: Record<string, string> = {
    ok: '正常',
    conflict: '冲突',
    copyDiverged: '副本分叉',
    updateAvailable: '可更新',
    unmanaged: '未管理',
  }
  return labels[status] || status
}

function targetStatusSearchLabel(status: string): string {
  const labels: Record<string, string> = {
    ok: '正常',
    conflict: '冲突',
    copy_outdated: '可更新 副本可更新',
    copy_modified: '已修改 副本已修改 副本分叉',
    copy_diverged: '已分叉 副本分叉',
    copyDiverged: '副本分叉',
    broken_link: '坏链接',
    missing: '失效',
  }
  return labels[status] || status
}
