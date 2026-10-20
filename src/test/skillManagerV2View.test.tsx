import { describe, it, expect, beforeEach, vi, beforeAll } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { LOCAL_RUNTIME_ENVIRONMENT_ID, useSkillStoreV2 } from '../stores/skillStoreV2'
import { skillApiV2 } from '../services/skillApiV2'
import i18n from '../i18n'
import type { SkillSummary, AgentSummary, AgentDetail, AdoptPreview, UnmanagedItemDto } from '../services/skillApiV2'

// SkillSection imports pages that call skillApiV2 at mount; we stub the api
// so tests run without the Tauri runtime.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn().mockResolvedValue(null) }))
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn().mockResolvedValue(undefined) }))

function makeSkill(overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    id: 'release-checklist',
    name: 'Release Checklist',
    description: 'Pre-release QA skill',
    skillType: 'skill',
    sourceType: 'local_folder',
    sourceUri: null,
    centerPath: '/center/release-checklist',
    currentHash: 'hash1',
    status: 'ok',
    installedAgents: [
      { agentId: 'claude-code', displayName: 'Claude Code', iconKey: 'claude-code', mode: 'link', status: 'ok' },
      { agentId: 'codex', displayName: 'Codex', iconKey: 'codex', mode: 'copy', status: 'ok' },
    ],
    ...overrides,
  }
}

function makeSharedUnmanaged(skillId: string, overrides: Partial<UnmanagedItemDto> = {}): UnmanagedItemDto {
  return {
    id: `raw-${skillId}`,
    itemType: 'skill',
    agentId: 'agents',
    path: `/Users/me/.agents/skills/${skillId}`,
    inferredSkillId: skillId,
    hash: `hash-${skillId}`,
    reason: 'not_in_center_library',
    ...overrides,
  }
}

function makeSidebarAgent(id: string, displayName: string, counts: { managed?: number; unmanaged?: number } = {}): AgentSummary {
  return {
    id,
    displayName,
    iconKey: id,
    enabled: true,
    skillsDir: `/${id}`,
    version: null,
    latestVersion: null,
    installed: true,
    managedSkillCount: counts.managed ?? 0,
    unmanagedSkillCount: counts.unmanaged ?? 0,
  }
}

// Tests import these components lazily so the module mocks above apply. The
// first import transforms a large module graph; under a busy parallel run
// that alone can exceed the 5 s per-test timeout, and a timed-out import then
// renders into the next test. Warm the module cache once, outside any test.
beforeAll(async () => {
  await Promise.all([
    import('../components/skills-v2/AgentRoster'),
    import('../components/skills-v2/AgentManagementPage'),
    import('../components/skills-v2/DistributeDialog'),
    import('../components/skills-v2/InstallView'),
    import('../components/skills-v2/SettingsPageV2'),
    import('../components/skills-v2/SkillDetailSlider'),
    import('../components/skills-v2/SkillLibraryPage'),
    import('../components/skills-v2/SkillSection'),
  ])
}, 60_000)

describe('Git install skill preview view modes', () => {
  beforeEach(() => {
    cleanup()
    vi.spyOn(skillApiV2, 'previewGitHubRepoImport').mockResolvedValue({
      repo: {
        owner: 'anthropics',
        repo: 'skills',
        branch: 'main',
        normalizedUrl: 'https://github.com/anthropics/skills/tree/main',
      },
      skills: [
        {
          sourcePath: 'algorithmic-art',
          skillId: 'algorithmic-art',
          skillName: 'algorithmic-art',
          description: 'Creating algorithmic art using p5.js.',
          rootDirectory: '',
          skillDirectoryName: 'algorithmic-art',
          downloadUrl: 'github:anthropics/skills/algorithmic-art',
          conflict: null,
        },
        {
          sourcePath: 'brand-guidelines',
          skillId: 'brand-guidelines',
          skillName: 'brand-guidelines',
          description: 'Applies official brand colors and typography.',
          rootDirectory: '',
          skillDirectoryName: 'brand-guidelines',
          downloadUrl: 'github:anthropics/skills/brand-guidelines',
          conflict: null,
        },
      ],
    })
  })

  it('forwards the private repository token only when requesting GitHub data', async () => {
    const preview = vi.mocked(skillApiV2.previewGitHubRepoImport)
    const install = vi.spyOn(skillApiV2, 'importGitHubRepoSkills').mockResolvedValue({
      repo: {
        owner: 'acme',
        repo: 'private-skills',
        branch: 'main',
        normalizedUrl: 'https://github.com/acme/private-skills',
      },
      importedSkills: [],
      skippedSkills: [],
    })
    const { GitPanel } = await import('../components/skills-v2/InstallView')
    render(<GitPanel initialUrl="https://github.com/acme/private-skills" onDone={() => {}} />)

    fireEvent.click(screen.getByText('高级（私有仓库令牌）'))
    fireEvent.change(screen.getByPlaceholderText('ghp_...'), { target: { value: 'github-test-token' } })
    fireEvent.click(screen.getByText('检测 Skill'))

    await waitFor(() => {
      expect(preview).toHaveBeenCalledWith(
        'https://github.com/acme/private-skills',
        'github-test-token',
      )
    })

    await screen.findAllByText('algorithmic-art')
    fireEvent.click(screen.getByText('安装所选 (2)'))
    await waitFor(() => {
      expect(install).toHaveBeenCalledWith(
        'https://github.com/acme/private-skills',
        expect.any(Array),
        'github-test-token',
      )
    })
  })
})

describe('Local skill import', () => {
  beforeEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('passes link import mode when importing a local source folder as a symlink', async () => {
    const previewAdd = vi.spyOn(skillApiV2, 'previewAddCenterSkill').mockResolvedValue({
      centerPath: '/Users/me/.agentbro/skills',
      candidates: [
        {
          skillId: 'live-review',
          proposedSkillId: 'live-review',
          name: 'live-review',
          description: 'Local development skill',
          sourceDir: '/Users/me/code/szskills/live-review',
          hash: 'hash-link',
          action: 'create',
          existingSourceType: null,
          reason: null,
        },
      ],
      blockers: [],
    })
    const executeAdd = vi.spyOn(skillApiV2, 'executeAddCenterSkill').mockResolvedValue({
      skillIds: ['live-review'],
      updated: [],
      skipped: [],
    })
    vi.spyOn(window, 'alert').mockImplementation(() => {})

    const { LocalPanel } = await import('../components/skills-v2/InstallView')
    render(<LocalPanel onDone={() => {}} />)

    expect(screen.getByText(/常见使用场景：本地已有 Skill/)).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('选择或粘贴包含 SKILL.md 的目录 / .zip'), {
      target: { value: '/Users/me/code/szskills/live-review' },
    })
    fireEvent.click(screen.getByLabelText('软链导入，本地目录作为源'))
    fireEvent.click(screen.getByRole('button', { name: '预览导入' }))

    await waitFor(() => {
      expect(previewAdd).toHaveBeenCalledWith({
        sourcePath: '/Users/me/code/szskills/live-review',
        sourceType: 'local_folder',
        sourceUri: '/Users/me/code/szskills/live-review',
        importMode: 'link',
      })
    })

    fireEvent.click(await screen.findByRole('button', { name: '执行导入' }))
    await waitFor(() => {
      expect(executeAdd).toHaveBeenCalledWith({
        sourcePath: '/Users/me/code/szskills/live-review',
        sourceType: 'local_folder',
        sourceUri: '/Users/me/code/szskills/live-review',
        importMode: 'link',
      }, [])
    })
  })

})

describe('Skill detail slider + agent page render without crashing', () => {
  const agentDetail: AgentDetail = {
    id: 'claude-code',
    displayName: 'Claude Code',
    iconKey: 'claude-code',
    version: null,
    latestVersion: null,
    skillsDir: '/c',
    configPath: '/c/config.json',
    skills: [
      {
        id: 'target-1',
        skillId: 'release-checklist',
        agentId: 'claude-code',
        targetPath: '/c/skills/release-checklist',
        resolvedTargetPath: null,
        installMode: 'link',
        actualMode: 'link',
        sourceHash: 'hash1',
        currentHash: 'hash1',
        status: 'ok',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        claims: [{ id: 'claim-1', claimType: 'direct', packId: null, packName: null, createdAt: '2026-01-01T00:00:00Z' }],
      },
    ],
    inheritedManagedSkills: [],
    inheritedUnmanagedSkills: [],
    health: [],
  }

  beforeEach(() => {
    cleanup()
    vi.restoreAllMocks()
    i18n.changeLanguage('zh')
    useSkillStoreV2.setState({
      runtimeEnvironmentId: LOCAL_RUNTIME_ENVIRONMENT_ID,
      viewMode: 'cards',
      filters: { query: '', source: '', status: '', type: '' },
      skills: [makeSkill()],
      agents: [
        { id: 'claude-code', displayName: 'Claude Code', iconKey: 'claude-code', enabled: true, skillsDir: '/c', version: null, latestVersion: null, installed: true, managedSkillCount: 1, unmanagedSkillCount: 0 } as AgentSummary,
      ],
      overview: null,
      settings: {
        centerPath: '~/.agents/skills', sqlitePath: '~/.agentbro/skill-manager.db',
        defaultDistributeMode: 'link', linkFailPolicy: 'ask', startupScan: true, showUnmanaged: true,
      },
      loading: false, error: null,
      selectedSkillId: null, selectedSkillDetail: null,
      selectedAgentId: 'claude-code', selectedAgentDetail: agentDetail, agentDetailLoading: false,
      unmanaged: [
        {
          id: 'unmanaged-1',
          agentId: 'claude-code',
          itemType: 'skill',
          path: '/c/skills/manual-skill',
          inferredSkillId: 'manual-skill',
          hash: null,
          reason: 'not_in_center_library',
        },
      ],
      issues: [],
    })
    vi.spyOn(skillApiV2, 'refreshAgentSkillView').mockImplementation(async (agentId) => {
      const current = useSkillStoreV2.getState()
      return {
        agentDetail: current.selectedAgentDetail?.id === agentId ? current.selectedAgentDetail : agentDetail,
        overview: {
          ...makeOverview(),
          skills: current.skills,
          agents: current.agents,
        },
        unmanaged: current.unmanaged,
      }
    })
  })

  it('keeps shared adoption open when the Agent detail refresh fails without adopting twice', async () => {
    const consumerDetail: AgentDetail = {
      ...agentDetail,
      id: 'codex',
      displayName: 'Codex',
      iconKey: 'codex',
      skillsDir: '/Users/me/.codex/skills',
      skills: [],
      inheritsSharedSkills: true,
      inheritedManagedSkills: [],
      inheritedUnmanagedSkills: [makeSharedUnmanaged('shared-retry')],
    }
    useSkillStoreV2.setState({
      overview: makeOverview(),
      lastOverviewLoadedAt: Date.now(),
      agents: [makeSidebarAgent('codex', 'Codex')],
      selectedAgentId: 'codex',
      selectedAgentDetail: consumerDetail,
      unmanaged: [],
    })
    vi.spyOn(skillApiV2, 'previewAdopt').mockResolvedValue({
      agentId: 'agents',
      unmanagedId: 'raw-shared-retry',
      skillPath: '/Users/me/.agents/skills/shared-retry',
      inferredSkillId: 'shared-retry',
      hash: 'hash-shared-retry',
      centerHasSameId: false,
      canQuickAdopt: true,
      options: [
        { value: 'import_cleanup', label: 'Import and clean up', destructive: true },
      ],
    })
    const executeAdopt = vi.spyOn(skillApiV2, 'executeAdopt').mockResolvedValue('shared-retry')
    vi.spyOn(skillApiV2, 'listUnmanaged').mockResolvedValue([])
    const getAgentDetail = vi.spyOn(skillApiV2, 'getAgentDetail')
      .mockRejectedValueOnce(new Error('shared detail refresh failed'))
      .mockResolvedValue({
        ...consumerDetail,
        inheritedUnmanagedSkills: [],
      })
    vi.spyOn(skillApiV2, 'overview').mockResolvedValue(makeOverview())

    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Skills (1)' }))
    fireEvent.click(screen.getByRole('button', { name: '共享继承 1' }))
    fireEvent.click(screen.getByRole('button', { name: '未管理 1' }))
    fireEvent.click(screen.getByRole('button', { name: '接管' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认接管' }))

    await waitFor(() => expect(getAgentDetail).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/shared detail refresh failed/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '接管 shared-retry' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: '重试刷新' })).toBeEnabled())

    fireEvent.click(screen.getByRole('button', { name: '重试刷新' }))
    await waitFor(() => {
      expect(executeAdopt).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('heading', { name: '接管 shared-retry' })).not.toBeInTheDocument()
    })
  })

  it('keeps shared adoption open when the overview refresh fails without adopting twice', async () => {
    const consumerDetail: AgentDetail = {
      ...agentDetail,
      id: 'codex',
      displayName: 'Codex',
      iconKey: 'codex',
      skillsDir: '/Users/me/.codex/skills',
      skills: [],
      inheritsSharedSkills: true,
      inheritedManagedSkills: [],
      inheritedUnmanagedSkills: [makeSharedUnmanaged('shared-retry')],
    }
    useSkillStoreV2.setState({
      overview: makeOverview(),
      lastOverviewLoadedAt: Date.now(),
      agents: [makeSidebarAgent('codex', 'Codex')],
      selectedAgentId: 'codex',
      selectedAgentDetail: consumerDetail,
      unmanaged: [],
    })
    vi.spyOn(skillApiV2, 'previewAdopt').mockResolvedValue({
      agentId: 'agents',
      unmanagedId: 'raw-shared-retry',
      skillPath: '/Users/me/.agents/skills/shared-retry',
      inferredSkillId: 'shared-retry',
      hash: 'hash-shared-retry',
      centerHasSameId: false,
      canQuickAdopt: true,
      options: [
        { value: 'import_cleanup', label: 'Import and clean up', destructive: true },
      ],
    })
    const executeAdopt = vi.spyOn(skillApiV2, 'executeAdopt').mockResolvedValue('shared-retry')
    vi.spyOn(skillApiV2, 'listUnmanaged').mockResolvedValue([])
    vi.spyOn(skillApiV2, 'getAgentDetail').mockResolvedValue({
      ...consumerDetail,
      inheritedUnmanagedSkills: [],
    })
    const overview = vi.spyOn(skillApiV2, 'overview').mockResolvedValue(makeOverview())

    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Skills (1)' }))
    fireEvent.click(screen.getByRole('button', { name: '共享继承 1' }))
    fireEvent.click(screen.getByRole('button', { name: '未管理 1' }))
    fireEvent.click(screen.getByRole('button', { name: '接管' }))
    const confirmAdopt = await screen.findByRole('button', { name: '确认接管' })
    const overviewCallsBeforeAdopt = overview.mock.calls.length
    overview.mockRejectedValueOnce(new Error('shared overview refresh failed'))
    fireEvent.click(confirmAdopt)

    await waitFor(() => expect(overview).toHaveBeenCalledTimes(overviewCallsBeforeAdopt + 1))
    expect(await screen.findByText(/shared overview refresh failed/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '接管 shared-retry' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: '重试刷新' })).toBeEnabled())

    fireEvent.click(screen.getByRole('button', { name: '重试刷新' }))
    await waitFor(() => {
      expect(executeAdopt).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('heading', { name: '接管 shared-retry' })).not.toBeInTheDocument()
    })
  })

  it('ignores an adoption preview returned after the runtime environment changes', async () => {
    const consumerDetail: AgentDetail = {
      ...agentDetail,
      id: 'codex',
      displayName: 'Codex',
      iconKey: 'codex',
      skillsDir: '/Users/me/.codex/skills',
      skills: [],
      inheritsSharedSkills: true,
      inheritedManagedSkills: [],
      inheritedUnmanagedSkills: [makeSharedUnmanaged('shared-runtime')],
    }
    useSkillStoreV2.setState({
      runtimeEnvironmentId: LOCAL_RUNTIME_ENVIRONMENT_ID,
      overview: makeOverview(),
      lastOverviewLoadedAt: Date.now(),
      agents: [makeSidebarAgent('codex', 'Codex')],
      selectedAgentId: 'codex',
      selectedAgentDetail: consumerDetail,
      unmanaged: [],
    })
    const preview: AdoptPreview = {
      agentId: 'agents',
      unmanagedId: 'raw-shared-runtime',
      skillPath: '/Users/me/.agents/skills/shared-runtime',
      inferredSkillId: 'shared-runtime',
      hash: 'hash-shared-runtime',
      centerHasSameId: false,
      canQuickAdopt: true,
      options: [
        { value: 'import_cleanup', label: 'Import and clean up', destructive: true },
      ],
    }
    let resolvePreview: (preview: AdoptPreview) => void = () => {}
    const previewPromise = new Promise<AdoptPreview>((resolve) => {
      resolvePreview = resolve
    })
    const previewAdopt = vi.spyOn(skillApiV2, 'previewAdopt').mockReturnValue(previewPromise)

    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Skills (1)' }))
    fireEvent.click(screen.getByRole('button', { name: '共享继承 1' }))
    fireEvent.click(screen.getByRole('button', { name: '未管理 1' }))
    fireEvent.click(screen.getByRole('button', { name: '接管' }))
    await waitFor(() => expect(previewAdopt).toHaveBeenCalledTimes(1))

    act(() => {
      useSkillStoreV2.setState({ runtimeEnvironmentId: 'remote-runtime' })
      resolvePreview(preview)
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('运行环境已切换，已忽略原环境的接管预览')
    expect(screen.queryByRole('heading', { name: '接管 shared-runtime' })).not.toBeInTheDocument()
  })

  it('keeps the adoption dialog open when the runtime changes during adoption', async () => {
    const consumerDetail: AgentDetail = {
      ...agentDetail,
      id: 'codex',
      displayName: 'Codex',
      iconKey: 'codex',
      skillsDir: '/Users/me/.codex/skills',
      skills: [],
      inheritsSharedSkills: true,
      inheritedManagedSkills: [],
      inheritedUnmanagedSkills: [makeSharedUnmanaged('shared-runtime')],
    }
    const localOverview = makeOverview()
    useSkillStoreV2.setState({
      runtimeEnvironmentId: LOCAL_RUNTIME_ENVIRONMENT_ID,
      overview: localOverview,
      lastOverviewLoadedAt: Date.now(),
      agents: [makeSidebarAgent('codex', 'Codex')],
      selectedAgentId: 'codex',
      selectedAgentDetail: consumerDetail,
      unmanaged: [],
    })
    vi.spyOn(skillApiV2, 'previewAdopt').mockResolvedValue({
      agentId: 'agents',
      unmanagedId: 'raw-shared-runtime',
      skillPath: '/Users/me/.agents/skills/shared-runtime',
      inferredSkillId: 'shared-runtime',
      hash: 'hash-shared-runtime',
      centerHasSameId: false,
      canQuickAdopt: true,
      options: [
        { value: 'import_cleanup', label: 'Import and clean up', destructive: true },
      ],
    })
    let resolveExecute: (skillId: string) => void = () => {}
    const executePromise = new Promise<string>((resolve) => {
      resolveExecute = resolve
    })
    const executeAdopt = vi.spyOn(skillApiV2, 'executeAdopt').mockReturnValue(executePromise)
    const listUnmanaged = vi.spyOn(skillApiV2, 'listUnmanaged').mockResolvedValue([])
    const getAgentDetail = vi.spyOn(skillApiV2, 'getAgentDetail').mockResolvedValue({
      ...consumerDetail,
      inheritedUnmanagedSkills: [],
    })
    const overview = vi.spyOn(skillApiV2, 'overview').mockResolvedValue(makeOverview())

    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Skills (1)' }))
    fireEvent.click(screen.getByRole('button', { name: '共享继承 1' }))
    fireEvent.click(screen.getByRole('button', { name: '未管理 1' }))
    fireEvent.click(screen.getByRole('button', { name: '接管' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认接管' }))
    await waitFor(() => expect(executeAdopt).toHaveBeenCalledTimes(1))
    const listCallsBeforeRuntimeChange = listUnmanaged.mock.calls.length
    const detailCallsBeforeRuntimeChange = getAgentDetail.mock.calls.length
    const overviewCallsBeforeRuntimeChange = overview.mock.calls.length

    act(() => {
      useSkillStoreV2.setState({ runtimeEnvironmentId: 'remote-runtime' })
      resolveExecute('shared-runtime')
    })

    expect(await screen.findByText(/运行环境已切换，已停止原环境的接管后续操作/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '接管 shared-runtime' })).toBeInTheDocument()
    expect(listUnmanaged).toHaveBeenCalledTimes(listCallsBeforeRuntimeChange)
    expect(getAgentDetail).toHaveBeenCalledTimes(detailCallsBeforeRuntimeChange)
    expect(overview).toHaveBeenCalledTimes(overviewCallsBeforeRuntimeChange)
    expect(useSkillStoreV2.getState().overview).toBe(localOverview)
  })

  it('does not write an old Agent detail after the runtime environment changes', async () => {
    const consumerDetail: AgentDetail = {
      ...agentDetail,
      id: 'codex',
      displayName: 'Codex',
      iconKey: 'codex',
      skillsDir: '/Users/me/.codex/skills',
      skills: [],
      inheritsSharedSkills: true,
      inheritedManagedSkills: [],
      inheritedUnmanagedSkills: [makeSharedUnmanaged('shared-runtime')],
    }
    useSkillStoreV2.setState({
      runtimeEnvironmentId: LOCAL_RUNTIME_ENVIRONMENT_ID,
      overview: makeOverview(),
      lastOverviewLoadedAt: Date.now(),
      agents: [makeSidebarAgent('codex', 'Codex')],
      selectedAgentId: 'codex',
      selectedAgentDetail: consumerDetail,
      unmanaged: [],
    })
    vi.spyOn(skillApiV2, 'previewAdopt').mockResolvedValue({
      agentId: 'agents',
      unmanagedId: 'raw-shared-runtime',
      skillPath: '/Users/me/.agents/skills/shared-runtime',
      inferredSkillId: 'shared-runtime',
      hash: 'hash-shared-runtime',
      centerHasSameId: false,
      canQuickAdopt: true,
      options: [
        { value: 'import_cleanup', label: 'Import and clean up', destructive: true },
      ],
    })
    vi.spyOn(skillApiV2, 'executeAdopt').mockResolvedValue('shared-runtime')
    vi.spyOn(skillApiV2, 'listUnmanaged').mockResolvedValue([])
    let resolveDetail: (detail: AgentDetail) => void = () => {}
    const detailPromise = new Promise<AgentDetail>((resolve) => {
      resolveDetail = resolve
    })
    const getAgentDetail = vi.spyOn(skillApiV2, 'getAgentDetail').mockReturnValue(detailPromise)
    const overview = vi.spyOn(skillApiV2, 'overview').mockResolvedValue(makeOverview())

    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Skills (1)' }))
    fireEvent.click(screen.getByRole('button', { name: '共享继承 1' }))
    fireEvent.click(screen.getByRole('button', { name: '未管理 1' }))
    fireEvent.click(screen.getByRole('button', { name: '接管' }))
    const confirmAdopt = await screen.findByRole('button', { name: '确认接管' })
    const overviewCallsBeforeAdopt = overview.mock.calls.length
    fireEvent.click(confirmAdopt)
    await waitFor(() => expect(getAgentDetail).toHaveBeenCalledTimes(1))

    const remoteAgent = makeSidebarAgent('remote-codex', 'Remote Codex')
    const remoteDetail: AgentDetail = {
      ...consumerDetail,
      id: remoteAgent.id,
      displayName: remoteAgent.displayName,
      skillsDir: '/home/me/.codex/skills',
      inheritsSharedSkills: false,
      inheritedManagedSkills: [],
      inheritedUnmanagedSkills: [],
    }
    const remoteOverview = {
      ...makeOverview(),
      metrics: { centerSkillCount: 9, targetCount: 8, unmanagedCount: 1, issueCount: 0 },
      agents: [remoteAgent],
    }
    const remoteUnmanaged: UnmanagedItemDto[] = [
      {
        id: 'remote-unmanaged',
        agentId: remoteAgent.id,
        itemType: 'skill',
        path: '/home/me/.codex/skills/remote-skill',
        inferredSkillId: 'remote-skill',
        hash: null,
        reason: 'not_in_center_library',
      },
    ]
    act(() => {
      useSkillStoreV2.setState({
        runtimeEnvironmentId: 'remote-runtime',
        overview: remoteOverview,
        agents: [remoteAgent],
        selectedAgentId: remoteAgent.id,
        selectedAgentDetail: remoteDetail,
        unmanaged: remoteUnmanaged,
      })
      resolveDetail({
        ...consumerDetail,
        inheritedUnmanagedSkills: [],
      })
    })

    expect(await screen.findByText(/运行环境已切换，已丢弃原环境的刷新结果/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '接管 shared-runtime' })).toBeInTheDocument()
    expect(overview).toHaveBeenCalledTimes(overviewCallsBeforeAdopt)
    expect(useSkillStoreV2.getState().selectedAgentDetail).toBe(remoteDetail)
    expect(useSkillStoreV2.getState().overview).toBe(remoteOverview)
    expect(useSkillStoreV2.getState().unmanaged).toBe(remoteUnmanaged)
  })

  it('does not write an old overview after the runtime environment changes', async () => {
    const consumerDetail: AgentDetail = {
      ...agentDetail,
      id: 'codex',
      displayName: 'Codex',
      iconKey: 'codex',
      skillsDir: '/Users/me/.codex/skills',
      skills: [],
      inheritsSharedSkills: true,
      inheritedManagedSkills: [],
      inheritedUnmanagedSkills: [makeSharedUnmanaged('shared-runtime')],
    }
    useSkillStoreV2.setState({
      runtimeEnvironmentId: LOCAL_RUNTIME_ENVIRONMENT_ID,
      overview: makeOverview(),
      lastOverviewLoadedAt: Date.now(),
      agents: [makeSidebarAgent('codex', 'Codex')],
      selectedAgentId: 'codex',
      selectedAgentDetail: consumerDetail,
      unmanaged: [],
    })
    vi.spyOn(skillApiV2, 'previewAdopt').mockResolvedValue({
      agentId: 'agents',
      unmanagedId: 'raw-shared-runtime',
      skillPath: '/Users/me/.agents/skills/shared-runtime',
      inferredSkillId: 'shared-runtime',
      hash: 'hash-shared-runtime',
      centerHasSameId: false,
      canQuickAdopt: true,
      options: [
        { value: 'import_cleanup', label: 'Import and clean up', destructive: true },
      ],
    })
    vi.spyOn(skillApiV2, 'executeAdopt').mockResolvedValue('shared-runtime')
    vi.spyOn(skillApiV2, 'listUnmanaged').mockResolvedValue([])
    vi.spyOn(skillApiV2, 'getAgentDetail').mockResolvedValue({
      ...consumerDetail,
      inheritedUnmanagedSkills: [],
    })
    let resolveOverview: (overview: ReturnType<typeof makeOverview>) => void = () => {}
    const overviewPromise = new Promise<ReturnType<typeof makeOverview>>((resolve) => {
      resolveOverview = resolve
    })
    const overview = vi.spyOn(skillApiV2, 'overview').mockResolvedValue(makeOverview())

    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Skills (1)' }))
    fireEvent.click(screen.getByRole('button', { name: '共享继承 1' }))
    fireEvent.click(screen.getByRole('button', { name: '未管理 1' }))
    fireEvent.click(screen.getByRole('button', { name: '接管' }))
    const confirmAdopt = await screen.findByRole('button', { name: '确认接管' })
    const overviewCallsBeforeAdopt = overview.mock.calls.length
    overview.mockReturnValueOnce(overviewPromise)
    fireEvent.click(confirmAdopt)
    await waitFor(() => expect(overview).toHaveBeenCalledTimes(overviewCallsBeforeAdopt + 1))

    const remoteAgent = makeSidebarAgent('remote-codex', 'Remote Codex')
    const remoteDetail: AgentDetail = {
      ...consumerDetail,
      id: remoteAgent.id,
      displayName: remoteAgent.displayName,
      skillsDir: '/home/me/.codex/skills',
      inheritsSharedSkills: false,
      inheritedManagedSkills: [],
      inheritedUnmanagedSkills: [],
    }
    const remoteOverview = {
      ...makeOverview(),
      metrics: { centerSkillCount: 9, targetCount: 8, unmanagedCount: 1, issueCount: 0 },
      agents: [remoteAgent],
    }
    const remoteUnmanaged: UnmanagedItemDto[] = [
      {
        id: 'remote-unmanaged',
        agentId: remoteAgent.id,
        itemType: 'skill',
        path: '/home/me/.codex/skills/remote-skill',
        inferredSkillId: 'remote-skill',
        hash: null,
        reason: 'not_in_center_library',
      },
    ]
    act(() => {
      useSkillStoreV2.setState({
        runtimeEnvironmentId: 'remote-runtime',
        overview: remoteOverview,
        agents: [remoteAgent],
        selectedAgentId: remoteAgent.id,
        selectedAgentDetail: remoteDetail,
        unmanaged: remoteUnmanaged,
      })
      resolveOverview({
        ...makeOverview(),
        metrics: { centerSkillCount: 1, targetCount: 1, unmanagedCount: 0, issueCount: 0 },
      })
    })

    expect(await screen.findByText(/运行环境已切换，已丢弃原环境的刷新结果/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '接管 shared-runtime' })).toBeInTheDocument()
    expect(useSkillStoreV2.getState().selectedAgentDetail).toBe(remoteDetail)
    expect(useSkillStoreV2.getState().overview).toBe(remoteOverview)
    expect(useSkillStoreV2.getState().unmanaged).toBe(remoteUnmanaged)
  })
})

function makeOverview() {
  return {
    metrics: { centerSkillCount: 0, targetCount: 0, unmanagedCount: 0, issueCount: 0 },
    skills: [],
    agents: [],
    packs: [],
    issues: [],
    settings: {
      centerPath: '~/.agents/skills',
      sqlitePath: '~/.agentbro/skill-manager.db',
      defaultDistributeMode: 'link' as const,
      linkFailPolicy: 'ask' as const,
      startupScan: true,
      showUnmanaged: true,
    },
  }
}

