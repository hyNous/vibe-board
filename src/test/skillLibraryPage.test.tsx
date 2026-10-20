import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SkillLibraryPage } from '../components/skills-v2/SkillLibraryPage'
import { skillApiV2 } from '../services/skillApiV2'
import type {
  AgentSummary,
  SkillManagerOverview,
  SkillManagerSettings,
  SkillSummary,
  SkillUpdateCheckEntry,
  SkillUpdateCheckReport,
  SkillUpdateRunResult,
  SkillUpdateStatus,
} from '../services/skillApiV2'
import { useSkillStoreV2 } from '../stores/skillStoreV2'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const template = typeof options?.defaultValue === 'string' ? options.defaultValue : key
      return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ''))
    },
    i18n: { language: 'zh' },
  }),
}))

const settings: SkillManagerSettings = {
  centerPath: '/home/user/.agents/skills',
  sqlitePath: '/home/user/.vibe/skills.db',
  defaultDistributeMode: 'link',
  linkFailPolicy: 'ask',
  startupScan: false,
  showUnmanaged: true,
}

const agents: AgentSummary[] = [
  {
    id: 'codex',
    displayName: 'Codex',
    iconKey: 'codex',
    enabled: true,
    skillsDir: '/home/user/.codex/skills',
    version: null,
    latestVersion: null,
    installed: true,
    managedSkillCount: 1,
    unmanagedSkillCount: 0,
  },
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    iconKey: 'claude-code',
    enabled: true,
    skillsDir: '/home/user/.claude/skills',
    version: null,
    latestVersion: null,
    installed: true,
    managedSkillCount: 0,
    unmanagedSkillCount: 0,
  },
]

function makeSkill(overrides: Partial<SkillSummary>): SkillSummary {
  return {
    id: 'skill',
    name: 'Skill',
    description: '',
    skillType: 'skill',
    sourceType: 'local_folder',
    sourceUri: null,
    centerPath: '/home/user/.agents/skills/skill',
    currentHash: 'hash-local',
    status: 'ok',
    installedAgents: [],
    ...overrides,
  }
}

const githubSkill = makeSkill({
  id: 'release-checklist',
  name: 'Release Checklist',
  sourceType: 'github',
  sourceUri: 'github:owner/release-checklist',
  currentHash: 'hash-local',
  status: 'updateAvailable',
  installedAgents: [
    { agentId: 'codex', displayName: 'Codex', iconKey: 'codex', mode: 'copy', status: 'copy_outdated' },
  ],
})

const localSkill = makeSkill({ id: 'local-only', name: 'Local Only' })

const overview: SkillManagerOverview = {
  metrics: { centerSkillCount: 2, targetCount: 1, unmanagedCount: 0, issueCount: 0 },
  skills: [githubSkill, localSkill],
  agents,
  issues: [],
  settings,
}

function updateCheckEntry(overrides: Partial<SkillUpdateCheckEntry> = {}): SkillUpdateCheckEntry {
  return {
    skillId: 'release-checklist',
    name: 'Release Checklist',
    sourceUri: 'github:owner/repo/skills/release-checklist',
    updateAvailable: true,
    locallyModified: false,
    baselineKnown: true,
    autoUpdateEnabled: false,
    autoUpdated: false,
    autoUpdateSkipped: null,
    errorKind: null,
    errorDetail: null,
    changes: {
      added: 1,
      modified: 1,
      removed: 0,
      files: [
        { path: 'new-notes.md', changeType: 'added' },
        { path: 'SKILL.md', changeType: 'modified' },
      ],
      truncated: false,
    },
    ...overrides,
  }
}

function updateReport(entries: SkillUpdateCheckEntry[]): SkillUpdateCheckReport {
  return {
    checkedAt: '2026-10-07T12:00:00Z',
    checkedCount: entries.length,
    updateCount: entries.filter((entry) => entry.updateAvailable).length,
    failedCount: entries.filter((entry) => entry.errorKind).length,
    entries,
  }
}

function updateStatus(
  report: SkillUpdateCheckReport | null,
  overrides: Partial<SkillUpdateStatus> = {},
): SkillUpdateStatus {
  return {
    periodicCheckEnabled: false,
    lastCheckedAt: report?.checkedAt ?? null,
    report,
    autoUpdateSkillIds: [],
    ...overrides,
  }
}

function updateResult(overrides: Partial<SkillUpdateRunResult> = {}): SkillUpdateRunResult {
  return {
    skillId: 'release-checklist',
    name: 'Release Checklist',
    sourceUri: 'github:owner/repo/skills/release-checklist',
    updated: true,
    skippedReason: null,
    locallyModified: false,
    changes: null,
    syncedAt: '2026-10-07T12:05:00Z',
    errorKind: null,
    errorDetail: null,
    ...overrides,
  }
}

function resetStore() {
  useSkillStoreV2.setState({
    initialized: true,
    loading: false,
    error: null,
    overview,
    skills: overview.skills,
    agents,
    settings,
    filters: { query: '', source: '', status: '', type: '' },
    unmanaged: [],
    selectedAgentId: null,
    selectedAgentDetail: null,
    updateStatus: null,
    updateChecking: false,
    updateBusySkillId: null,
  })
}

// SkillLibraryPage 现在同时承担总览页的按 Agent 筛选与更新检查面板。
describe('SkillLibraryPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resetStore()
    vi.spyOn(skillApiV2, 'skillUpdateStatus').mockResolvedValue(updateStatus(null))
  })

  it('filters an Agent category by its real installed targets', () => {
    render(<SkillLibraryPage />)

    fireEvent.click(screen.getByRole('tab', { name: /生效于 Codex/ }))

    expect(screen.getByText('Release Checklist')).toBeInTheDocument()
    expect(screen.queryByText('Local Only')).not.toBeInTheDocument()
    expect(screen.getByText(/不是「专属」绑定/)).toBeInTheDocument()
  })

  it('checks all recorded sources no matter what the visible search shows', async () => {
    useSkillStoreV2.setState({ filters: { query: '', source: 'local_folder', status: '', type: '' } })
    const current = updateCheckEntry({
      skillId: 'other',
      name: 'Other',
      updateAvailable: false,
      changes: null,
    })
    const checkSpy = vi
      .spyOn(skillApiV2, 'checkAllSkillUpdates')
      .mockResolvedValue(updateReport([updateCheckEntry(), current]))

    render(<SkillLibraryPage />)

    fireEvent.click(screen.getByRole('button', { name: '检查全部更新' }))
    await waitFor(() => expect(checkSpy).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('1 个可更新')).toBeInTheDocument()
    expect(screen.getAllByText('Release Checklist').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: '更新' })).toBeInTheDocument()
    expect(screen.getByText('新增 1 · 修改 1 · 删除 0')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('搜索名称、描述、来源或 Agent'), { target: { value: 'release' } })
    expect(useSkillStoreV2.getState().filters).toEqual({ query: 'release', source: 'local_folder', status: '', type: '' })
  })

  it('warns before overwriting a Skill the user edited', async () => {
    vi.spyOn(skillApiV2, 'checkAllSkillUpdates').mockResolvedValue(
      updateReport([updateCheckEntry({ locallyModified: true })]),
    )
    const updateSpy = vi.spyOn(skillApiV2, 'updateSkillFromSource').mockResolvedValue(updateResult())
    vi.spyOn(skillApiV2, 'overview').mockResolvedValue(overview)
    vi.spyOn(skillApiV2, 'listUnmanaged').mockResolvedValue([])

    render(<SkillLibraryPage />)

    fireEvent.click(screen.getByRole('button', { name: '检查全部更新' }))
    expect(await screen.findByText('1 个可更新')).toBeInTheDocument()
    expect(screen.getAllByText('这个 Skill 和安装时记录的版本对不上，可能被改过，更新会覆盖本地内容。').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: '更新' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('这个 Skill 和安装时记录的版本对不上，可能被改过，更新会覆盖本地内容。')
    expect(dialog).toHaveTextContent('会用 GitHub 上的新版本替换本地文件')
    expect(updateSpy).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: '更新' }))

    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith('release-checklist', true))
  })

  it('does not update when the confirmation is cancelled', async () => {
    vi.spyOn(skillApiV2, 'checkAllSkillUpdates').mockResolvedValue(updateReport([updateCheckEntry()]))
    const updateSpy = vi.spyOn(skillApiV2, 'updateSkillFromSource')

    render(<SkillLibraryPage />)

    fireEvent.click(screen.getByRole('button', { name: '检查全部更新' }))
    expect(await screen.findByText('1 个可更新')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '更新' }))

    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('lets the user switch auto-update on for one Skill', async () => {
    vi.spyOn(skillApiV2, 'checkAllSkillUpdates').mockResolvedValue(updateReport([updateCheckEntry()]))
    const toggleSpy = vi.spyOn(skillApiV2, 'setSkillAutoUpdate').mockResolvedValue(
      updateStatus(updateReport([updateCheckEntry()]), { autoUpdateSkillIds: ['release-checklist'] }),
    )

    render(<SkillLibraryPage />)

    fireEvent.click(screen.getByRole('button', { name: '检查全部更新' }))
    expect(await screen.findByText('1 个可更新')).toBeInTheDocument()

    const toggle = screen.getByRole('checkbox', { name: /自动更新/ })
    expect(toggle).not.toBeChecked()
    fireEvent.click(toggle)

    await waitFor(() => expect(toggleSpy).toHaveBeenCalledWith('release-checklist', true))
  })
})
