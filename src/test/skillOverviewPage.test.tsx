import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SkillOverviewPage } from '../components/skills-v2/SkillOverviewPage'
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

describe('SkillOverviewPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resetStore()
    vi.spyOn(skillApiV2, 'skillUpdateStatus').mockResolvedValue(updateStatus(null))
  })

  it('shows real effect categories instead of promising generic or exclusive scopes', () => {
    render(<SkillOverviewPage />)

    const allTab = screen.getByRole('tab', { name: /全部（中心库）/ })
    expect(allTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /生效于 Codex/ })).toBeInTheDocument()
    expect(screen.getByText(/「通用 \/ 专属」自动分配/)).toBeInTheDocument()
    expect(screen.getByText(/不会自动覆盖未来新安装的 Agent/)).toBeInTheDocument()
    expect(screen.getByText('尚未生效')).toBeInTheDocument()
    expect(screen.queryByText(/通用分类来自中心库/)).not.toBeInTheDocument()
  })

  it('filters an Agent category by its real installed targets', () => {
    render(<SkillOverviewPage />)

    fireEvent.click(screen.getByRole('tab', { name: /生效于 Codex/ }))

    expect(screen.getByText('Release Checklist')).toBeInTheDocument()
    expect(screen.queryByText('Local Only')).not.toBeInTheDocument()
    expect(screen.getByText(/不是「专属」绑定/)).toBeInTheDocument()
  })

  it('ignores full-manager source/status/type filters without resetting them', () => {
    useSkillStoreV2.setState({ filters: { query: '', source: 'github', status: 'conflict', type: 'pack' } })

    render(<SkillOverviewPage />)

    expect(screen.getByText('Release Checklist')).toBeInTheDocument()
    expect(screen.getByText('Local Only')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /全部（中心库）/ })).toHaveTextContent('2')
    expect(screen.getByText(/共 2 个 Skill · 1 个可检查更新/)).toBeInTheDocument()
    expect(useSkillStoreV2.getState().filters).toEqual({ query: '', source: 'github', status: 'conflict', type: 'pack' })
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

    render(<SkillOverviewPage />)

    fireEvent.click(screen.getByRole('button', { name: '检查全部更新' }))
    await waitFor(() => expect(checkSpy).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('1 个可更新')).toBeInTheDocument()
    expect(screen.getAllByText('Release Checklist').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: '更新' })).toBeInTheDocument()
    expect(screen.getByText('新增 1 · 修改 1 · 删除 0')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('搜索 Skill 名称或描述'), { target: { value: 'release' } })
    expect(useSkillStoreV2.getState().filters).toEqual({ query: 'release', source: 'local_folder', status: '', type: '' })
  })

  it('warns before overwriting a Skill the user edited', async () => {
    vi.spyOn(skillApiV2, 'checkAllSkillUpdates').mockResolvedValue(
      updateReport([updateCheckEntry({ locallyModified: true })]),
    )
    const updateSpy = vi.spyOn(skillApiV2, 'updateSkillFromSource').mockResolvedValue(updateResult())
    vi.spyOn(skillApiV2, 'overview').mockResolvedValue(overview)
    vi.spyOn(skillApiV2, 'listUnmanaged').mockResolvedValue([])
    vi.spyOn(skillApiV2, 'listProjects').mockResolvedValue([])

    render(<SkillOverviewPage />)

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

    render(<SkillOverviewPage />)

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

    render(<SkillOverviewPage />)

    fireEvent.click(screen.getByRole('button', { name: '检查全部更新' }))
    expect(await screen.findByText('1 个可更新')).toBeInTheDocument()

    const toggle = screen.getByRole('checkbox', { name: /自动更新/ })
    expect(toggle).not.toBeChecked()
    fireEvent.click(toggle)

    await waitFor(() => expect(toggleSpy).toHaveBeenCalledWith('release-checklist', true))
  })

  it('shows automatic update results and skipped ones without an update button', () => {
    const entries = [
      updateCheckEntry({
        skillId: 'alpha',
        name: 'Alpha',
        updateAvailable: false,
        autoUpdated: true,
        autoUpdateEnabled: true,
        changes: null,
      }),
      updateCheckEntry({
        skillId: 'beta',
        name: 'Beta',
        autoUpdateSkipped: 'locally_modified',
        autoUpdateEnabled: true,
      }),
    ]
    useSkillStoreV2.setState({
      updateStatus: updateStatus(updateReport(entries), { periodicCheckEnabled: true }),
    })

    render(<SkillOverviewPage />)

    expect(screen.getByText('已自动更新到新版本')).toBeInTheDocument()
    expect(screen.getByText('已跳过：这个 Skill 和安装时记录的版本对不上，可能被改过，自动更新不会覆盖它。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '更新' })).toBeInTheDocument()
  })

  it('phrases check failures for people and keeps raw details folded', () => {
    const entry = updateCheckEntry({
      updateAvailable: false,
      changes: null,
      errorKind: 'rate_limited',
      errorDetail: 'API rate limit exceeded for 203.0.113.1',
    })
    useSkillStoreV2.setState({ updateStatus: updateStatus(updateReport([entry])) })

    render(<SkillOverviewPage />)

    expect(screen.getByText('GitHub 暂时限制了访问频率，稍后再试。')).toBeInTheDocument()
    expect(screen.queryByText(/API rate limit exceeded/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('skill-update-error-release-checklist'))

    expect(screen.getByText(/API rate limit exceeded/)).toBeInTheDocument()
  })

  it('tells the user that Skills without a recorded source are not checked', async () => {
    const localOnlyOverview: SkillManagerOverview = {
      ...overview,
      skills: [localSkill],
    }
    useSkillStoreV2.setState({
      overview: localOnlyOverview,
      skills: localOnlyOverview.skills,
    })
    const checkSpy = vi.spyOn(skillApiV2, 'checkAllSkillUpdates').mockResolvedValue(updateReport([]))

    render(<SkillOverviewPage />)

    expect(screen.getByRole('button', { name: '检查全部更新' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '检查全部更新' }))
    await waitFor(() => expect(checkSpy).toHaveBeenCalledTimes(1))

    expect(await screen.findByText('全部已是最新')).toBeInTheDocument()
    expect(screen.getByText(/没有来源记录的 Skill 不参与检查/)).toBeInTheDocument()
  })

  it('lists only program-detected Agents by default and reveals the rest from +', () => {
    const threeStateAgents: AgentSummary[] = [
      { ...agents[0], id: 'codex', displayName: 'Codex', installed: true, programInstalled: true },
      { ...agents[1], id: 'kiro', displayName: 'Kiro', installed: true, programInstalled: false },
      {
        ...agents[1],
        id: 'cursor',
        displayName: 'Cursor',
        installed: false,
        programInstalled: false,
      },
    ]
    useSkillStoreV2.setState({
      agents: threeStateAgents,
      filters: { query: '', source: '', status: '', type: '' },
    })

    render(<SkillOverviewPage />)

    expect(screen.getByRole('tab', { name: /生效于 Codex/ })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /生效于 Kiro/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /生效于 Cursor/ })).not.toBeInTheDocument()

    const more = screen.getByRole('button', { name: /^\+\s*2$/ })
    expect(more).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(more)

    expect(screen.getByRole('tab', { name: /生效于 Kiro/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /生效于 Cursor/ })).toBeInTheDocument()
  })

  it('keeps the Skill library path out of the default view and shows it in the details', () => {
    render(<SkillOverviewPage />)

    expect(screen.queryByText('/home/user/.agents/skills')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('skills-overview-scope-details'))

    expect(screen.getByTestId('skills-overview-scope-details-body')).toHaveTextContent('/home/user/.agents/skills')
  })
})
