import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { isTauri as isTauriRuntime } from './tauriApi'

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return tauriInvoke<T>(command, args)
}

// ── Skill Manager v2 DTO types ────────────────────────────────────

export interface SkillManagerMetrics {
  centerSkillCount: number
  targetCount: number
  unmanagedCount: number
  issueCount: number
}

export interface SkillManagerSettings {
  centerPath: string
  sqlitePath: string
  defaultDistributeMode: 'link' | 'copy'
  linkFailPolicy: 'ask' | 'copy'
  startupScan: boolean
  showUnmanaged: boolean
  autoSyncSkillPacks?: boolean
}

export interface InstalledAgentRef {
  agentId: string
  displayName: string
  iconKey: string
  mode: 'link' | 'copy'
  status: string
}

export interface SkillSummary {
  id: string
  name: string
  description: string
  skillType: string
  sourceType: string
  sourceUri: string | null
  centerPath: string
  currentHash: string
  status: 'ok' | 'updateAvailable' | 'conflict' | 'unmanaged' | 'copyDiverged' | string
  installedAgents: InstalledAgentRef[]
}

export interface TargetClaim {
  id: string
  claimType: 'direct' | 'pack'
  packId: string | null
  packName: string | null
  createdAt: string
}

export interface SkillSourceDetail {
  sourceType: string
  sourceUri: string | null
  sourceRef: string | null
  importedFromAgent: string | null
  importedFromPath: string | null
  installedVia: string
  createdAt: string
  updatedAt: string
}

export interface SkillTargetDetail {
  id: string
  skillId: string
  agentId: string
  targetPath: string
  resolvedTargetPath: string | null
  installMode: 'link' | 'copy'
  actualMode: 'link' | 'copy'
  sourceHash: string
  currentHash: string | null
  status: string
  createdAt: string
  updatedAt: string
  claims: TargetClaim[]
}

export interface FileTreeNode {
  name: string
  nodeType: 'file' | 'dir'
  path: string
  children: FileTreeNode[] | null
}

export interface SkillDetail extends SkillSummary {
  centerResolvedPath?: string | null
  frontmatter: Record<string, string>
  files: FileTreeNode | null
  targets: SkillTargetDetail[]
  source: SkillSourceDetail | null
}

export interface SkillExplanation {
  skillId: string
  lang: string
  model: string
  text: string
  cachedAt: string
  fromCache: boolean
}

export interface AgentSummary {
  id: string
  displayName: string
  iconKey: string
  enabled: boolean
  skillsDir: string | null
  version: string | null
  latestVersion: string | null
  installed: boolean
  managedSkillCount: number
  unmanagedSkillCount: number
  readOnlySkillCount?: number
}

export interface AgentSummaryLite {
  id: string
  displayName: string
  iconKey: string
}

export interface SkillPackSummary {
  id: string
  name: string
  description: string
  tags: string[]
  memberCount: number
  appliedAgentCount: number
  healthy: boolean
  revision?: number
  syncStatus?: 'synced' | 'pending' | 'syncing' | 'failed' | 'partial' | string
  pendingSyncCount?: number
  failedSyncCount?: number
}

export interface PackMember {
  skillId: string
  skillName: string
  required: boolean
  sortOrder: number
  missing: boolean
}

export interface AppliedPackSummary {
  packId: string
  packName: string
  memberCount: number
  agentId?: string | null
  displayName?: string | null
  iconKey?: string | null
  packRevision?: number
  syncedRevision?: number
  syncStatus?: 'synced' | 'pending' | 'syncing' | 'failed' | 'partial' | string
  syncError?: string | null
}

export interface SkillPackDetail {
  id: string
  name: string
  description: string
  tags: string[]
  members: PackMember[]
  appliedAgents: AppliedPackSummary[]
  revision?: number
  syncStatus?: 'synced' | 'pending' | 'syncing' | 'failed' | 'partial' | string
  pendingSyncCount?: number
  failedSyncCount?: number
  createdAt: string
  updatedAt: string
}

export interface AgentHealthIssue {
  kind: string
  message: string
  severity: string
}

export interface AgentDetail {
  id: string
  displayName: string
  iconKey: string
  version: string | null
  latestVersion: string | null
  skillsDir: string | null
  configPath: string | null
  agentDir?: string | null
  skills: SkillTargetDetail[]
  inheritsSharedSkills?: boolean
  inheritedManagedSkills: SkillTargetDetail[]
  inheritedUnmanagedSkills: UnmanagedItemDto[]
  appliedPacks: AppliedPackSummary[]
  availablePacks: SkillPackSummary[]
  health: AgentHealthIssue[]
}

export interface AgentConfigDocument {
  path: string
  content: string
  revision: string
}

export interface SkillManagerOverview {
  metrics: SkillManagerMetrics
  skills: SkillSummary[]
  agents: AgentSummary[]
  packs: SkillPackSummary[]
  issues: DiagnosisIssue[]
  settings: SkillManagerSettings
}

export interface AgentSkillViewSnapshot {
  agentDetail: AgentDetail
  overview: SkillManagerOverview
  unmanaged: UnmanagedItemDto[]
}

export interface SkillPackPickerData {
  agents: AgentSummary[]
  packs: SkillPackSummary[]
  appliedByAgent: Record<string, string[]>
  defaultDistributeMode: 'link' | 'copy'
}

export interface ProjectSummary {
  id: string
  name: string
  rootPath: string
  createdAt: string
  updatedAt: string
  lastScannedAt: string | null
  detectedAgentCount: number
  skillCount: number
  instructionCount: number
  issueCount: number
}

export interface ProjectSkillItem {
  id: string
  name: string
  description: string
  agentId: string
  path: string
  hash: string
  status: 'projectOnly' | 'centerSynced' | 'centerDiff' | string
  importable: boolean
}

export interface ProjectInstructionFile {
  agentId: string
  path: string
  exists: boolean
  bytes: number | null
}

export interface ProjectHealthIssue {
  agentId: string | null
  kind: string
  message: string
  severity: 'info' | 'warning' | 'error' | string
}

export interface ProjectAgentDetail {
  agentId: string
  displayName: string
  iconKey: string
  skillsDirs: string[]
  configPaths: string[]
  skills: ProjectSkillItem[]
  health: ProjectHealthIssue[]
}

export interface ProjectDetail extends ProjectSummary {
  agents: ProjectAgentDetail[]
  instructions: ProjectInstructionFile[]
  health: ProjectHealthIssue[]
}

export interface ConflictBlocker {
  skillId: string
  agentId: string
  reason: string
  existingPath: string | null
  existingPathKind?: 'symlink' | 'directory' | 'file' | 'broken_symlink' | 'missing' | string | null
  resolvedExistingPath?: string | null
}

export interface DistributionChange {
  skillId: string
  agentId: string
  action: 'create' | 'reuse' | 'appendClaim' | 'skip' | 'blocked' | 'overwrite' | string
  actualMode?: 'link' | 'copy'
  reason?: string
  targetPath: string
}

export interface DistributionBlockerDecision {
  skillId: string
  agentId: string
  action: 'overwrite' | 'agent_over_center' | 'skip'
}

export interface DistributionPreview {
  skillIds: string[]
  targetAgents: string[]
  requestedMode: 'link' | 'copy'
  changes: DistributionChange[]
  blockers: ConflictBlocker[]
  blockerDecisions: DistributionBlockerDecision[]
}

export interface AddCenterSkillInput {
  sourcePath: string
  sourceType: string
  sourceUri?: string | null
  importedFromAgent?: string | null
  importedFromPath?: string | null
  multi?: boolean
  importMode?: 'copy' | 'link'
}

export interface AddCenterSkillCandidate {
  skillId: string
  proposedSkillId: string
  name: string
  description: string
  sourceDir: string
  hash: string
  action: 'create' | 'update' | 'blocked_same_name_diff_source' | string
  existingSourceType: string | null
  reason: string | null
}

export interface AddCenterSkillPreview {
  candidates: AddCenterSkillCandidate[]
  blockers: AddCenterSkillCandidate[]
  unchangedCount?: number
  centerPath: string
}

export interface AddCenterSkillDecision {
  skillId: string
  proposedSkillId?: string | null
  resolution: 'create' | 'update' | 'skip'
}

export interface AddCenterSkillResult {
  skillIds: string[]
  updated: string[]
  skipped: string[]
}

export interface AffectedTarget {
  targetId: string
  agentId: string
  displayName: string
  targetPath: string
  mode: string
  claimCount: number
}

export interface DeleteCenterSkillPreview {
  skillId: string
  skillIds?: string[]
  affectedTargets: AffectedTarget[]
  removable: boolean
  warnings: string[]
}

export interface DeleteSkillPackPreview {
  packId: string
  packName: string
  appliedAgents: string[]
  affectedTargets: AffectedTarget[]
  removable: boolean
  warnings: string[]
}

export interface DeleteSkillTargetDistributionFailure {
  targetId: string
  error: string
}

export interface DeleteSkillTargetDistributionsResult {
  deleted: number
  failures: DeleteSkillTargetDistributionFailure[]
}

export interface DeleteUnmanagedAgentSkillFailure {
  unmanagedId: string
  error: string
}

export interface DeleteUnmanagedAgentSkillsResult {
  deleted: number
  failures: DeleteUnmanagedAgentSkillFailure[]
}

export interface RemovePackFromAgentPreview {
  packId: string
  packName: string
  agentId: string
  displayName: string
  affectedTargets: AffectedTarget[]
  willRemoveTargets: number
  willPreserveTargets: number
}

export interface RemoveSkillFromPackPreview {
  packId: string
  packName: string
  skillId: string
  skillName: string
  affectedTargets: AffectedTarget[]
  appliedAgentCount: number
  canKeepStandalone: boolean
  canRemoveTargets: boolean
}

export interface MoveDirectSkillToPackPreview {
  targetId: string
  skillId: string
  skillName: string
  agentId: string
  displayName: string
  packId: string
  packName: string
  alreadyMember: boolean
  alreadyApplied: boolean
  willAddToPack: boolean
  otherMemberCount: number
  distribution: DistributionPreview
}

export interface SkillPackSyncAgentResult {
  agentId: string
  displayName: string
  status: 'synced' | 'failed' | string
  error: string | null
}

export interface SkillPackSyncResult {
  packId: string
  packName: string
  revision: number
  status: 'synced' | 'pending' | 'failed' | 'partial' | string
  agents: SkillPackSyncAgentResult[]
}

export interface UnmanagedItemDto {
  id: string
  itemType: string
  agentId: string | null
  path: string
  inferredSkillId: string | null
  hash: string | null
  reason: string
  readOnly?: boolean
}

export interface AgentSkillInventoryItem {
  id: string
  agentId: string
  skillId: string
  name: string
  path: string
  managed: boolean
  readOnly?: boolean
  canImport: boolean
  status: string
  statusLabel: string
  reason: string | null
  targetId: string | null
  actualMode: string | null
  hash: string | null
}

export interface AgentSkillInventoryAgent {
  agentId: string
  displayName: string
  iconKey: string
  skillsDir: string | null
  installed: boolean
  managedCount: number
  unmanagedCount: number
  readOnlyCount?: number
  importableCount: number
  items: AgentSkillInventoryItem[]
}

export interface DiagnosisAction {
  id: string
  label: string
  destructive: boolean
}

export interface DiagnosisIssue {
  id: string
  issueType: string
  severity: 'info' | 'warning' | 'error'
  fixKind: 'auto' | 'confirm' | 'manual' | 'info'
  title: string
  detail: string
  entityType: 'skill' | 'target' | 'pack' | 'agent' | 'snapshot'
  entityId: string | null
  actions: DiagnosisAction[]
}

export interface AdoptOption {
  value: string
  label: string
  destructive: boolean
}

export interface AdoptPreview {
  agentId: string
  unmanagedId: string
  skillPath: string
  inferredSkillId: string
  hash: string
  centerHasSameId: boolean
  canQuickAdopt: boolean
  options: AdoptOption[]
}

export interface AdoptBatchItem {
  agentId: string
  unmanagedId: string
  option: string
  renamedId: string | null
}

export interface AdoptBatchItemResult {
  unmanagedId: string
  skillId: string | null
  error: string | null
}

export interface AdoptBatchResult {
  items: AdoptBatchItemResult[]
  finalizationError: string | null
}

export interface CopySyncPreview {
  targetId: string
  skillId: string
  targetPath: string
  sourceHash: string
  centerHash: string
  copyHash: string
  state: 'ok' | 'copy_outdated' | 'copy_modified' | 'copy_diverged' | string
  suggested: 'none' | 'center_over_agent' | 'agent_over_center' | 'manual' | string
}

export interface CopyTargetDiffFile {
  path: string
  changeType: 'modified' | 'copy_added' | 'copy_removed' | string
  centerContent: string | null
  copyContent: string | null
}

export interface CopyTargetDiffPreview {
  targetId: string
  skillId: string
  targetPath: string
  centerPath: string
  state: 'ok' | 'copy_outdated' | 'copy_modified' | 'copy_diverged' | string
  files: CopyTargetDiffFile[]
}

export interface RevokeResult {
  packId: string
  agentId: string
  removedClaims: number
  removedTargets: number
  preservedTargets: number
}

export interface UpsertPackInput {
  id: string
  name: string
  description: string
  tags: string[]
  skillIds: string[]
}

export interface GitHubRepoPreview {
  repo: {
    owner: string
    repo: string
    branch: string
    normalizedUrl: string
  }
  skills: Array<{
    sourcePath: string
    skillId: string
    skillName: string
    description: string | null
    rootDirectory: string
    skillDirectoryName: string
    downloadUrl: string
    conflict: {
      existingSkillId: string
      existingName: string
      existingCanonicalPath: string | null
      proposedSkillId: string
      proposedName: string
    } | null
  }>
}

export interface GitHubSkillImportSelection {
  sourcePath: string
  resolution: 'overwrite' | 'skip' | 'rename'
  renamedSkillId?: string | null
}

export interface GitHubRepoImportResult {
  repo: GitHubRepoPreview['repo']
  importedSkills: Array<{
    sourcePath: string
    originalSkillId: string
    importedSkillId: string
    skillName: string
    targetDirectory: string
    resolution: string
  }>
  skippedSkills: string[]
}

export interface GitHubSkillUpdatePreview {
  skillId: string
  sourceUri: string
  localHash: string
  remoteHash: string
  updateAvailable: boolean
  checkedAt: string
}

export interface GitHubSkillSyncResult {
  skillId: string
  sourceUri: string
  previousHash: string
  currentHash: string
  updated: boolean
  syncedAt: string
}

export const skillApiV2 = {
  bootstrap: () => (isTauriRuntime() ? invoke<void>('skill_manager_bootstrap') : Promise.resolve()),
  init: () => (isTauriRuntime() ? invoke<void>('skill_manager_init') : Promise.resolve()),
  overview: () =>
    isTauriRuntime()
      ? invoke<SkillManagerOverview>('skill_manager_overview')
      : Promise.resolve(demoOverview()),
  getSkillPackPickerData: (): Promise<SkillPackPickerData> => {
    if (isTauriRuntime()) return invoke<SkillPackPickerData>('skill_pack_picker_data')
    const overview = demoOverview()
    return Promise.resolve({
      agents: overview.agents,
      packs: overview.packs,
      appliedByAgent: {} as Record<string, string[]>,
      defaultDistributeMode: overview.settings.defaultDistributeMode,
    })
  },
  refresh: () => (isTauriRuntime() ? invoke<void>('skill_manager_refresh') : Promise.resolve()),
  refreshOverview: () =>
    isTauriRuntime()
      ? invoke<SkillManagerOverview>('skill_manager_refresh_overview')
      : Promise.resolve(demoOverview()),
  getSettings: () =>
    isTauriRuntime()
      ? invoke<SkillManagerSettings>('skill_manager_settings')
      : Promise.resolve({
          centerPath: '~/.agents/skills',
          sqlitePath: '~/.vibeboard/skill-manager/skill-manager.db',
          defaultDistributeMode: 'link' as const,
          linkFailPolicy: 'ask' as const,
          startupScan: true,
          showUnmanaged: true,
        }),
  updateSettings: (patch: Partial<SkillManagerSettings>) =>
    isTauriRuntime()
      ? invoke<SkillManagerSettings>('skill_manager_update_settings', {
          update: {
            sqlitePath: patch.sqlitePath ?? null,
            defaultDistributeMode: patch.defaultDistributeMode ?? null,
            linkFailPolicy: patch.linkFailPolicy ?? null,
            startupScan: patch.startupScan ?? null,
            showUnmanaged: patch.showUnmanaged ?? null,
          },
        })
      : Promise.resolve({} as SkillManagerSettings),

  listCenterSkills: () =>
    isTauriRuntime() ? invoke<SkillSummary[]>('list_center_skills_v2') : Promise.resolve([]),
  getSkillDetail: (skillId: string) =>
    isTauriRuntime() ? invoke<SkillDetail>('get_skill_detail_v2', { skillId }) : Promise.resolve(null as unknown as SkillDetail),
  readFileTree: (skillPath: string) =>
    isTauriRuntime()
      ? invoke<FileTreeNode>('read_skill_files', { skillPath })
      : Promise.resolve({
          name: skillPath.split(/[\\/]+/).filter(Boolean).pop() || 'skill',
          nodeType: 'dir' as const,
          path: skillPath,
          children: [
            {
              name: 'SKILL.md',
              nodeType: 'file' as const,
              path: `${skillPath}/SKILL.md`,
              children: null,
            },
          ],
        }),
  readFileContent: (filePath: string) =>
    isTauriRuntime() ? invoke<string>('read_skill_file_content', { filePath }) : Promise.resolve(''),
  getSkillExplanation: (skillId: string, lang: string) =>
    isTauriRuntime() ? invoke<SkillExplanation | null>('get_skill_explanation_cmd', { skillId, lang }) : Promise.resolve(null),
  generateSkillExplanation: (skillId: string, skillPath: string, lang: string, refresh = false) =>
    isTauriRuntime()
      ? invoke<SkillExplanation>('generate_skill_explanation_cmd', { skillId, skillPath, lang, refresh })
      : Promise.resolve({
          skillId,
          lang,
          model: 'demo',
          text: '解释生成功能需要在 Tauri 应用中使用。',
          cachedAt: new Date().toISOString(),
          fromCache: false,
        }),

  previewAddCenterSkill: (input: AddCenterSkillInput) =>
    isTauriRuntime()
      ? invoke<AddCenterSkillPreview>('preview_add_center_skill', { input })
      : Promise.resolve({ candidates: [], blockers: [], unchangedCount: 0, centerPath: '' }),
  executeAddCenterSkill: (input: AddCenterSkillInput, decisions: AddCenterSkillDecision[]) =>
    isTauriRuntime()
      ? invoke<AddCenterSkillResult>('execute_add_center_skill', { input, decisions })
      : Promise.resolve({ skillIds: [], updated: [], skipped: [] }),
  checkGitHubSkillUpdate: (skillId: string) =>
    isTauriRuntime()
      ? invoke<GitHubSkillUpdatePreview>('check_github_skill_update', { skillId })
      : Promise.resolve({
          skillId,
          sourceUri: '',
          localHash: '',
          remoteHash: '',
          updateAvailable: false,
          checkedAt: new Date().toISOString(),
        }),
  syncGitHubSkill: (skillId: string) =>
    isTauriRuntime()
      ? invoke<GitHubSkillSyncResult>('sync_github_skill', { skillId })
      : Promise.resolve({
          skillId,
          sourceUri: '',
          previousHash: '',
          currentHash: '',
          updated: false,
          syncedAt: new Date().toISOString(),
        }),
  previewGitHubRepoImport: (repoUrl: string, githubToken?: string) =>
    isTauriRuntime()
      ? invoke<GitHubRepoPreview>('preview_github_repo_import', {
          repoUrl,
          githubToken: githubToken?.trim() || null,
        })
      : Promise.resolve({ repo: { owner: '', repo: '', branch: 'HEAD', normalizedUrl: repoUrl }, skills: [] }),
  importGitHubRepoSkills: (repoUrl: string, selections: GitHubSkillImportSelection[], githubToken?: string) =>
    isTauriRuntime()
      ? invoke<GitHubRepoImportResult>('import_github_repo_skills', {
          repoUrl,
          selections,
          githubToken: githubToken?.trim() || null,
        })
      : Promise.resolve({
          repo: { owner: '', repo: '', branch: 'HEAD', normalizedUrl: repoUrl },
          importedSkills: [],
          skippedSkills: selections.filter(item => item.resolution === 'skip').map(item => item.sourcePath),
        }),

  previewDeleteCenterSkill: (skillId: string) =>
    isTauriRuntime()
      ? invoke<DeleteCenterSkillPreview>('preview_delete_center_skill', { skillId })
      : Promise.resolve({ skillId, skillIds: [skillId], affectedTargets: [], removable: true, warnings: [] }),
  executeDeleteCenterSkill: (skillId: string, removeLinked: boolean) =>
    isTauriRuntime()
      ? invoke<void>('execute_delete_center_skill', { skillId, removeLinked })
      : Promise.resolve(),
  previewDeleteCenterSkills: (skillIds: string[]) =>
    isTauriRuntime()
      ? invoke<DeleteCenterSkillPreview>('preview_delete_center_skills', { skillIds })
      : Promise.resolve({ skillId: skillIds[0] ?? '', skillIds, affectedTargets: [], removable: true, warnings: [] }),
  executeDeleteCenterSkills: (skillIds: string[], removeLinked: boolean) =>
    isTauriRuntime()
      ? invoke<void>('execute_delete_center_skills', { skillIds, removeLinked })
      : Promise.resolve(),

  previewDistribute: (skillIds: string[], targetAgents: string[], requestedMode: 'link' | 'copy') =>
    isTauriRuntime()
      ? invoke<DistributionPreview>('preview_distribute_skill', { skillIds, targetAgents, requestedMode })
      : Promise.resolve({ skillIds, targetAgents, requestedMode, changes: [], blockers: [], blockerDecisions: [] }),
  executeDistribute: (preview: DistributionPreview) =>
    isTauriRuntime() ? invoke<DistributionPreview>('execute_distribute_skill', { preview }) : Promise.resolve(preview),

  scanAgentInventory: (agentId: string) =>
    isTauriRuntime()
      ? invoke<{
          agentId: string
          managed: number
          unmanaged: number
          readOnly?: number
          includedShared?: boolean
          sharedManaged?: number
          sharedUnmanaged?: number
          sharedReadOnly?: number
        }>('scan_agent_inventory', { agentId })
      : Promise.resolve({
          agentId,
          managed: 0,
          unmanaged: 0,
          readOnly: 0,
          includedShared: false,
          sharedManaged: 0,
          sharedUnmanaged: 0,
          sharedReadOnly: 0,
        }),

  previewAdopt: (agentId: string, unmanagedId: string) =>
    isTauriRuntime() ? invoke<AdoptPreview>('preview_adopt_agent_skill', { agentId, unmanagedId }) : Promise.resolve(null as unknown as AdoptPreview),
  executeAdopt: (agentId: string, unmanagedId: string, option: string, renamedId?: string | null) =>
    isTauriRuntime() ? invoke<string>('execute_adopt_agent_skill', { agentId, unmanagedId, option, renamedId: renamedId ?? null }) : Promise.resolve(''),
  executeAdoptBatch: (items: AdoptBatchItem[]) =>
    isTauriRuntime()
      ? invoke<AdoptBatchResult>('execute_adopt_agent_skills', { items })
      : Promise.resolve({
        items: items.map((item) => ({ unmanagedId: item.unmanagedId, skillId: '', error: null })),
        finalizationError: null,
      }),
  takeoverCenterSkills: (agentId: string, unmanagedIds: string[]) =>
    isTauriRuntime()
      ? invoke<AdoptBatchResult>('takeover_center_agent_skills', { agentId, unmanagedIds })
      : Promise.resolve({
        items: unmanagedIds.map((unmanagedId) => ({ unmanagedId, skillId: '', error: null })),
        finalizationError: null,
      }),
  deleteUnmanagedAgentSkill: (agentId: string, unmanagedId: string) =>
    isTauriRuntime() ? invoke<void>('delete_unmanaged_agent_skill', { agentId, unmanagedId }) : Promise.resolve(),
  deleteUnmanagedAgentSkills: (agentId: string, unmanagedIds: string[]) =>
    isTauriRuntime()
      ? invoke<DeleteUnmanagedAgentSkillsResult>('delete_unmanaged_agent_skills', { agentId, unmanagedIds })
      : Promise.resolve({ deleted: unmanagedIds.length, failures: [] }),

  previewSyncCopy: (targetId: string) =>
    isTauriRuntime() ? invoke<CopySyncPreview>('preview_sync_copy_target', { targetId }) : Promise.resolve(null as unknown as CopySyncPreview),
  previewCopyTargetDiff: (targetId: string) =>
    isTauriRuntime() ? invoke<CopyTargetDiffPreview>('preview_copy_target_diff', { targetId }) : Promise.resolve(null as unknown as CopyTargetDiffPreview),
  executeSyncCopy: (targetId: string, action: string) =>
    isTauriRuntime() ? invoke<CopySyncPreview>('execute_sync_copy_target', { targetId, action }) : Promise.resolve(null as unknown as CopySyncPreview),
  deleteSkillTargetDistribution: (targetId: string) =>
    isTauriRuntime() ? invoke<void>('delete_skill_target_distribution', { targetId }) : Promise.resolve(),
  deleteSkillTargetDistributions: (targetIds: string[]) =>
    isTauriRuntime()
      ? invoke<DeleteSkillTargetDistributionsResult>('delete_skill_target_distributions', { targetIds })
      : Promise.resolve({ deleted: targetIds.length, failures: [] }),

  listPacks: () => (isTauriRuntime() ? invoke<SkillPackSummary[]>('list_skill_packs_v2') : Promise.resolve([])),
  getPackDetail: (packId: string) =>
    isTauriRuntime() ? invoke<SkillPackDetail>('get_skill_pack_detail', { packId }) : Promise.resolve(null as unknown as SkillPackDetail),
  upsertPack: (pack: UpsertPackInput, options: { deferSync?: boolean } = {}) =>
    isTauriRuntime()
      ? invoke<SkillPackDetail>('execute_upsert_skill_pack', { pack, deferSync: options.deferSync ?? false })
      : Promise.resolve(null as unknown as SkillPackDetail),
  previewDeletePack: (packId: string) =>
    isTauriRuntime() ? invoke<DeleteSkillPackPreview>('preview_delete_skill_pack', { packId }) : Promise.resolve({ packId, packName: packId, appliedAgents: [], affectedTargets: [], removable: true, warnings: [] }),
  deletePack: (packId: string) =>
    isTauriRuntime() ? invoke<void>('execute_delete_skill_pack', { packId }) : Promise.resolve(),
  previewApplyPack: (packId: string, targetAgents: string[], requestedMode: 'link' | 'copy') =>
    isTauriRuntime() ? invoke<DistributionPreview>('preview_apply_skill_pack', { packId, targetAgents, requestedMode }) : Promise.resolve({ skillIds: [], targetAgents, requestedMode, changes: [], blockers: [], blockerDecisions: [] }),
  executeApplyPack: (packId: string, targetAgents: string[], requestedMode: 'link' | 'copy', blockerDecisions: DistributionBlockerDecision[] = []) =>
    isTauriRuntime() ? invoke<DistributionPreview>('execute_apply_skill_pack', { packId, targetAgents, requestedMode, blockerDecisions }) : Promise.resolve({ skillIds: [], targetAgents, requestedMode, changes: [], blockers: [], blockerDecisions }),
  syncPackToAgents: (packId: string, targetAgents: string[] = []) =>
    isTauriRuntime() ? invoke<SkillPackSyncResult>('execute_sync_skill_pack_to_agents', { packId, targetAgents }) : Promise.resolve({ packId, packName: packId, revision: 1, status: 'synced', agents: [] }),
  previewRemovePackFromAgent: (packId: string, agentId: string) =>
    isTauriRuntime() ? invoke<RemovePackFromAgentPreview>('preview_remove_skill_pack_from_agent', { packId, agentId }) : Promise.resolve({ packId, packName: packId, agentId, displayName: agentId, affectedTargets: [], willRemoveTargets: 0, willPreserveTargets: 0 }),
  removePackFromAgent: (packId: string, agentId: string) =>
    isTauriRuntime() ? invoke<RevokeResult>('execute_remove_skill_pack_from_agent', { packId, agentId }) : Promise.resolve({ packId, agentId, removedClaims: 0, removedTargets: 0, preservedTargets: 0 }),
  previewRemoveSkillFromPack: (packId: string, skillId: string) =>
    isTauriRuntime() ? invoke<RemoveSkillFromPackPreview>('preview_remove_skill_from_pack', { packId, skillId }) : Promise.resolve({ packId, packName: packId, skillId, skillName: skillId, affectedTargets: [], appliedAgentCount: 0, canKeepStandalone: true, canRemoveTargets: true }),
  removeSkillFromPack: (packId: string, skillId: string, alsoRemoveTargets: boolean) =>
    isTauriRuntime() ? invoke<void>('execute_remove_skill_from_pack', { packId, skillId, alsoRemoveTargets }) : Promise.resolve(),
  previewMoveDirectSkillToPack: (targetId: string, packId: string) =>
    isTauriRuntime()
      ? invoke<MoveDirectSkillToPackPreview>('preview_move_direct_skill_to_pack', { targetId, packId })
      : Promise.resolve(null as unknown as MoveDirectSkillToPackPreview),
  moveDirectSkillToPack: (targetId: string, packId: string, blockerDecisions: DistributionBlockerDecision[] = []) =>
    isTauriRuntime()
      ? invoke<MoveDirectSkillToPackPreview>('execute_move_direct_skill_to_pack', { targetId, packId, blockerDecisions })
      : Promise.resolve(null as unknown as MoveDirectSkillToPackPreview),

  listAgents: () => (isTauriRuntime() ? invoke<AgentSummary[]>('list_managed_agents_v2') : Promise.resolve([])),
  getAgentDetail: (agentId: string) =>
    isTauriRuntime() ? invoke<AgentDetail>('get_agent_detail_v2', { agentId }) : Promise.resolve(null as unknown as AgentDetail),
  refreshAgentSkillView: (agentId: string) =>
    isTauriRuntime()
      ? invoke<AgentSkillViewSnapshot>('refresh_agent_skill_view_v2', { agentId })
      : Promise.all([
          skillApiV2.getAgentDetail(agentId),
          skillApiV2.overview(),
          skillApiV2.listUnmanaged(),
        ]).then(([agentDetail, overview, unmanaged]) => ({ agentDetail, overview, unmanaged })),
  readAgentConfigFile: (agentId: string, path: string) =>
    isTauriRuntime()
      ? invoke<AgentConfigDocument>('read_agent_config_file_v2', { agentId, path })
      : Promise.resolve({ path, content: '', revision: 'demo' }),
  writeAgentConfigFile: (
    agentId: string,
    path: string,
    content: string,
    expectedRevision: string,
  ) =>
    isTauriRuntime()
      ? invoke<AgentConfigDocument>('write_agent_config_file_v2', {
          agentId,
          path,
          content,
          expectedRevision,
        })
      : Promise.resolve({ path, content, revision: `${expectedRevision}-saved` }),
  listUnmanaged: () => (isTauriRuntime() ? invoke<UnmanagedItemDto[]>('list_unmanaged_v2') : Promise.resolve([])),
  listAgentSkillInventory: () =>
    isTauriRuntime() ? invoke<AgentSkillInventoryAgent[]>('list_agent_skill_inventory_v2') : Promise.resolve(demoAgentInventory()),
  listProjects: () =>
    isTauriRuntime() ? invoke<ProjectSummary[]>('list_skill_projects_v2') : Promise.resolve(demoProjectSummaries()),
  addProject: (rootPath: string) =>
    isTauriRuntime() ? invoke<ProjectDetail>('add_skill_project_v2', { rootPath }) : Promise.resolve(demoProjectDetail(rootPath)),
  removeProject: (projectId: string) =>
    isTauriRuntime() ? invoke<void>('remove_skill_project_v2', { projectId }) : Promise.resolve(),
  getProjectDetail: (projectId: string) =>
    isTauriRuntime() ? invoke<ProjectDetail>('get_skill_project_detail_v2', { projectId }) : Promise.resolve(demoProjectDetail(projectId)),
  scanProject: (projectId: string) =>
    isTauriRuntime() ? invoke<ProjectDetail>('scan_skill_project_v2', { projectId }) : Promise.resolve(demoProjectDetail(projectId)),
  installCenterSkillsToProject: (projectId: string, agentId: string, skillIds: string[], requestedMode: 'link' | 'copy') =>
    isTauriRuntime()
      ? invoke<ProjectDetail>('install_center_skills_to_project_v2', { projectId, agentId, skillIds, requestedMode })
      : Promise.resolve(demoProjectDetail(projectId)),
  installSkillPackToProject: (projectId: string, agentId: string, packId: string, requestedMode: 'link' | 'copy') =>
    isTauriRuntime()
      ? invoke<ProjectDetail>('install_skill_pack_to_project_v2', { projectId, agentId, packId, requestedMode })
      : Promise.resolve(demoProjectDetail(projectId)),

  runDiagnosis: () => (isTauriRuntime() ? invoke<DiagnosisIssue[]>('run_skill_manager_diagnosis') : Promise.resolve([])),
  listDiagnosisIssues: () => (isTauriRuntime() ? invoke<DiagnosisIssue[]>('list_diagnosis_issues') : Promise.resolve([])),
  previewFixIssue: (issueType: string, entityId: string) =>
    isTauriRuntime() ? invoke<{ issue: DiagnosisIssue | null; destructive: boolean }>('preview_fix_diagnosis_issue', { issueType, entityId }) : Promise.resolve({ issue: null, destructive: false }),
  executeFixIssue: (issueType: string, entityId: string) =>
    isTauriRuntime() ? invoke<void>('execute_fix_diagnosis_issue', { issueType, entityId }) : Promise.resolve(),
  executeSafeFixes: () => (isTauriRuntime() ? invoke<number>('execute_safe_fixes') : Promise.resolve(0)),

  exportSnapshot: () => (isTauriRuntime() ? invoke<string>('skill_manager_export_snapshot') : Promise.resolve('')),
  openPath: (path: string) => (isTauriRuntime() ? invoke<void>('open_skill_path', { path }) : Promise.resolve()),
  revealPath: (path: string) => (isTauriRuntime() ? invoke<void>('reveal_skill_path', { path }) : Promise.resolve()),
}

function demoAgentInventory(): AgentSkillInventoryAgent[] {
  return [
    {
      agentId: 'claude-code',
      displayName: 'Claude Code',
      iconKey: 'claude-code',
      skillsDir: '~/.claude/skills',
      installed: true,
      managedCount: 1,
      unmanagedCount: 2,
      importableCount: 1,
      items: [
        {
          id: 'demo-managed-release',
          agentId: 'claude-code',
          skillId: 'release-checklist',
          name: 'release-checklist',
          path: '~/.claude/skills/release-checklist',
          managed: true,
          canImport: false,
          status: 'ok',
          statusLabel: '已管理',
          reason: null,
          targetId: 'demo-target-1',
          actualMode: 'link',
          hash: null,
        },
        {
          id: 'demo-unmanaged-article',
          agentId: 'claude-code',
          skillId: 'article-writer',
          name: 'article-writer',
          path: '~/.claude/skills/article-writer',
          managed: false,
          canImport: true,
          status: 'unmanaged',
          statusLabel: '未管理',
          reason: 'not_in_center_library',
          targetId: null,
          actualMode: null,
          hash: 'demo-hash',
        },
        {
          id: 'demo-conflict',
          agentId: 'claude-code',
          skillId: 'frontend-design',
          name: 'frontend-design',
          path: '~/.claude/skills/frontend-design',
          managed: false,
          canImport: false,
          status: 'conflict',
          statusLabel: '未管理 · 同名冲突',
          reason: 'center_library_conflict',
          targetId: null,
          actualMode: null,
          hash: 'demo-conflict-hash',
        },
      ],
    },
    {
      agentId: 'codex',
      displayName: 'Codex',
      iconKey: 'codex',
      skillsDir: '~/.codex/skills',
      installed: true,
      managedCount: 0,
      unmanagedCount: 1,
      importableCount: 1,
      items: [
        {
          id: 'demo-codex-browser',
          agentId: 'codex',
          skillId: 'browser-control',
          name: 'browser-control',
          path: '~/.codex/skills/browser-control',
          managed: false,
          canImport: true,
          status: 'unmanaged',
          statusLabel: '未管理',
          reason: 'not_in_center_library',
          targetId: null,
          actualMode: null,
          hash: 'demo-browser-hash',
        },
      ],
    },
  ]
}

function demoProjectSummaries(): ProjectSummary[] {
  const detail = demoProjectDetail('/Users/me/project')
  return [{
    id: detail.id,
    name: detail.name,
    rootPath: detail.rootPath,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    lastScannedAt: detail.lastScannedAt,
    detectedAgentCount: detail.detectedAgentCount,
    skillCount: detail.skillCount,
    instructionCount: detail.instructionCount,
    issueCount: detail.issueCount,
  }]
}

function demoProjectDetail(rootPath: string): ProjectDetail {
  const now = new Date().toISOString()
  return {
    id: 'project-demo',
    name: rootPath.split(/[\\/]+/).filter(Boolean).pop() || 'project',
    rootPath,
    createdAt: now,
    updatedAt: now,
    lastScannedAt: now,
    detectedAgentCount: 2,
    skillCount: 3,
    instructionCount: 2,
    issueCount: 1,
    agents: [
      {
        agentId: 'codex',
        displayName: 'Codex',
        iconKey: 'codex',
        skillsDirs: [`${rootPath}/.agents/skills`],
        configPaths: [`${rootPath}/.codex/config.toml`],
        skills: [
          {
            id: 'release-review',
            name: 'release-review',
            description: 'Project-only release review workflow',
            agentId: 'codex',
            path: `${rootPath}/.agents/skills/release-review`,
            hash: 'demo-project-hash',
            status: 'projectOnly',
            importable: true,
          },
          {
            id: 'frontend-design',
            name: 'frontend-design',
            description: 'Design workflow synced with center library',
            agentId: 'codex',
            path: `${rootPath}/.agents/skills/frontend-design`,
            hash: 'demo-center-hash',
            status: 'centerSynced',
            importable: true,
          },
        ],
        health: [],
      },
      {
        agentId: 'claude-code',
        displayName: 'Claude Code',
        iconKey: 'claude-code',
        skillsDirs: [`${rootPath}/.claude/skills`],
        configPaths: [`${rootPath}/.claude/settings.json`],
        skills: [
          {
            id: 'docs-editor',
            name: 'docs-editor',
            description: 'Project documentation workflow differs from center',
            agentId: 'claude-code',
            path: `${rootPath}/.claude/skills/docs-editor`,
            hash: 'demo-diff-hash',
            status: 'centerDiff',
            importable: true,
          },
        ],
        health: [{ agentId: 'claude-code', kind: 'center_diff', message: 'docs-editor differs from center library', severity: 'warning' }],
      },
    ],
    instructions: [
      { agentId: 'codex', path: `${rootPath}/AGENTS.md`, exists: true, bytes: 2400 },
      { agentId: 'claude-code', path: `${rootPath}/.claude/CLAUDE.md`, exists: true, bytes: 3200 },
    ],
    health: [],
  }
}

function demoOverview(): SkillManagerOverview {
  return {
    metrics: { centerSkillCount: 0, targetCount: 0, unmanagedCount: 0, issueCount: 0 },
    skills: [],
    agents: [],
    packs: [],
    issues: [],
    settings: {
      centerPath: '~/.agents/skills',
      sqlitePath: '~/.vibeboard/skill-manager/skill-manager.db',
      defaultDistributeMode: 'link',
      linkFailPolicy: 'ask',
      startupScan: true,
      showUnmanaged: true,
      autoSyncSkillPacks: true,
    },
  }
}
