import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SkillOverviewPage } from '../components/skills-v2/SkillOverviewPage'
import { skillApiV2 } from '../services/skillApiV2'
import type {
  AgentSummary,
  GitHubSkillSyncResult,
  GitHubSkillUpdatePreview,
  SkillManagerOverview,
  SkillManagerSettings,
  SkillSummary,
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
  })
}

describe('SkillOverviewPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resetStore()
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
    expect(screen.getByText(/共 2 个用户级 Skill · 1 个 GitHub 来源可检查/)).toBeInTheDocument()
    expect(useSkillStoreV2.getState().filters).toEqual({ query: '', source: 'github', status: 'conflict', type: 'pack' })
  })

  it('checks GitHub skills hidden by full-manager filters while the visible search still narrows the overview', async () => {
    useSkillStoreV2.setState({ filters: { query: '', source: 'local_folder', status: '', type: '' } })
    const checkSpy = vi.spyOn(skillApiV2, 'checkGitHubSkillUpdate').mockResolvedValue({
      skillId: 'release-checklist',
      sourceUri: 'github:owner/release-checklist',
      localHash: 'a'.repeat(16),
      remoteHash: 'a'.repeat(16),
      updateAvailable: false,
      checkedAt: '2026-09-14T00:00:00Z',
    })

    render(<SkillOverviewPage />)

    fireEvent.click(screen.getByRole('button', { name: '检查更新' }))
    await waitFor(() => expect(checkSpy).toHaveBeenCalledWith('release-checklist'))
    expect(await screen.findByText('已是最新')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('搜索 Skill 名称或描述'), { target: { value: 'release' } })
    expect(screen.getByRole('button', { name: /Release Checklist/ })).toBeInTheDocument()
    expect(screen.queryByText('Local Only')).not.toBeInTheDocument()
    expect(useSkillStoreV2.getState().filters).toEqual({ query: 'release', source: 'local_folder', status: '', type: '' })
  })

  it('asks for confirmation with a preview before overwriting the center library', async () => {
    const preview: GitHubSkillUpdatePreview = {
      skillId: 'release-checklist',
      sourceUri: 'github:owner/release-checklist',
      localHash: 'aaaaaaaaaaaa1111',
      remoteHash: 'bbbbbbbbbbbb2222',
      updateAvailable: true,
      checkedAt: '2026-09-13T00:00:00Z',
    }
    const syncResult: GitHubSkillSyncResult = {
      skillId: 'release-checklist',
      sourceUri: preview.sourceUri,
      previousHash: preview.localHash,
      currentHash: preview.remoteHash,
      updated: true,
      syncedAt: '2026-09-13T00:01:00Z',
    }
    vi.spyOn(skillApiV2, 'checkGitHubSkillUpdate').mockResolvedValue(preview)
    const syncSpy = vi.spyOn(skillApiV2, 'syncGitHubSkill').mockResolvedValue(syncResult)
    vi.spyOn(skillApiV2, 'refreshOverview').mockResolvedValue(overview)
    vi.spyOn(skillApiV2, 'listUnmanaged').mockResolvedValue([])
    vi.spyOn(skillApiV2, 'listProjects').mockResolvedValue([])

    render(<SkillOverviewPage />)

    fireEvent.click(screen.getByRole('button', { name: '检查更新' }))
    expect(await screen.findByText('发现远端更新')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '同步到中心库' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('同步「Release Checklist」到中心库？')
    expect(dialog).toHaveTextContent('这些修改会被远端版本覆盖')
    expect(syncSpy).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '覆盖并同步' }))

    await waitFor(() => expect(syncSpy).toHaveBeenCalledWith('release-checklist'))
  })

  it('does not sync when the confirmation is cancelled', async () => {
    vi.spyOn(skillApiV2, 'checkGitHubSkillUpdate').mockResolvedValue({
      skillId: 'release-checklist',
      sourceUri: 'github:owner/release-checklist',
      localHash: 'a'.repeat(16),
      remoteHash: 'b'.repeat(16),
      updateAvailable: true,
      checkedAt: '2026-09-13T00:00:00Z',
    })
    const syncSpy = vi.spyOn(skillApiV2, 'syncGitHubSkill')

    render(<SkillOverviewPage />)

    fireEvent.click(screen.getByRole('button', { name: '检查更新' }))
    expect(await screen.findByText('发现远端更新')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '同步到中心库' }))

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(syncSpy).not.toHaveBeenCalled()
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

  it('disables the update check and says so when no GitHub source is recorded', () => {
    const localOnlyOverview: SkillManagerOverview = {
      ...overview,
      skills: [localSkill],
    }
    useSkillStoreV2.setState({
      overview: localOnlyOverview,
      skills: localOnlyOverview.skills,
    })

    render(<SkillOverviewPage />)

    expect(screen.getByText(/0 个 GitHub 来源可检查/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '检查更新' })).toBeDisabled()
  })
})
