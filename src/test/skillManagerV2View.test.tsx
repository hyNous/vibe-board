import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { AgentIconBadge } from '../components/skills-v2/AgentIconBadge'
import { LOCAL_RUNTIME_ENVIRONMENT_ID, useSkillStoreV2 } from '../stores/skillStoreV2'
import { useSessionStore } from '../stores/sessionStore'
import { skillApiV2 } from '../services/skillApiV2'
import { agentApi, type AgentProgramInfo } from '../services/agentApi'
import { open as openShell } from '@tauri-apps/plugin-shell'
import i18n from '../i18n'
import type { SkillSummary, AgentSummary, AgentDetail, AgentSkillInventoryAgent, AdoptPreview, DistributionPreview, SkillDetail, SkillTargetDetail, UnmanagedItemDto } from '../services/skillApiV2'
import type { AgentType, SessionState } from '../types/agent'

// SkillManagerShell imports pages that call skillApiV2 at mount; we stub the api
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

function makeTarget(overrides: Partial<SkillTargetDetail> = {}): SkillTargetDetail {
  return {
    id: 'target-claude',
    skillId: 'release-checklist',
    agentId: 'claude-code',
    targetPath: '/Users/me/.claude/skills/release-checklist',
    resolvedTargetPath: null,
    installMode: 'link',
    actualMode: 'link',
    sourceHash: 'hash1',
    currentHash: 'hash1',
    status: 'ok',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    claims: [],
    ...overrides,
  }
}

function makeSharedTarget(skillId: string, overrides: Partial<SkillTargetDetail> = {}): SkillTargetDetail {
  return makeTarget({
    id: `target-${skillId}`,
    skillId,
    agentId: 'agents',
    targetPath: `/Users/me/.agents/skills/${skillId}`,
    resolvedTargetPath: `/Users/me/.agentbro/skills/${skillId}`,
    claims: [{
      id: `claim-${skillId}`,
      claimType: 'direct',
      packId: null,
      packName: null,
      createdAt: '2026-01-01T00:00:00Z',
    }],
    ...overrides,
  })
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

function makeSidebarSession(agentType: AgentType, overrides: Partial<SessionState> = {}): SessionState {
  const now = Date.now()
  return {
    id: `${agentType}-session`,
    agentType,
    project: 'Project',
    terminal: 'Terminal',
    phase: 'processing',
    startedAt: now,
    duration: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    chatHistory: [],
    subagents: [],
    activeTools: [],
    ...overrides,
  }
}

describe('AgentIconBadge', () => {
  beforeEach(cleanup)

  it('renders an agent label and copy modifier', () => {
    const { container } = render(<AgentIconBadge iconKey="codex" mode="copy" />)
    // codex has a real icon asset → renders an <img>
    expect(container.querySelector('img')).not.toBeNull()
    expect(container.querySelector('.sm2__agent-badge--copy')).not.toBeNull()
  })

  it('falls back gracefully for unknown agents', () => {
    const { container } = render(<AgentIconBadge iconKey="mystery-agent" />)
    expect(container.textContent).toContain('my')
  })
})

describe('Skill library view mode (no Agent matrix)', () => {
  beforeEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useSkillStoreV2.setState({
      activeTab: 'library',
      activeInstallTab: 'official',
      viewMode: 'cards',
      filters: { query: '', source: '', status: '', type: '' },
      skills: [
        makeSkill(),
        makeSkill({ id: 'db-debug', name: 'Database Debugging', status: 'copyDiverged', installedAgents: [] }),
      ],
      overview: {
        metrics: { centerSkillCount: 2, targetCount: 2, unmanagedCount: 0, issueCount: 0 },
        skills: [],
        agents: [],
        issues: [],
        settings: {
          centerPath: '~/.agentbro/skills',
          sqlitePath: '~/.agentbro/skill-manager.db',
          defaultDistributeMode: 'link',
          linkFailPolicy: 'ask',
          startupScan: true,
          showUnmanaged: true,
        },
      },
      settings: useSkillStoreV2.getState().overview?.settings ?? null,
      agents: [
        {
          id: 'codex',
          displayName: 'Codex',
          iconKey: 'codex',
          enabled: true,
          skillsDir: '/Users/me/.codex/skills',
          version: '1.0.0',
          latestVersion: null,
          installed: true,
          managedSkillCount: 0,
          unmanagedSkillCount: 0,
        },
      ],
      loading: false,
      error: null,
      initialized: true,
      selectedSkillId: null,
      selectedSkillDetail: null,
    })
  })

  it('opens Agent sync from the unmanaged metric', async () => {
    const overview = useSkillStoreV2.getState().overview!
    useSkillStoreV2.setState({
      overview: {
        ...overview,
        metrics: { ...overview.metrics, unmanagedCount: 1 },
      },
    })
    vi.spyOn(skillApiV2, 'listAgentSkillInventory').mockResolvedValue([])

    const { SkillManagerShell } = await import('../components/skills-v2/SkillManagerShell')
    render(<SkillManagerShell />)

    fireEvent.click(screen.getByRole('button', { name: '未管理 1' }))

    expect(useSkillStoreV2.getState().activeTab).toBe('install')
    expect(useSkillStoreV2.getState().activeInstallTab).toBe('agent')
    expect(screen.getByRole('button', { name: /Agent 同步/ })).toHaveClass('sm2__install-page-tab--active')
    expect(await screen.findByText('待处理收纳箱')).toBeInTheDocument()
  })

  it('renders both skills as cards by default', async () => {
    const { SkillLibraryPage } = await import('../components/skills-v2/SkillLibraryPage')
    render(<SkillLibraryPage />)
    expect(screen.getByText('Release Checklist')).toBeInTheDocument()
    expect(screen.getByText('Database Debugging')).toBeInTheDocument()
  })

  it('marks skills with changed copy installs in card and list views', async () => {
    useSkillStoreV2.setState({
      skills: [
        makeSkill({
          status: 'copyDiverged',
          installedAgents: [
            { agentId: 'codex', displayName: 'Codex', iconKey: 'codex', mode: 'copy', status: 'copy_modified' },
          ],
        }),
      ],
    })

    const { SkillLibraryPage } = await import('../components/skills-v2/SkillLibraryPage')
    render(<SkillLibraryPage />)

    expect(screen.getByText('Diff')).toBeInTheDocument()
    expect(screen.getByText('1 个副本有变更')).toBeInTheDocument()
    expect(document.body.querySelector('.sm2__copy-diff-strip')).toBeNull()

    fireEvent.click(screen.getByText('列表'))
    expect(screen.getByText(/Local folder · 副本分叉/)).toBeInTheDocument()
    expect(screen.getByText('1 个副本有变更')).toBeInTheDocument()
  })

  it('switches to list view and keeps content', async () => {
    const { SkillLibraryPage } = await import('../components/skills-v2/SkillLibraryPage')
    render(<SkillLibraryPage />)
    fireEvent.click(screen.getByText('列表'))
    expect(useSkillStoreV2.getState().viewMode).toBe('list')
    expect(screen.getByText('Release Checklist')).toBeInTheDocument()
    fireEvent.click(screen.getByText('卡片'))
    expect(useSkillStoreV2.getState().viewMode).toBe('cards')
  })

  it('does not render an Agent column matrix', async () => {
    const { SkillLibraryPage } = await import('../components/skills-v2/SkillLibraryPage')
    const { container } = render(<SkillLibraryPage />)
    // there must be no <table> in the library main area
    expect(container.querySelector('table')).toBeNull()
  })

  it('localizes source type labels in library cards and list rows', async () => {
    await i18n.changeLanguage('zh')
    useSkillStoreV2.setState({
      skills: [
        makeSkill({
          id: 'lark-wiki',
          name: 'lark-wiki',
          sourceType: 'agent_import',
          installedAgents: [],
        }),
      ],
    })

    const { SkillLibraryPage } = await import('../components/skills-v2/SkillLibraryPage')
    render(<SkillLibraryPage />)

    expect(screen.getAllByText('Agent 导入').length).toBeGreaterThan(0)
    expect(screen.queryByText('agent_import')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('列表'))
    expect(screen.getByText(/Agent 导入 · 正常/)).toBeInTheDocument()
    expect(screen.queryByText(/agent_import/)).not.toBeInTheDocument()
  })

  it('offers the three Skill origins as filters and puts each Skill in exactly one', async () => {
    await i18n.changeLanguage('zh')
    useSkillStoreV2.setState({
      filters: { query: '', source: '', status: '', type: '' },
      skills: [
        makeSkill({ id: 'custom-skill', name: 'Custom Skill', sourceType: 'local_folder' }),
        makeSkill({ id: 'github-skill', name: 'GitHub Skill', sourceType: 'github', sourceUri: 'github:owner/repo' }),
        makeSkill({ id: 'agent-skill', name: 'Agent Skill', sourceType: 'agent_import' }),
      ],
    })

    const { SkillLibraryPage } = await import('../components/skills-v2/SkillLibraryPage')
    render(<SkillLibraryPage />)

    fireEvent.click(screen.getByRole('button', { name: /^来源/ }))
    for (const label of ['全部来源', '自定义', 'GitHub', '从 Agent 同步']) {
      expect(screen.getByRole('option', { name: label })).toBeInTheDocument()
    }

    fireEvent.click(screen.getByRole('option', { name: 'GitHub' }))
    expect(useSkillStoreV2.getState().filters.source).toBe('github')
    expect(screen.getByText('GitHub Skill')).toBeInTheDocument()
    expect(screen.queryByText('Custom Skill')).not.toBeInTheDocument()
    expect(screen.queryByText('Agent Skill')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^来源/ }))
    fireEvent.click(screen.getByRole('option', { name: '从 Agent 同步' }))
    expect(screen.getByText('Agent Skill')).toBeInTheDocument()
    expect(screen.queryByText('GitHub Skill')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^来源/ }))
    fireEvent.click(screen.getByRole('option', { name: '自定义' }))
    expect(screen.getByText('Custom Skill')).toBeInTheDocument()
    expect(screen.queryByText('Agent Skill')).not.toBeInTheDocument()
  })

  it('previews distribution for multiple selected skills at once', async () => {
    const previewDistribute = vi.spyOn(skillApiV2, 'previewDistribute').mockResolvedValue({
      skillIds: ['release-checklist', 'db-debug'],
      targetAgents: ['codex'],
      requestedMode: 'link',
      changes: [],
      blockers: [],
      blockerDecisions: [],
    })

    const { SkillLibraryPage } = await import('../components/skills-v2/SkillLibraryPage')
    render(<SkillLibraryPage />)

    fireEvent.click(screen.getByRole('button', { name: '批量管理' }))
    fireEvent.click(screen.getByLabelText('选择 Release Checklist'))
    fireEvent.click(screen.getByLabelText('选择 Database Debugging'))
    fireEvent.click(screen.getByRole('button', { name: /^让 2 个 Skill 生效$/ }))

    fireEvent.click(screen.getByText('Codex'))
    fireEvent.click(screen.getByRole('button', { name: '预览影响' }))

    await waitFor(() => {
      expect(previewDistribute).toHaveBeenCalledWith(['release-checklist', 'db-debug'], ['codex'], 'link')
    })
  })

  it('renders center delete choices as sibling footer actions', async () => {
    vi.spyOn(skillApiV2, 'getSkillDetail').mockResolvedValue({
      ...makeSkill(),
      frontmatter: {},
      files: null,
      targets: [],
      source: null,
    })
    vi.spyOn(skillApiV2, 'previewDeleteCenterSkill').mockResolvedValue({
      skillId: 'release-checklist',
      affectedTargets: [
        {
          targetId: 'target-claude',
          agentId: 'claude-code',
          displayName: 'Claude Code',
          targetPath: '/Users/me/.claude/skills/release-checklist',
          mode: 'link',
          claimCount: 1,
        },
        {
          targetId: 'target-codex',
          agentId: 'codex',
          displayName: 'Codex',
          targetPath: '/Users/me/.codex/skills/release-checklist',
          mode: 'copy',
          claimCount: 1,
        },
      ],
      removable: false,
      warnings: [],
    })

    const { SkillLibraryPage } = await import('../components/skills-v2/SkillLibraryPage')
    render(<SkillLibraryPage />)

    fireEvent.click(screen.getByText('Release Checklist'))
    fireEvent.click(await screen.findByRole('button', { name: '删除' }))

    const preserve = await screen.findByRole('button', { name: '删除但保留Agent副本' })
    const removeAll = screen.getByRole('button', { name: '删除并且移除Agent安装' })
    const actions = preserve.closest('.sm2__modal-actions')

    expect(actions).not.toBeNull()
    expect(actions).toContainElement(removeAll)
    expect(preserve).toHaveClass('sm2-delete-skill__choice')
    expect(removeAll).toHaveClass('sm2-delete-skill__choice')
    expect(preserve).not.toHaveClass('sm2__btn--primary')
    expect(removeAll).not.toHaveClass('sm2__btn--primary')
    expect(document.body.querySelector('.sm2-delete-skill__note')).not.toBeNull()
    expect(document.body.querySelector('.sm2-delete-skill__warnings')).toBeNull()
    expect(document.body.querySelector('.sm2-delete-skill__inline-action')).toBeNull()
  })

  it('deletes multiple selected center skills from the library', async () => {
    const previewDelete = vi.spyOn(skillApiV2, 'previewDeleteCenterSkills').mockResolvedValue({
      skillId: 'release-checklist',
      skillIds: ['release-checklist', 'db-debug'],
      affectedTargets: [
        {
          targetId: 'target-claude',
          agentId: 'claude-code',
          displayName: 'Claude Code',
          targetPath: '/Users/me/.claude/skills/release-checklist',
          mode: 'link',
          claimCount: 1,
        },
      ],
      removable: false,
      warnings: [],
    })
    const executeDelete = vi.spyOn(skillApiV2, 'executeDeleteCenterSkills').mockResolvedValue(undefined)

    const { SkillLibraryPage } = await import('../components/skills-v2/SkillLibraryPage')
    render(<SkillLibraryPage />)

    fireEvent.click(screen.getByRole('button', { name: '批量管理' }))
    fireEvent.click(screen.getByLabelText('选择 Release Checklist'))
    fireEvent.click(screen.getByLabelText('选择 Database Debugging'))
    fireEvent.click(screen.getByRole('button', { name: /^删除 2 个 Skill$/ }))

    expect(await screen.findByRole('heading', { name: '批量删除 2 个 Skill' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '删除但保留Agent副本' }))

    await waitFor(() => {
      expect(previewDelete).toHaveBeenCalledWith(['release-checklist', 'db-debug'])
      expect(executeDelete).toHaveBeenCalledWith(['release-checklist', 'db-debug'], false)
    })
  })

  it('can delete multiple agent distributions from the skill detail agent tab', async () => {
    const initialDetail: SkillDetail = {
      ...makeSkill(),
      frontmatter: {},
      files: null,
      targets: [
        makeTarget(),
        makeTarget({
          id: 'target-codex',
          agentId: 'codex',
          targetPath: '/Users/me/.codex/skills/release-checklist',
          installMode: 'copy',
          actualMode: 'copy',
        }),
      ],
      source: null,
    }
    const refreshedDetail: SkillDetail = {
      ...initialDetail,
      targets: [],
      installedAgents: [],
    }
    vi.spyOn(skillApiV2, 'getSkillDetail')
      .mockResolvedValueOnce(initialDetail)
      .mockResolvedValueOnce(refreshedDetail)
    const deleteDistribution = vi.spyOn(skillApiV2, 'deleteSkillTargetDistribution').mockResolvedValue(undefined)

    const { SkillDetailSlider } = await import('../components/skills-v2/SkillDetailSlider')
    render(
      <SkillDetailSlider
        skillId="release-checklist"
        open
        onClose={() => {}}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Agent (2)' }))
    fireEvent.click(screen.getByRole('button', { name: '批量移除' }))
    fireEvent.click(screen.getByLabelText('选择 Claude Code 的 Skill 生效'))
    fireEvent.click(screen.getByLabelText('选择 Codex 的 Skill 生效'))
    fireEvent.click(screen.getByRole('button', { name: '移除 2 个生效' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }))

    await waitFor(() => {
      expect(deleteDistribution).toHaveBeenCalledWith('target-claude')
      expect(deleteDistribution).toHaveBeenCalledWith('target-codex')
    })
    expect(deleteDistribution).toHaveBeenCalledTimes(2)
  })
})

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

  it('shows Git repo skills as cards by default and can switch to list view', async () => {
    const { GitPanel } = await import('../components/skills-v2/InstallView')
    const { container } = render(<GitPanel initialUrl="https://github.com/anthropics/skills" onDone={() => {}} />)

    fireEvent.click(screen.getByText('检测 Skill'))
    expect(await screen.findAllByText('algorithmic-art')).toHaveLength(2)

    expect(container.querySelector('.sm2__git-skill-grid')).not.toBeNull()
    expect(container.querySelector('.sm2__git-skill-list')).toBeNull()

    fireEvent.click(screen.getByText('列表'))
    expect(container.querySelector('.sm2__git-skill-list')).not.toBeNull()
    expect(container.querySelector('.sm2__git-skill-grid')).toBeNull()
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

  it('can bulk overwrite conflicting local imports', async () => {
    vi.spyOn(skillApiV2, 'previewAddCenterSkill').mockResolvedValue({
      centerPath: '/Users/me/.agentbro/skills',
      candidates: [],
      blockers: [
        {
          skillId: 'sz-news-video',
          proposedSkillId: 'sz-news-video',
          name: 'sz-news-video',
          description: 'Video skill',
          sourceDir: '/Users/me/code/szskills/sz-news-video',
          hash: 'hash-video',
          action: 'blocked_same_name_diff_source',
          existingSourceType: 'local_folder',
          reason: "A different skill already uses id 'sz-news-video'. Choose overwrite, rename, or skip.",
        },
        {
          skillId: 'sz-x-feed',
          proposedSkillId: 'sz-x-feed',
          name: 'sz-x-feed',
          description: 'Feed skill',
          sourceDir: '/Users/me/code/szskills/sz-x-feed',
          hash: 'hash-feed',
          action: 'blocked_same_name_diff_source',
          existingSourceType: 'local_folder',
          reason: "A different skill already uses id 'sz-x-feed'. Choose overwrite, rename, or skip.",
        },
      ],
    })
    const executeAdd = vi.spyOn(skillApiV2, 'executeAddCenterSkill').mockResolvedValue({
      skillIds: [],
      updated: ['sz-news-video', 'sz-x-feed'],
      skipped: [],
    })
    vi.spyOn(window, 'alert').mockImplementation(() => {})

    const { LocalPanel } = await import('../components/skills-v2/InstallView')
    render(<LocalPanel onDone={() => {}} />)

    fireEvent.change(screen.getByPlaceholderText('选择或粘贴包含 SKILL.md 的目录 / .zip'), {
      target: { value: '/Users/me/code/szskills' },
    })
    fireEvent.click(screen.getByRole('button', { name: '预览导入' }))

    fireEvent.click(await screen.findByLabelText('覆盖冲突项'))
    fireEvent.click(screen.getByRole('button', { name: '执行导入' }))

    await waitFor(() => {
      expect(executeAdd).toHaveBeenCalledWith({
        sourcePath: '/Users/me/code/szskills',
        sourceType: 'local_folder',
        sourceUri: '/Users/me/code/szskills',
        importMode: 'copy',
      }, [
        { skillId: 'sz-news-video', resolution: 'update' },
        { skillId: 'sz-x-feed', resolution: 'update' },
      ])
    })
  })

  it('hides symlink import choices for zip archives', async () => {
    const previewAdd = vi.spyOn(skillApiV2, 'previewAddCenterSkill').mockResolvedValue({
      centerPath: '/Users/me/.agentbro/skills',
      candidates: [],
      blockers: [],
    })

    const { LocalPanel } = await import('../components/skills-v2/InstallView')
    render(<LocalPanel onDone={() => {}} />)

    fireEvent.change(screen.getByPlaceholderText('选择或粘贴包含 SKILL.md 的目录 / .zip'), {
      target: { value: '/Users/me/Downloads/skills.zip' },
    })

    expect(screen.queryByLabelText('软链导入，本地目录作为源')).not.toBeInTheDocument()
    expect(screen.queryByText('批量导入（该目录包含多个 Skill）')).not.toBeInTheDocument()
    expect(screen.getByText('压缩包会解压后复制导入中心库，不支持软链导入。')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '预览导入' }))
    await waitFor(() => {
      expect(previewAdd).toHaveBeenCalledWith({
        sourcePath: '/Users/me/Downloads/skills.zip',
        sourceType: 'archive',
        sourceUri: undefined,
        importMode: 'copy',
      })
    })
  })

  it('shows no unchanged skills and prevents a redundant import', async () => {
    vi.spyOn(skillApiV2, 'previewAddCenterSkill').mockResolvedValue({
      centerPath: '/Users/me/.agentbro/skills',
      candidates: [],
      blockers: [],
      unchangedCount: 40,
    })

    const { LocalPanel } = await import('../components/skills-v2/InstallView')
    render(<LocalPanel onDone={() => {}} />)

    fireEvent.change(screen.getByPlaceholderText('选择或粘贴包含 SKILL.md 的目录 / .zip'), {
      target: { value: '/Users/me/code/szskills' },
    })
    fireEvent.click(screen.getByRole('button', { name: '预览导入' }))

    expect(await screen.findByText('没有检测到新增或变更，40 个 Skill 均无需重复导入。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '无需导入' })).toBeDisabled()
  })

})

describe('Agent sync local agent chips', () => {
  beforeEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('shows a task-focused pending inbox by default and hides managed skills', async () => {
    const { skillApiV2 } = await import('../services/skillApiV2')
    const inventory: AgentSkillInventoryAgent[] = [
      {
        agentId: 'claude-code',
        displayName: 'Claude Code',
        iconKey: 'claude-code',
        skillsDir: '/Users/me/.claude/skills',
        installed: true,
        managedCount: 3,
        unmanagedCount: 2,
        importableCount: 1,
        items: [
          {
            id: 'managed-alpha',
            agentId: 'claude-code',
            skillId: 'managed-alpha',
            name: 'managed-alpha',
            path: '/Users/me/.claude/skills/managed-alpha',
            managed: true,
            canImport: false,
            status: 'managed',
            statusLabel: '已管理',
            reason: null,
            targetId: 'target-managed-alpha',
            actualMode: 'link',
            hash: 'hash-managed-alpha',
          },
          {
            id: 'local-alpha',
            agentId: 'claude-code',
            skillId: 'alpha',
            name: 'alpha',
            path: '/Users/me/.claude/skills/alpha',
            managed: false,
            canImport: true,
            status: 'unmanaged',
            statusLabel: '未管理',
            reason: null,
            targetId: null,
            actualMode: null,
            hash: 'hash-alpha',
          },
          {
            id: 'local-bird',
            agentId: 'claude-code',
            skillId: 'bird',
            name: 'bird',
            path: '/Users/me/.claude/skills/bird',
            managed: false,
            canImport: false,
            status: 'conflict',
            statusLabel: '未管理 · 同名冲突',
            reason: 'same_name_as_center_skill',
            targetId: null,
            actualMode: null,
            hash: 'hash-bird',
          },
        ],
      },
    ]
    vi.spyOn(skillApiV2, 'listAgentSkillInventory').mockResolvedValueOnce(inventory)

    const { AgentSyncPanel } = await import('../components/skills-v2/InstallView')
    render(<AgentSyncPanel onDone={() => {}} />)

    expect(await screen.findByText('发现 1 个可接管 Skill，1 个同名冲突')).toBeInTheDocument()
    expect(screen.queryByText('把散落在各 Agent 里的 Skills 收进中心库')).not.toBeInTheDocument()
    expect(screen.getByText('待处理收纳箱')).toBeInTheDocument()
    expect(screen.getByText('alpha')).toBeInTheDocument()
    expect(screen.getByText('bird')).toBeInTheDocument()
    expect(screen.queryByText('managed-alpha')).not.toBeInTheDocument()
    expect(screen.getByText('3 已管理，默认隐藏')).toBeInTheDocument()
  })

  it('can reveal managed skills from advanced controls', async () => {
    const { skillApiV2 } = await import('../services/skillApiV2')
    const inventory: AgentSkillInventoryAgent[] = [
      {
        agentId: 'claude-code',
        displayName: 'Claude Code',
        iconKey: 'claude-code',
        skillsDir: '/Users/me/.claude/skills',
        installed: true,
        managedCount: 1,
        unmanagedCount: 1,
        importableCount: 1,
        items: [
          {
            id: 'managed-alpha',
            agentId: 'claude-code',
            skillId: 'managed-alpha',
            name: 'managed-alpha',
            path: '/Users/me/.claude/skills/managed-alpha',
            managed: true,
            canImport: false,
            status: 'managed',
            statusLabel: '已管理',
            reason: null,
            targetId: 'target-managed-alpha',
            actualMode: 'link',
            hash: 'hash-managed-alpha',
          },
          {
            id: 'local-alpha',
            agentId: 'claude-code',
            skillId: 'alpha',
            name: 'alpha',
            path: '/Users/me/.claude/skills/alpha',
            managed: false,
            canImport: true,
            status: 'unmanaged',
            statusLabel: '未管理',
            reason: null,
            targetId: null,
            actualMode: null,
            hash: 'hash-alpha',
          },
        ],
      },
    ]
    vi.spyOn(skillApiV2, 'listAgentSkillInventory').mockResolvedValueOnce(inventory)

    const { AgentSyncPanel } = await import('../components/skills-v2/InstallView')
    render(<AgentSyncPanel onDone={() => {}} />)

    expect(await screen.findByText('alpha')).toBeInTheDocument()
    expect(screen.queryByText('managed-alpha')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '高级查看' }))
    fireEvent.click(screen.getByLabelText('显示已管理 Skills'))
    expect(screen.getByText('managed-alpha')).toBeInTheDocument()
  })

  it('deletes a managed skill distribution from the agent sync detail', async () => {
    const { skillApiV2 } = await import('../services/skillApiV2')
    const before: AgentSkillInventoryAgent[] = [
      {
        agentId: 'claude-code',
        displayName: 'Claude Code',
        iconKey: 'claude-code',
        skillsDir: '/Users/me/.claude/skills',
        installed: true,
        managedCount: 1,
        unmanagedCount: 0,
        importableCount: 0,
        items: [
          {
            id: 'managed-alpha',
            agentId: 'claude-code',
            skillId: 'managed-alpha',
            name: 'managed-alpha',
            path: '/Users/me/.claude/skills/managed-alpha',
            managed: true,
            canImport: false,
            status: 'managed',
            statusLabel: '已管理',
            reason: null,
            targetId: 'target-managed-alpha',
            actualMode: 'link',
            hash: 'hash-managed-alpha',
          },
        ],
      },
    ]
    const after: AgentSkillInventoryAgent[] = [
      { ...before[0], managedCount: 0, items: [] },
    ]
    vi.spyOn(skillApiV2, 'listAgentSkillInventory')
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after)
    vi.spyOn(skillApiV2, 'readFileTree').mockResolvedValueOnce({
      name: 'managed-alpha',
      nodeType: 'dir',
      path: '/Users/me/.claude/skills/managed-alpha',
      children: [],
    })
    vi.spyOn(skillApiV2, 'readFileContent').mockResolvedValueOnce('# Managed Alpha')
    const deleteTargets = vi.spyOn(skillApiV2, 'deleteSkillTargetDistributions').mockResolvedValue({ deleted: 1, failures: [] })
    const onDone = vi.fn()

    const { AgentSyncPanel } = await import('../components/skills-v2/InstallView')
    render(<AgentSyncPanel onDone={onDone} />)

    expect(await screen.findByText('1 已管理，默认隐藏')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '高级查看' }))
    fireEvent.click(screen.getByLabelText('显示已管理 Skills'))
    fireEvent.click(screen.getByText('managed-alpha'))
    fireEvent.click(await screen.findByRole('button', { name: '移除' }))
    expect(screen.getByRole('dialog', { name: '从 Agent 移除「managed-alpha」' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))

    await waitFor(() => expect(deleteTargets).toHaveBeenCalledWith(['target-managed-alpha']))
    expect(onDone).toHaveBeenCalled()
    expect(await screen.findByText('本机 Agent Skills 已完成整理')).toBeInTheDocument()
  })

  it('keeps list and card views on the same pending dataset', async () => {
    const { skillApiV2 } = await import('../services/skillApiV2')
    const inventory: AgentSkillInventoryAgent[] = [
      {
        agentId: 'claude-code',
        displayName: 'Claude Code',
        iconKey: 'claude-code',
        skillsDir: '/Users/me/.claude/skills',
        installed: true,
        managedCount: 1,
        unmanagedCount: 1,
        importableCount: 1,
        items: [
          {
            id: 'managed-alpha',
            agentId: 'claude-code',
            skillId: 'managed-alpha',
            name: 'managed-alpha',
            path: '/Users/me/.claude/skills/managed-alpha',
            managed: true,
            canImport: false,
            status: 'managed',
            statusLabel: '已管理',
            reason: null,
            targetId: 'target-managed-alpha',
            actualMode: 'link',
            hash: 'hash-managed-alpha',
          },
          {
            id: 'local-alpha',
            agentId: 'claude-code',
            skillId: 'alpha',
            name: 'alpha',
            path: '/Users/me/.claude/skills/alpha',
            managed: false,
            canImport: true,
            status: 'unmanaged',
            statusLabel: '未管理',
            reason: null,
            targetId: null,
            actualMode: null,
            hash: 'hash-alpha',
          },
        ],
      },
    ]
    vi.spyOn(skillApiV2, 'listAgentSkillInventory').mockResolvedValueOnce(inventory)

    const { AgentSyncPanel } = await import('../components/skills-v2/InstallView')
    const { container } = render(<AgentSyncPanel onDone={() => {}} />)

    expect(await screen.findByText('alpha')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '列表' }))
    await waitFor(() => expect(container.querySelector('.sm2__agent-sync-listview')).not.toBeNull())
    expect(screen.queryByText('managed-alpha')).not.toBeInTheDocument()

    const listCheckbox = container.querySelector('.sm2__agent-sync-listview .sm2__agent-sync-checkbox') as HTMLInputElement
    fireEvent.click(listCheckbox)
    expect(listCheckbox).toBeChecked()

    fireEvent.click(screen.getByRole('button', { name: '卡片' }))

    expect(container.querySelector('.sm2__install-grid')).not.toBeNull()
    expect(screen.getByText('alpha')).toBeInTheDocument()
    expect(screen.queryByText('managed-alpha')).not.toBeInTheDocument()
    const selectedCard = container.querySelector('.sm2__agent-sync-card--selected')
    expect(selectedCard).not.toBeNull()
    expect(selectedCard?.querySelector('.sm2__agent-sync-checkbox')).toBeChecked()

    fireEvent.click(selectedCard!)
    expect(document.body.querySelector('.sm2__slideover-title')).toHaveTextContent('alpha')
    expect(document.body.querySelector('.sm2__slideover--skill-detail')).toHaveTextContent('/Users/me/.claude/skills/alpha')
  })

  it('only shows locally installed agents', async () => {
    const { skillApiV2 } = await import('../services/skillApiV2')
    const inventory: AgentSkillInventoryAgent[] = [
      {
        agentId: 'claude-code',
        displayName: 'Claude Code',
        iconKey: 'claude-code',
        skillsDir: '/Users/me/.claude/skills',
        installed: true,
        managedCount: 0,
        unmanagedCount: 1,
        importableCount: 1,
        items: [
          {
            id: 'claude-local-skill',
            agentId: 'claude-code',
            skillId: 'local-skill',
            name: 'local-skill',
            path: '/Users/me/.claude/skills/local-skill',
            managed: false,
            canImport: true,
            status: 'unmanaged',
            statusLabel: '未管理',
            reason: null,
            targetId: null,
            actualMode: null,
            hash: 'hash-1',
          },
        ],
      },
      {
        agentId: 'deepseek',
        displayName: 'DeepSeek',
        iconKey: 'deepseek',
        skillsDir: null,
        installed: false,
        managedCount: 0,
        unmanagedCount: 0,
        importableCount: 0,
        items: [],
      },
    ]
    vi.spyOn(skillApiV2, 'listAgentSkillInventory').mockResolvedValueOnce(inventory)

    const { AgentSyncPanel } = await import('../components/skills-v2/InstallView')
    const { container } = render(<AgentSyncPanel onDone={() => {}} />)

    const select = await screen.findByLabelText('选择 Agent') as HTMLSelectElement
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(['全部 Agent', 'Claude Code · 1 可接管'])
    expect(container.querySelector('.sm2__agent-sync-agent-strip')).toHaveTextContent('Claude Code')
    expect(screen.queryByText('DeepSeek')).not.toBeInTheDocument()
    expect(container.querySelector('.sm2__agent-sync-summary')).toHaveTextContent('1 Agent')
  })

  it('keeps config-only agent sources behind + in the Agent sync panel', async () => {
    const { skillApiV2 } = await import('../services/skillApiV2')
    const inventory: AgentSkillInventoryAgent[] = [
      {
        agentId: 'claude-code',
        displayName: 'Claude Code',
        iconKey: 'claude-code',
        skillsDir: '/Users/me/.claude/skills',
        installed: true,
        programInstalled: true,
        managedCount: 0,
        unmanagedCount: 1,
        importableCount: 1,
        items: [],
      },
      {
        agentId: 'kiro',
        displayName: 'Kiro',
        iconKey: 'kiro',
        skillsDir: '/Users/me/.kiro/skills',
        installed: true,
        programInstalled: false,
        managedCount: 0,
        unmanagedCount: 1,
        importableCount: 1,
        items: [],
      },
    ]
    vi.spyOn(skillApiV2, 'listAgentSkillInventory').mockResolvedValueOnce(inventory)

    const { AgentSyncPanel } = await import('../components/skills-v2/InstallView')
    const { container } = render(<AgentSyncPanel onDone={() => {}} />)

    await screen.findByText('Claude Code')
    expect(container.querySelector('.sm2__agent-sync-agent-strip')).not.toHaveTextContent('Kiro')

    fireEvent.click(screen.getByRole('button', { name: /其他 Agent/ }))

    expect(container.querySelector('.sm2__agent-sync-agent-strip')).toHaveTextContent('Kiro')
  })

  it('uses a compact agent dropdown sorted by local skill count', async () => {
    const { skillApiV2 } = await import('../services/skillApiV2')
    const inventory: AgentSkillInventoryAgent[] = [
      {
        agentId: 'claude-code',
        displayName: 'Claude Code',
        iconKey: 'claude-code',
        skillsDir: '/Users/me/.claude/skills',
        installed: true,
        managedCount: 2,
        unmanagedCount: 1,
        importableCount: 1,
        items: [],
      },
      {
        agentId: 'codex',
        displayName: 'Codex',
        iconKey: 'codex',
        skillsDir: '/Users/me/.codex/skills',
        installed: true,
        managedCount: 4,
        unmanagedCount: 3,
        importableCount: 2,
        items: [],
      },
      {
        agentId: 'deepseek',
        displayName: 'DeepSeek',
        iconKey: 'deepseek',
        skillsDir: null,
        installed: false,
        managedCount: 20,
        unmanagedCount: 20,
        importableCount: 20,
        items: [],
      },
    ]
    vi.spyOn(skillApiV2, 'listAgentSkillInventory').mockResolvedValueOnce(inventory)

    const { AgentSyncPanel } = await import('../components/skills-v2/InstallView')
    const { container } = render(<AgentSyncPanel onDone={() => {}} />)

    const select = await screen.findByLabelText('选择 Agent') as HTMLSelectElement
    const agentOptions = Array.from(select.options).map((option) => option.textContent)

    expect(agentOptions).toEqual(['全部 Agent', 'Codex · 2 可接管', 'Claude Code · 1 可接管'])
    expect(screen.queryByText('DeepSeek')).not.toBeInTheDocument()

    fireEvent.change(select, { target: { value: 'claude-code' } })
    expect(select.value).toBe('claude-code')
    expect(container.querySelector('.sm2__agent-sync-agent-card--active')).toHaveTextContent('Claude Code')
  })

  it('scopes summary actions and accessibility state to the selected agent', async () => {
    const { skillApiV2 } = await import('../services/skillApiV2')
    const inventory: AgentSkillInventoryAgent[] = [
      {
        agentId: 'codex',
        displayName: 'Codex',
        iconKey: 'codex',
        skillsDir: '/Users/me/.codex/skills',
        installed: true,
        managedCount: 0,
        unmanagedCount: 2,
        importableCount: 2,
        items: [
          {
            id: 'codex-alpha',
            agentId: 'codex',
            skillId: 'alpha',
            name: 'alpha',
            path: '/Users/me/.codex/skills/alpha',
            managed: false,
            canImport: true,
            status: 'unmanaged',
            statusLabel: '未管理',
            reason: null,
            targetId: null,
            actualMode: null,
            hash: 'hash-alpha',
          },
          {
            id: 'codex-beta',
            agentId: 'codex',
            skillId: 'beta',
            name: 'beta',
            path: '/Users/me/.codex/skills/beta',
            managed: false,
            canImport: true,
            status: 'unmanaged',
            statusLabel: '未管理',
            reason: null,
            targetId: null,
            actualMode: null,
            hash: 'hash-beta',
          },
        ],
      },
      {
        agentId: 'claude-code',
        displayName: 'Claude Code',
        iconKey: 'claude-code',
        skillsDir: '/Users/me/.claude/skills',
        installed: true,
        managedCount: 1,
        unmanagedCount: 1,
        importableCount: 0,
        items: [
          {
            id: 'claude-bird',
            agentId: 'claude-code',
            skillId: 'bird',
            name: 'bird',
            path: '/Users/me/.claude/skills/bird',
            managed: false,
            canImport: false,
            status: 'conflict',
            statusLabel: '未管理 · 同名冲突',
            reason: 'same_name_as_center_skill',
            targetId: null,
            actualMode: null,
            hash: 'hash-bird',
          },
          {
            id: 'claude-managed',
            agentId: 'claude-code',
            skillId: 'managed',
            name: 'managed',
            path: '/Users/me/.claude/skills/managed',
            managed: true,
            canImport: false,
            status: 'managed',
            statusLabel: '已管理',
            reason: null,
            targetId: 'target-managed',
            actualMode: 'link',
            hash: 'hash-managed',
          },
        ],
      },
    ]
    vi.spyOn(skillApiV2, 'listAgentSkillInventory').mockResolvedValueOnce(inventory)
    const preview = vi.spyOn(skillApiV2, 'previewAdopt').mockResolvedValueOnce({
      agentId: 'claude-code',
      unmanagedId: 'claude-bird',
      skillPath: '/Users/me/.claude/skills/bird',
      inferredSkillId: 'bird',
      hash: 'hash-bird',
      centerHasSameId: true,
      canQuickAdopt: false,
      options: [
        { value: 'overwrite_center', label: 'Overwrite center skill with this one', destructive: true },
        { value: 'rename', label: 'Import under a new id', destructive: false },
        { value: 'skip', label: 'Keep as unmanaged', destructive: false },
      ],
    })

    const { AgentSyncPanel } = await import('../components/skills-v2/InstallView')
    render(<AgentSyncPanel onDone={() => {}} />)

    expect(await screen.findByText('发现 2 个可接管 Skill，1 个同名冲突')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '一键整理 2 个' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '重新扫描' })).toBeEnabled()
    expect(screen.getByRole('button', { name: /全部 Agent/ })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: /Claude Code/ }))

    expect(screen.getByText('发现 1 个同名冲突')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '处理冲突' })[0]).toHaveClass('sm2__btn--featured')
    expect(screen.getAllByRole('button', { name: '处理冲突' })[0]).toBeEnabled()
    expect(screen.getByRole('button', { name: '重新扫描' })).toBeEnabled()
    fireEvent.click(screen.getAllByRole('button', { name: '处理冲突' })[0])
    await waitFor(() => expect(preview).toHaveBeenCalledWith('claude-code', 'claude-bird'))
    expect(screen.getByRole('button', { name: /全部 Agent/ })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: /Claude Code/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('1 已管理，默认隐藏')).toBeInTheDocument()
  })

  it('shows a rescanable empty state when no agent skill directories are installed', async () => {
    const { skillApiV2 } = await import('../services/skillApiV2')
    vi.spyOn(skillApiV2, 'listAgentSkillInventory').mockResolvedValue([])
    const refresh = vi.spyOn(skillApiV2, 'refresh').mockResolvedValue(undefined)

    const { AgentSyncPanel } = await import('../components/skills-v2/InstallView')
    render(<AgentSyncPanel onDone={() => {}} />)

    expect(await screen.findByText('未发现可同步的 Agent Skills 目录')).toBeInTheDocument()
    expect(screen.getAllByText('没有找到可同步的 Agent Skills 目录。可以点击「重新扫描」再试。')).toHaveLength(2)

    fireEvent.click(screen.getAllByRole('button', { name: '重新扫描' }).at(-1)!)

    await waitFor(() => {
      expect(refresh).toHaveBeenCalled()
    })
  })

  it('labels import buttons in both list and card views', async () => {
    const { skillApiV2 } = await import('../services/skillApiV2')
    const inventory: AgentSkillInventoryAgent[] = [
      {
        agentId: 'claude-code',
        displayName: 'Claude Code',
        iconKey: 'claude-code',
        skillsDir: '/Users/me/.claude/skills',
        installed: true,
        managedCount: 0,
        unmanagedCount: 1,
        importableCount: 1,
        items: [
          {
            id: 'local-alpha',
            agentId: 'claude-code',
            skillId: 'alpha',
            name: 'alpha',
            path: '/Users/me/.claude/skills/alpha',
            managed: false,
            canImport: true,
            status: 'unmanaged',
            statusLabel: '未管理',
            reason: null,
            targetId: null,
            actualMode: null,
            hash: 'hash-alpha',
          },
        ],
      },
    ]
    vi.spyOn(skillApiV2, 'listAgentSkillInventory').mockResolvedValueOnce(inventory)

    const { AgentSyncPanel } = await import('../components/skills-v2/InstallView')
    render(<AgentSyncPanel onDone={() => {}} />)

    expect(await screen.findByRole('button', { name: '接管到中心库：alpha' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '卡片' }))

    expect(screen.getByRole('button', { name: '接管到中心库：alpha' })).toBeInTheDocument()
  })

  it('shows progress while adopting selected local agent skills', async () => {
    const { skillApiV2 } = await import('../services/skillApiV2')
    const inventory: AgentSkillInventoryAgent[] = [
      {
        agentId: 'claude-code',
        displayName: 'Claude Code',
        iconKey: 'claude-code',
        skillsDir: '/Users/me/.claude/skills',
        installed: true,
        managedCount: 0,
        unmanagedCount: 2,
        importableCount: 2,
        items: [
          {
            id: 'local-alpha',
            agentId: 'claude-code',
            skillId: 'alpha',
            name: 'alpha',
            path: '/Users/me/.claude/skills/alpha',
            managed: false,
            canImport: true,
            status: 'unmanaged',
            statusLabel: '未管理',
            reason: null,
            targetId: null,
            actualMode: null,
            hash: 'hash-alpha',
          },
          {
            id: 'local-beta',
            agentId: 'claude-code',
            skillId: 'beta',
            name: 'beta',
            path: '/Users/me/.claude/skills/beta',
            managed: false,
            canImport: true,
            status: 'unmanaged',
            statusLabel: '未管理',
            reason: null,
            targetId: null,
            actualMode: null,
            hash: 'hash-beta',
          },
        ],
      },
    ]
    let finishFirstAdopt!: () => void
    vi.spyOn(skillApiV2, 'listAgentSkillInventory').mockResolvedValue(inventory)
    vi.spyOn(skillApiV2, 'executeAdopt').mockImplementationOnce(
      () => new Promise<string>((resolve) => {
        finishFirstAdopt = () => resolve('')
      }),
    )

    const { AgentSyncPanel } = await import('../components/skills-v2/InstallView')
    render(<AgentSyncPanel onDone={() => {}} />)

    fireEvent.click(await screen.findByText('选择当前可接管'))
    fireEvent.click(screen.getByText('接管到中心库'))

    expect(await screen.findByRole('status')).toHaveTextContent('正在接管 1 / 2')
    expect(screen.getByRole('status')).toHaveTextContent('alpha')
    expect(screen.getByRole('status')).toHaveClass('sm2__agent-sync-progress--floating')
    expect(screen.getByLabelText('选择 Agent')).not.toBeDisabled()
    fireEvent.click(screen.getByText('beta'))
    expect(document.body.querySelector('.sm2__slideover-title')).toHaveTextContent('beta')
    finishFirstAdopt()
  })

  it('localizes stale unmanaged adoption errors instead of showing database text', async () => {
    await i18n.changeLanguage('zh')
    const { skillApiV2 } = await import('../services/skillApiV2')
    const inventory: AgentSkillInventoryAgent[] = [
      {
        agentId: 'openclaw',
        displayName: 'OpenClaw',
        iconKey: 'openclaw',
        skillsDir: '/Users/me/.agents/skills',
        installed: true,
        managedCount: 0,
        unmanagedCount: 1,
        importableCount: 1,
        items: [
          {
            id: 'unm-openclaw-stale',
            agentId: 'openclaw',
            skillId: 'skill-yuque-doc-polisher',
            name: 'skill-yuque-doc-polisher',
            path: '/Users/me/.agents/skills/skill-yuque-doc-polisher',
            managed: false,
            canImport: true,
            status: 'unmanaged',
            statusLabel: '未管理',
            reason: null,
            targetId: null,
            actualMode: null,
            hash: 'hash-yuque',
          },
        ],
      },
    ]
    vi.spyOn(skillApiV2, 'listAgentSkillInventory')
      .mockResolvedValueOnce(inventory)
      .mockResolvedValueOnce([])
    vi.spyOn(skillApiV2, 'executeAdopt').mockRejectedValueOnce(new Error('SKILL_UNMANAGED_STALE:unm-openclaw-stale'))

    const { AgentSyncPanel } = await import('../components/skills-v2/InstallView')
    render(<AgentSyncPanel onDone={() => {}} />)

    fireEvent.click(await screen.findByLabelText('选择 skill-yuque-doc-polisher'))
    fireEvent.click(screen.getByRole('button', { name: '接管到中心库' }))

    expect(await screen.findByText(/该 Skill 已不在待处理列表中，请重新扫描后重试。/)).toBeInTheDocument()
    expect(screen.queryByText(/SKILL_UNMANAGED_STALE/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Query returned no rows/)).not.toBeInTheDocument()
  })

  it('lists shared .agents skills separately and batch adopts them as center symlinks', async () => {
    const { skillApiV2 } = await import('../services/skillApiV2')
    const inventory: AgentSkillInventoryAgent[] = [
      {
        agentId: 'agents',
        displayName: '.agents',
        iconKey: 'agents',
        skillsDir: 'C:\\Users\\me\\.agents\\skills',
        installed: true,
        managedCount: 0,
        unmanagedCount: 1,
        importableCount: 1,
        items: [
          {
            id: 'shared-local-alpha',
            agentId: 'agents',
            skillId: 'alpha',
            name: 'alpha',
            path: 'C:\\Users\\me\\.agents\\skills\\alpha',
            managed: false,
            canImport: true,
            status: 'unmanaged',
            statusLabel: '未管理',
            reason: null,
            targetId: null,
            actualMode: null,
            hash: 'hash-alpha',
          },
        ],
      },
    ]
    vi.spyOn(skillApiV2, 'listAgentSkillInventory').mockResolvedValue(inventory)
    const execute = vi.spyOn(skillApiV2, 'executeAdopt').mockResolvedValue('alpha')

    const { AgentSyncPanel } = await import('../components/skills-v2/InstallView')
    render(<AgentSyncPanel onDone={() => {}} />)

    expect(await screen.findByText('本地 .agents Skills')).toBeInTheDocument()
    expect(screen.getByLabelText('选择 Agent')).not.toHaveTextContent('.agents · 1 可接管')
    fireEvent.click(screen.getByText('选择当前可接管'))
    fireEvent.click(screen.getByText('接管到中心库'))

    await waitFor(() => {
      expect(execute).toHaveBeenCalledWith('agents', 'shared-local-alpha', 'import_cleanup')
    })
  })

  it('cleans managed shared .agents skills from the shared source card', async () => {
    const { skillApiV2 } = await import('../services/skillApiV2')
    const before: AgentSkillInventoryAgent[] = [
      {
        agentId: 'agents',
        displayName: '.agents',
        iconKey: 'agents',
        skillsDir: '/Users/me/.agents/skills',
        installed: true,
        managedCount: 2,
        unmanagedCount: 0,
        importableCount: 0,
        items: [
          {
            id: 'target-alpha',
            agentId: 'agents',
            skillId: 'alpha',
            name: 'alpha',
            path: '/Users/me/.agents/skills/alpha',
            managed: true,
            canImport: false,
            status: 'ok',
            statusLabel: '已管理',
            reason: null,
            targetId: 'target-alpha',
            actualMode: 'link',
            hash: null,
          },
          {
            id: 'target-beta',
            agentId: 'agents',
            skillId: 'beta',
            name: 'beta',
            path: '/Users/me/.agents/skills/beta',
            managed: true,
            canImport: false,
            status: 'ok',
            statusLabel: '已管理',
            reason: null,
            targetId: 'target-beta',
            actualMode: 'copy',
            hash: 'hash-beta',
          },
        ],
      },
    ]
    const after: AgentSkillInventoryAgent[] = [
      { ...before[0], managedCount: 0, items: [] },
    ]
    vi.spyOn(skillApiV2, 'listAgentSkillInventory')
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after)
    const cleanup = vi.spyOn(skillApiV2, 'deleteSkillTargetDistributions').mockResolvedValue({ deleted: 2, failures: [] })

    const { AgentSyncPanel } = await import('../components/skills-v2/InstallView')
    render(<AgentSyncPanel onDone={() => {}} />)

    expect(await screen.findByText('本地 .agents Skills')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '清理已管理 .agents Skills' }))

    await waitFor(() => {
      expect(cleanup).toHaveBeenCalledWith(['target-alpha', 'target-beta'])
    })
    expect(await screen.findByRole('status')).toHaveTextContent('已清理 2 个 .agents 已管理 Skill')
  })

  it('previews one-click organize and defaults to center symlinks', async () => {
    const { skillApiV2 } = await import('../services/skillApiV2')
    const inventory: AgentSkillInventoryAgent[] = [
      {
        agentId: 'claude-code',
        displayName: 'Claude Code',
        iconKey: 'claude-code',
        skillsDir: '/Users/me/.claude/skills',
        installed: true,
        managedCount: 0,
        unmanagedCount: 2,
        importableCount: 1,
        items: [
          {
            id: 'local-alpha',
            agentId: 'claude-code',
            skillId: 'alpha',
            name: 'alpha',
            path: '/Users/me/.claude/skills/alpha',
            managed: false,
            canImport: true,
            status: 'unmanaged',
            statusLabel: '未管理',
            reason: null,
            targetId: null,
            actualMode: null,
            hash: 'hash-alpha',
          },
          {
            id: 'local-bird',
            agentId: 'claude-code',
            skillId: 'bird',
            name: 'bird',
            path: '/Users/me/.claude/skills/bird',
            managed: false,
            canImport: true,
            status: 'conflict',
            statusLabel: '未管理 · 同名冲突',
            reason: 'same_name_as_center_skill',
            targetId: null,
            actualMode: null,
            hash: 'hash-bird',
          },
        ],
      },
    ]
    vi.spyOn(skillApiV2, 'listAgentSkillInventory').mockResolvedValue(inventory)
    const execute = vi.spyOn(skillApiV2, 'executeAdopt').mockResolvedValue('alpha')
    execute.mockClear()

    const { AgentSyncPanel } = await import('../components/skills-v2/InstallView')
    render(<AgentSyncPanel onDone={() => {}} />)

    fireEvent.click(await screen.findByRole('button', { name: /一键整理 1 个/ }))

    expect(await screen.findByText('一键整理 Skills')).toBeInTheDocument()
    expect(screen.getByText('将整理 1 个可接管 Skill')).toBeInTheDocument()
    expect(screen.getByText('1 个同名冲突会保留给原来的冲突处理流程。')).toBeInTheDocument()
    expect(screen.getByLabelText('软连接（推荐）')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByLabelText('复制到 Agent')).toBeInTheDocument()
    expect(screen.getByLabelText('保留现有文件')).toBeInTheDocument()
    expect(execute).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('开始整理'))

    await waitFor(() => {
      expect(execute).toHaveBeenCalledWith('claude-code', 'local-alpha', 'import_link', null)
    })
    expect(execute).not.toHaveBeenCalledWith('claude-code', 'local-bird', 'import_link', null)
    expect(await screen.findByText(/已整理 1 个 Skill/)).toBeInTheDocument()
    expect(screen.getByText(/1 个需要处理冲突/)).toBeInTheDocument()
  })

  it('uses the selected one-click organize mode', async () => {
    const { skillApiV2 } = await import('../services/skillApiV2')
    const inventory: AgentSkillInventoryAgent[] = [
      {
        agentId: 'claude-code',
        displayName: 'Claude Code',
        iconKey: 'claude-code',
        skillsDir: '/Users/me/.claude/skills',
        installed: true,
        managedCount: 0,
        unmanagedCount: 1,
        importableCount: 1,
        items: [
          {
            id: 'local-alpha',
            agentId: 'claude-code',
            skillId: 'alpha',
            name: 'alpha',
            path: '/Users/me/.claude/skills/alpha',
            managed: false,
            canImport: true,
            status: 'unmanaged',
            statusLabel: '未管理',
            reason: null,
            targetId: null,
            actualMode: null,
            hash: 'hash-alpha',
          },
        ],
      },
    ]
    vi.spyOn(skillApiV2, 'listAgentSkillInventory').mockResolvedValue(inventory)
    const execute = vi.spyOn(skillApiV2, 'executeAdopt').mockResolvedValue('alpha')

    const { AgentSyncPanel } = await import('../components/skills-v2/InstallView')
    render(<AgentSyncPanel onDone={() => {}} />)

    fireEvent.click(await screen.findByRole('button', { name: /一键整理 1 个/ }))
    fireEvent.click(await screen.findByLabelText('保留现有文件'))
    fireEvent.click(screen.getByText('开始整理'))

    await waitFor(() => {
      expect(execute).toHaveBeenCalledWith('claude-code', 'local-alpha', 'import_keep', null)
    })
  })

  it('uses cleanup mode for shared .agents skills during one-click organize', async () => {
    const { skillApiV2 } = await import('../services/skillApiV2')
    const inventory: AgentSkillInventoryAgent[] = [
      {
        agentId: 'agents',
        displayName: '本地 .agents Skills',
        iconKey: 'agents',
        skillsDir: '/Users/me/.agents/skills',
        installed: true,
        managedCount: 0,
        unmanagedCount: 1,
        importableCount: 1,
        items: [
          {
            id: 'shared-alpha',
            agentId: 'agents',
            skillId: 'alpha',
            name: 'alpha',
            path: '/Users/me/.agents/skills/alpha',
            managed: false,
            canImport: true,
            status: 'unmanaged',
            statusLabel: '未管理',
            reason: null,
            targetId: null,
            actualMode: null,
            hash: 'hash-alpha',
          },
        ],
      },
    ]
    vi.spyOn(skillApiV2, 'listAgentSkillInventory').mockResolvedValue(inventory)
    const execute = vi.spyOn(skillApiV2, 'executeAdopt').mockResolvedValue('alpha')

    const { AgentSyncPanel } = await import('../components/skills-v2/InstallView')
    render(<AgentSyncPanel onDone={() => {}} />)

    fireEvent.click(await screen.findByRole('button', { name: /一键整理 1 个/ }))
    fireEvent.click(screen.getByText('开始整理'))

    await waitFor(() => {
      expect(execute).toHaveBeenCalledWith('agents', 'shared-alpha', 'import_cleanup', null)
    })
  })

  it('previews a single agent skill before adopting with the selected mode', async () => {
    const { skillApiV2 } = await import('../services/skillApiV2')
    const inventory: AgentSkillInventoryAgent[] = [
      {
        agentId: 'claude-code',
        displayName: 'Claude Code',
        iconKey: 'claude-code',
        skillsDir: '/Users/me/.claude/skills',
        installed: true,
        managedCount: 0,
        unmanagedCount: 1,
        importableCount: 1,
        items: [
          {
            id: 'local-bird',
            agentId: 'claude-code',
            skillId: 'bird',
            name: 'bird',
            path: '/Users/me/.claude/skills/bird',
            managed: false,
            canImport: true,
            status: 'unmanaged',
            statusLabel: '未管理',
            reason: 'not_in_center_library',
            targetId: null,
            actualMode: null,
            hash: 'hash-bird',
          },
        ],
      },
    ]
    vi.spyOn(skillApiV2, 'listAgentSkillInventory').mockResolvedValueOnce(inventory)
    const preview = vi.spyOn(skillApiV2, 'previewAdopt').mockResolvedValueOnce({
      agentId: 'claude-code',
      unmanagedId: 'local-bird',
      skillPath: '/Users/me/.claude/skills/bird',
      inferredSkillId: 'bird',
      hash: 'hash-bird',
      centerHasSameId: false,
      canQuickAdopt: true,
      options: [
        { value: 'import_keep', label: 'Import to center, keep agent file as-is', destructive: false },
        { value: 'import_link', label: 'Import to center and replace agent file with link', destructive: true },
        { value: 'import_copy', label: 'Import to center and replace agent file with copy', destructive: true },
      ],
    })
    const execute = vi.spyOn(skillApiV2, 'executeAdopt').mockResolvedValueOnce('bird')

    const { AgentSyncPanel } = await import('../components/skills-v2/InstallView')
    const { container } = render(<AgentSyncPanel onDone={() => {}} />)

    await screen.findByText('bird')
    fireEvent.click(container.querySelector('.sm2__icon-btn--add')!)

    expect(preview).toHaveBeenCalledWith('claude-code', 'local-bird')
    expect(await screen.findByText('接管 bird')).toBeInTheDocument()
    expect(screen.getAllByText('Claude Code').length).toBeGreaterThan(0)
    expect(screen.getAllByText('/Users/me/.claude/skills/bird').length).toBeGreaterThan(0)
    expect(screen.getByLabelText('替换为软连接')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByLabelText('保留 Agent 文件')).toHaveAttribute('aria-checked', 'false')

    fireEvent.click(screen.getByText('确认接管'))

    await waitFor(() => expect(execute).toHaveBeenCalledWith('claude-code', 'local-bird', 'import_link', null))
  })

  it('allows conflicting agent skills to be adopted with a rename decision', async () => {
    const { skillApiV2 } = await import('../services/skillApiV2')
    const inventory: AgentSkillInventoryAgent[] = [
      {
        agentId: 'codex',
        displayName: 'Codex',
        iconKey: 'codex',
        skillsDir: '/Users/me/.codex/skills',
        installed: true,
        managedCount: 0,
        unmanagedCount: 1,
        importableCount: 0,
        items: [
          {
            id: 'codex-bird',
            agentId: 'codex',
            skillId: 'bird',
            name: 'bird',
            path: '/Users/me/.codex/skills/bird',
            managed: false,
            canImport: false,
            status: 'conflict',
            statusLabel: '未管理 · 同名冲突',
            reason: 'same_name_as_center_skill',
            targetId: null,
            actualMode: null,
            hash: 'hash-codex-bird',
          },
        ],
      },
    ]
    vi.spyOn(skillApiV2, 'listAgentSkillInventory').mockResolvedValueOnce(inventory)
    vi.spyOn(skillApiV2, 'previewAdopt').mockResolvedValueOnce({
      agentId: 'codex',
      unmanagedId: 'codex-bird',
      skillPath: '/Users/me/.codex/skills/bird',
      inferredSkillId: 'bird',
      hash: 'hash-codex-bird',
      centerHasSameId: true,
      canQuickAdopt: false,
      options: [
        { value: 'overwrite_center', label: 'Overwrite center skill with this one', destructive: true },
        { value: 'rename', label: 'Import under a new id', destructive: false },
        { value: 'skip', label: 'Keep as unmanaged', destructive: false },
      ],
    })
    const execute = vi.spyOn(skillApiV2, 'executeAdopt').mockResolvedValueOnce('bird-codex')

    const { AgentSyncPanel } = await import('../components/skills-v2/InstallView')
    render(<AgentSyncPanel onDone={() => {}} />)

    fireEvent.click(await screen.findByText('bird'))
    fireEvent.click((await screen.findAllByText('处理冲突')).at(-1)!)
    fireEvent.click(await screen.findByLabelText('重命名导入'))
    fireEvent.change(screen.getByPlaceholderText('bird-import'), { target: { value: 'bird-codex' } })
    fireEvent.click(screen.getByText('确认接管'))

    await waitFor(() => expect(execute).toHaveBeenCalledWith('codex', 'codex-bird', 'rename', 'bird-codex'))
  })

  it('defaults conflicting agent skills to the center-library version when available', async () => {
    const { skillApiV2 } = await import('../services/skillApiV2')
    const inventory: AgentSkillInventoryAgent[] = [
      {
        agentId: 'codex',
        displayName: 'Codex',
        iconKey: 'codex',
        skillsDir: '/Users/me/.codex/skills',
        installed: true,
        managedCount: 0,
        unmanagedCount: 1,
        importableCount: 0,
        items: [
          {
            id: 'codex-bird',
            agentId: 'codex',
            skillId: 'bird',
            name: 'bird',
            path: '/Users/me/.codex/skills/bird',
            managed: false,
            canImport: false,
            status: 'conflict',
            statusLabel: '未管理 · 同名冲突',
            reason: 'same_name_as_center_skill',
            targetId: null,
            actualMode: null,
            hash: 'hash-codex-bird',
          },
        ],
      },
    ]
    vi.spyOn(skillApiV2, 'listAgentSkillInventory').mockResolvedValueOnce(inventory)
    vi.spyOn(skillApiV2, 'previewAdopt').mockResolvedValueOnce({
      agentId: 'codex',
      unmanagedId: 'codex-bird',
      skillPath: '/Users/me/.codex/skills/bird',
      inferredSkillId: 'bird',
      hash: 'hash-codex-bird',
      centerHasSameId: true,
      canQuickAdopt: false,
      options: [
        { value: 'center_over_agent', label: 'Use center skill and replace agent file with link', destructive: true },
        { value: 'overwrite_center', label: 'Overwrite center skill with this one', destructive: true },
        { value: 'rename', label: 'Import under a new id', destructive: false },
        { value: 'skip', label: 'Keep as unmanaged', destructive: false },
      ],
    })
    const execute = vi.spyOn(skillApiV2, 'executeAdopt').mockResolvedValueOnce('bird')

    const { AgentSyncPanel } = await import('../components/skills-v2/InstallView')
    render(<AgentSyncPanel onDone={() => {}} />)

    fireEvent.click(await screen.findByText('bird'))
    fireEvent.click((await screen.findAllByText('处理冲突')).at(-1)!)

    expect(await screen.findByLabelText('中心库为准')).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByText('确认接管'))

    await waitFor(() => expect(execute).toHaveBeenCalledWith('codex', 'codex-bird', 'center_over_agent', null))
  })

  it('batch adds conflicting agent skills with generated rename ids', async () => {
    const { skillApiV2 } = await import('../services/skillApiV2')
    const inventory: AgentSkillInventoryAgent[] = [
      {
        agentId: 'codex',
        displayName: 'Codex',
        iconKey: 'codex',
        skillsDir: '/Users/me/.codex/skills',
        installed: true,
        managedCount: 0,
        unmanagedCount: 2,
        importableCount: 0,
        items: [
          {
            id: 'codex-bird',
            agentId: 'codex',
            skillId: 'bird',
            name: 'bird',
            path: '/Users/me/.codex/skills/bird',
            managed: false,
            canImport: false,
            status: 'conflict',
            statusLabel: '未管理 · 同名冲突',
            reason: 'same_name_as_center_skill',
            targetId: null,
            actualMode: null,
            hash: 'hash-codex-bird',
          },
          {
            id: 'codex-flight',
            agentId: 'codex',
            skillId: 'flight.plan',
            name: 'flight.plan',
            path: '/Users/me/.codex/skills/flight.plan',
            managed: false,
            canImport: false,
            status: 'conflict',
            statusLabel: '未管理 · 同名冲突',
            reason: 'same_name_as_center_skill',
            targetId: null,
            actualMode: null,
            hash: 'hash-codex-flight',
          },
        ],
      },
    ]
    vi.spyOn(skillApiV2, 'listAgentSkillInventory').mockResolvedValue(inventory)
    const execute = vi.spyOn(skillApiV2, 'executeAdopt').mockResolvedValue('ok')

    const { AgentSyncPanel } = await import('../components/skills-v2/InstallView')
    render(<AgentSyncPanel onDone={() => {}} />)

    fireEvent.click(await screen.findByRole('button', { name: '批量处理冲突' }))
    expect(await screen.findByRole('heading', { name: '批量处理冲突' })).toBeInTheDocument()
    expect(screen.getByLabelText('中心库为准（推荐）')).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(screen.getByLabelText('重命名新增'))
    fireEvent.click(screen.getByRole('button', { name: '批量新增' }))

    await waitFor(() => {
      expect(execute).toHaveBeenCalledWith('codex', 'codex-bird', 'rename', 'bird-codex')
      expect(execute).toHaveBeenCalledWith('codex', 'codex-flight', 'rename', 'flight-plan-codex')
    })
  })

  it('opens local agent skills in the skill-library detail layout', async () => {
    const { skillApiV2 } = await import('../services/skillApiV2')
    const inventory: AgentSkillInventoryAgent[] = [
      {
        agentId: 'claude-code',
        displayName: 'Claude Code',
        iconKey: 'claude-code',
        skillsDir: '/Users/me/.claude/skills',
        installed: true,
        managedCount: 0,
        unmanagedCount: 1,
        importableCount: 1,
        items: [
          {
            id: 'local-find-skills',
            agentId: 'claude-code',
            skillId: 'find-skills',
            name: 'find-skills',
            path: '/Users/me/.claude/skills/find-skills',
            managed: false,
            canImport: true,
            status: 'unmanaged',
            statusLabel: '未管理',
            reason: 'not_in_center_library',
            targetId: null,
            actualMode: null,
            hash: '38d9217b9d12',
          },
        ],
      },
    ]
    vi.spyOn(skillApiV2, 'listAgentSkillInventory').mockResolvedValueOnce(inventory)
    vi.spyOn(skillApiV2, 'readFileTree').mockResolvedValueOnce({
      name: 'find-skills',
      nodeType: 'dir',
      path: '/Users/me/.claude/skills/find-skills',
      children: [
        {
          name: 'SKILL.md',
          nodeType: 'file',
          path: '/Users/me/.claude/skills/find-skills/SKILL.md',
          children: null,
        },
        {
          name: 'scripts',
          nodeType: 'dir',
          path: '/Users/me/.claude/skills/find-skills/scripts',
          children: [
            {
              name: 'find.js',
              nodeType: 'file',
              path: '/Users/me/.claude/skills/find-skills/scripts/find.js',
              children: null,
            },
          ],
        },
      ],
    })
    vi.spyOn(skillApiV2, 'readFileContent').mockResolvedValueOnce('# Find Skills\n\nLocal documentation.')

    const { AgentSyncPanel } = await import('../components/skills-v2/InstallView')
    const { container } = render(<AgentSyncPanel onDone={() => {}} />)

    fireEvent.click(await screen.findByText('find-skills'))

    expect(document.body.querySelector('.sm2__slideover--skill-detail')).not.toBeNull()
    expect(document.body.querySelector('.sm2__slideover--market-detail')).toBeNull()
    expect(await screen.findByText('说明文档')).toBeInTheDocument()
    expect(screen.getByText('Agent 安装')).toBeInTheDocument()
    expect(screen.getByText('文件')).toBeInTheDocument()
    expect(screen.getAllByText('来源').length).toBeGreaterThan(0)
    expect(screen.getByText('Local documentation.')).toBeInTheDocument()
    expect(document.body.querySelector('.sm2__markdown--skilldoc > :first-child')?.tagName).toBe('H1')
    expect(document.body.querySelector('.sm2__skill-frontmatter')).toBeNull()
    fireEvent.click(screen.getByText('文件'))
    expect(document.body.querySelector('.sm2__filetree-pane')).not.toBeNull()
    expect(screen.getAllByText('find-skills').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByText('scripts'))
    expect(screen.getByText('find.js')).toBeInTheDocument()
    expect(container).toBeTruthy()
  })

  it('reveals a local agent skill directory from the detail action', async () => {
    const { skillApiV2 } = await import('../services/skillApiV2')
    const inventory: AgentSkillInventoryAgent[] = [
      {
        agentId: 'claude-code',
        displayName: 'Claude Code',
        iconKey: 'claude-code',
        skillsDir: '/Users/me/.claude/skills',
        installed: true,
        managedCount: 0,
        unmanagedCount: 1,
        importableCount: 1,
        items: [
          {
            id: 'local-alpha',
            agentId: 'claude-code',
            skillId: 'alpha',
            name: 'alpha',
            path: '/Users/me/.claude/skills/alpha',
            managed: false,
            canImport: true,
            status: 'unmanaged',
            statusLabel: '未管理',
            reason: null,
            targetId: null,
            actualMode: null,
            hash: 'hash-alpha',
          },
        ],
      },
    ]
    vi.mocked(openShell).mockClear()
    vi.spyOn(skillApiV2, 'listAgentSkillInventory').mockResolvedValueOnce(inventory)
    vi.spyOn(skillApiV2, 'readFileTree').mockResolvedValueOnce({
      name: 'alpha',
      nodeType: 'dir',
      path: '/Users/me/.claude/skills/alpha',
      children: [],
    })
    vi.spyOn(skillApiV2, 'readFileContent').mockResolvedValueOnce('# Alpha\n\nLocal documentation.')
    const revealPath = vi.spyOn(skillApiV2, 'revealPath').mockResolvedValueOnce(undefined)

    const { AgentSyncPanel } = await import('../components/skills-v2/InstallView')
    render(<AgentSyncPanel onDone={() => {}} />)

    fireEvent.click(await screen.findByText('alpha'))
    fireEvent.click(screen.getByRole('button', { name: '打开目录 ↗' }))

    await waitFor(() => expect(revealPath).toHaveBeenCalledWith('/Users/me/.claude/skills/alpha'))
    expect(openShell).not.toHaveBeenCalled()
    expect(screen.queryByText('已在 Finder 中定位 Skill 目录')).not.toBeInTheDocument()
  })
})

describe('selecting a skill updates detail', () => {
  beforeEach(() => {
    cleanup()
    const skill = makeSkill()
    useSkillStoreV2.setState({
      viewMode: 'cards',
      filters: { query: '', source: '', status: '', type: '' },
      skills: [skill],
      overview: null,
      settings: {
        centerPath: '~/.agentbro/skills',
        sqlitePath: '~/.agentbro/skill-manager.db',
        defaultDistributeMode: 'link',
        linkFailPolicy: 'ask',
        startupScan: true,
        showUnmanaged: true,
      },
      loading: false,
      error: null,
      selectedSkillId: null,
      selectedSkillDetail: null,
      agents: [] as AgentSummary[],
    })
  })

  it('clicking a skill opens the detail slide-over', async () => {
    const { SkillLibraryPage } = await import('../components/skills-v2/SkillLibraryPage')
    render(<SkillLibraryPage />)
    fireEvent.click(screen.getByText('Release Checklist'))
    // SlideOver renders into document.body via portal; its title shows the id
    const title = document.body.querySelector('.sm2__slideover-title')
    expect(title?.textContent).toContain('release-checklist')
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

  it('SkillDetailSlider renders when open', async () => {
    const { SkillDetailSlider } = await import('../components/skills-v2/SkillDetailSlider')
    const { container } = render(<SkillDetailSlider skillId="release-checklist" open={true} onClose={() => {}} onDistribute={() => {}} onDelete={() => {}} />)
    // portal renders the slide-over
    expect(document.body.querySelector('.sm2__slideover')).not.toBeNull()
    expect(container).toBeTruthy()
  })

  it('loads the file tree for unmanaged fallback skills', async () => {
    vi.spyOn(skillApiV2, 'getSkillDetail').mockRejectedValueOnce(new Error('not in center'))
    const readFileTree = vi.spyOn(skillApiV2, 'readFileTree').mockResolvedValueOnce({
      name: 'manual-skill',
      nodeType: 'dir',
      path: '/c/skills/manual-skill',
      children: [
        {
          name: 'SKILL.md',
          nodeType: 'file',
          path: '/c/skills/manual-skill/SKILL.md',
          children: null,
        },
        {
          name: 'reference.md',
          nodeType: 'file',
          path: '/c/skills/manual-skill/reference.md',
          children: null,
        },
      ],
    })
    vi.spyOn(skillApiV2, 'readFileContent').mockResolvedValueOnce('# Manual Skill\n\nManual doc.')

    const { SkillDetailSlider } = await import('../components/skills-v2/SkillDetailSlider')
    render(
      <SkillDetailSlider
        skillId="manual-skill"
        open={true}
        onClose={() => {}}
        fallbackSkill={{
          id: 'manual-skill',
          name: 'manual-skill',
          centerPath: '/c/skills/manual-skill',
          sourceType: 'unmanaged_agent',
          sourceUri: '/c/skills/manual-skill',
        }}
      />,
    )

    expect(await screen.findByText('Manual doc.')).toBeInTheDocument()
    expect(readFileTree).toHaveBeenCalledWith('/c/skills/manual-skill')
    expect(document.body.querySelector('.sm2__markdown--skilldoc > :first-child')?.tagName).toBe('H1')
    expect(document.body.querySelector('.sm2__skill-frontmatter')).toBeNull()

    fireEvent.click(screen.getByText('文件'))
    expect(document.body.querySelector('.sm2__filetree-pane')).not.toBeNull()
    expect(screen.getAllByText('SKILL.md').length).toBeGreaterThan(0)
    expect(screen.getByText('reference.md')).toBeInTheDocument()
    expect(screen.getByText('2 个文件')).toBeInTheDocument()
  })

  it('labels linked center skills with their real source directory', async () => {
    vi.spyOn(skillApiV2, 'getSkillDetail').mockResolvedValueOnce({
      ...makeSkill({
        id: 'live-review',
        name: 'live-review',
        sourceType: 'local_folder',
        sourceUri: null,
        centerPath: '/Users/me/.agentbro/skills/live-review',
        installedAgents: [],
      }),
      centerResolvedPath: '/Users/me/code/szskills/live-review',
      frontmatter: { description: 'Linked local skill' },
      files: {
        name: 'live-review',
        nodeType: 'dir',
        path: '/Users/me/.agentbro/skills/live-review',
        children: [
          {
            name: 'SKILL.md',
            nodeType: 'file',
            path: '/Users/me/.agentbro/skills/live-review/SKILL.md',
            children: null,
          },
        ],
      },
      targets: [],
      source: {
        sourceType: 'local_folder',
        sourceUri: null,
        sourceRef: null,
        importedFromAgent: null,
        importedFromPath: null,
        installedVia: 'agentbro',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    })
    vi.spyOn(skillApiV2, 'readFileContent').mockResolvedValue('# live-review\n\nLinked local skill.')

    const { SkillDetailSlider } = await import('../components/skills-v2/SkillDetailSlider')
    render(<SkillDetailSlider skillId="live-review" open onClose={() => {}} />)

    expect(await screen.findByText('软链中心目录')).toBeInTheDocument()
    expect(screen.getByTitle('本地文件夹导入的 Skill，真实地址是：/Users/me/code/szskills/live-review')).toHaveTextContent('本地软链')
    expect(screen.getByText('/Users/me/code/szskills/live-review')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '来源' }))
    expect(screen.getByText('真实源目录')).toBeInTheDocument()
  })

  it('does not repeat the agent id under the agent display name', async () => {
    vi.spyOn(skillApiV2, 'getSkillDetail').mockResolvedValueOnce({
      ...makeSkill({
        installedAgents: [
          { agentId: 'claude-code', displayName: 'Claude Code', iconKey: 'claude-code', mode: 'link', status: 'ok' },
        ],
      }),
      frontmatter: {},
      files: null,
      targets: agentDetail.skills,
      source: null,
    })

    const { SkillDetailSlider } = await import('../components/skills-v2/SkillDetailSlider')
    render(<SkillDetailSlider skillId="release-checklist" open={true} onClose={() => {}} />)

    fireEvent.click(await screen.findByText('Agent (1)'))
    const title = document.body.querySelector('.sm2__agent-target-title')
    expect(title).toHaveTextContent('Claude Code')
    expect(title).not.toHaveTextContent('claude-code')
  })

  it('marks rendered skill markdown as selectable for copying text', async () => {
    vi.spyOn(skillApiV2, 'getSkillDetail').mockResolvedValueOnce({
      ...makeSkill(),
      frontmatter: {},
      files: {
        name: 'release-checklist',
        nodeType: 'dir',
        path: '/center/release-checklist',
        children: [
          {
            name: 'SKILL.md',
            nodeType: 'file',
            path: '/center/release-checklist/SKILL.md',
            children: null,
          },
        ],
      },
      targets: [],
      source: null,
    })
    vi.spyOn(skillApiV2, 'readFileContent').mockResolvedValue('# Release Checklist\n\nCopy this text.')

    const { SkillDetailSlider } = await import('../components/skills-v2/SkillDetailSlider')
    render(<SkillDetailSlider skillId="release-checklist" open={true} onClose={() => {}} />)

    const paragraph = await screen.findByText('Copy this text.')
    const overviewMarkdown = paragraph.closest('.sm2__markdown')
    expect(overviewMarkdown).toHaveClass('selectable')
    const title = document.body.querySelector('.sm2__slideover-title .selectable')
    expect(title).toHaveTextContent('Release Checklist')

    fireEvent.click(screen.getByText('文件'))
    const filePreview = document.body.querySelector('.sm2__markdown--file')
    expect(filePreview).toHaveClass('selectable')

    vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'Release Checklist' } as Selection)
    fireEvent.contextMenu(title as Element, { clientX: 80, clientY: 60 })
    expect(screen.getByRole('menuitem', { name: '复制' })).toBeInTheDocument()
  })

  it('marks source paths and hashes as selectable for drag copy', async () => {
    vi.spyOn(skillApiV2, 'getSkillDetail').mockResolvedValueOnce({
      ...makeSkill({
        centerPath: '/Users/me/.agentbro/skills/release-checklist',
        currentHash: 'abcdef1234567890',
      }),
      frontmatter: {},
      files: null,
      targets: [],
      source: {
        sourceType: 'agent_import',
        sourceUri: null,
        sourceRef: null,
        importedFromAgent: 'claude-code',
        importedFromPath: '/Users/me/.claude/skills/release-checklist',
        installedVia: 'agentbro',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    })

    const { SkillDetailSlider } = await import('../components/skills-v2/SkillDetailSlider')
    render(<SkillDetailSlider skillId="release-checklist" open={true} onClose={() => {}} />)

    fireEvent.click(await screen.findByRole('button', { name: '来源' }))

    expect(screen.getByText('/Users/me/.claude/skills/release-checklist')).toHaveClass('selectable')
    expect(screen.getByText('/Users/me/.agentbro/skills/release-checklist')).toHaveClass('selectable')
    expect(screen.getByText('abcdef1234567890')).toHaveClass('selectable')
  })

  it('opens a center-to-copy diff from a changed copy target', async () => {
    const centerLines = Array.from({ length: 275 }, (_, index) => `line ${index + 1}`)
    const copyLines = [...centerLines]
    copyLines[2] = 'line 3 123'
    vi.spyOn(skillApiV2, 'getSkillDetail').mockResolvedValueOnce({
      ...makeSkill({
        status: 'copyDiverged',
        installedAgents: [
          { agentId: 'codex', displayName: 'Codex', iconKey: 'codex', mode: 'copy', status: 'copy_modified' },
        ],
      }),
      frontmatter: {},
      files: null,
      targets: [
        {
          id: 'target-codex',
          skillId: 'release-checklist',
          agentId: 'codex',
          targetPath: '/Users/me/.codex/skills/release-checklist',
          resolvedTargetPath: null,
          installMode: 'copy',
          actualMode: 'copy',
          sourceHash: 'hash1',
          currentHash: 'hash2',
          status: 'copy_modified',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          claims: [],
        },
      ],
      source: null,
    })
    const previewDiff = vi.spyOn(skillApiV2, 'previewCopyTargetDiff').mockResolvedValueOnce({
      targetId: 'target-codex',
      skillId: 'release-checklist',
      targetPath: '/Users/me/.codex/skills/release-checklist',
      centerPath: '/center/release-checklist',
      state: 'copy_modified',
      files: [
        {
          path: 'SKILL.md',
          changeType: 'modified',
          centerContent: centerLines.join('\n'),
          copyContent: copyLines.join('\n'),
        },
      ],
    })

    const { SkillDetailSlider } = await import('../components/skills-v2/SkillDetailSlider')
    render(<SkillDetailSlider skillId="release-checklist" open={true} onClose={() => {}} />)

    await waitFor(() => {
      expect(document.body.querySelector('.sm2__detail-status--copy-diff')).not.toBeNull()
      expect(document.body.querySelector('.sm2__install-mini--copy-diff')).not.toBeNull()
    })

    fireEvent.click(await screen.findByText('Agent (1)'))
    fireEvent.click(screen.getByRole('button', { name: '查看 diff' }))

    await waitFor(() => expect(previewDiff).toHaveBeenCalledWith('target-codex'))
    expect(await screen.findByRole('dialog', { name: 'Agent 副本 diff' })).toBeInTheDocument()
    expect(screen.getByText('目录树')).toBeInTheDocument()
    expect(screen.getAllByText('SKILL.md').length).toBeGreaterThan(0)
    expect(screen.getByText('中心库')).toBeInTheDocument()
    expect(screen.getByText('Agent 副本')).toBeInTheDocument()
    expect(screen.getByText('line 3')).toBeInTheDocument()
    expect(screen.getByText('line 3 123')).toBeInTheDocument()
    expect(document.body.querySelectorAll('.sm2__copy-diff-side-scroll')).toHaveLength(2)
    expect(document.body.querySelectorAll('.sm2__copy-diff-side-scroll[data-scroll-mode="independent-x-fixed-y-sync"]')).toHaveLength(2)
    expect(document.body.querySelectorAll('.sm2__copy-diff-cell--remove')).toHaveLength(1)
    expect(document.body.querySelectorAll('.sm2__copy-diff-cell--add')).toHaveLength(1)
  })

  it('deletes a single agent distribution from the Agent tab', async () => {
    const afterDelete = makeSkill({
      installedAgents: [],
    })
    vi.spyOn(skillApiV2, 'getSkillDetail')
      .mockResolvedValueOnce({
        ...makeSkill({
          installedAgents: [
            { agentId: 'codex', displayName: 'Codex', iconKey: 'codex', mode: 'copy', status: 'ok' },
          ],
        }),
        frontmatter: {},
        files: null,
        targets: [
          {
            id: 'target-codex',
            skillId: 'release-checklist',
            agentId: 'codex',
            targetPath: '/Users/me/.codex/skills/release-checklist',
            resolvedTargetPath: null,
            installMode: 'copy',
            actualMode: 'copy',
            sourceHash: 'hash1',
            currentHash: 'hash1',
            status: 'ok',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            claims: [],
          },
        ],
        source: null,
      })
      .mockResolvedValueOnce({
        ...afterDelete,
        frontmatter: {},
        files: null,
        targets: [],
        source: null,
      })
    const deleteTarget = vi.spyOn(skillApiV2, 'deleteSkillTargetDistribution').mockResolvedValueOnce()

    const { SkillDetailSlider } = await import('../components/skills-v2/SkillDetailSlider')
    render(<SkillDetailSlider skillId="release-checklist" open={true} onClose={() => {}} />)

    fireEvent.click(await screen.findByText('Agent (1)'))
    fireEvent.click(screen.getByRole('button', { name: '移除' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }))

    await waitFor(() => expect(deleteTarget).toHaveBeenCalledWith('target-codex'))
    expect(await screen.findByText('尚未对任何 Agent 生效')).toBeInTheDocument()
  })

  it('opens skill documentation links with the system browser', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
    try {
      vi.mocked(openShell).mockClear()
      vi.spyOn(skillApiV2, 'getSkillDetail').mockResolvedValueOnce({
        ...makeSkill(),
        frontmatter: {},
        files: {
          name: 'release-checklist',
          nodeType: 'dir',
          path: '/center/release-checklist',
          children: [
            {
              name: 'SKILL.md',
              nodeType: 'file',
              path: '/center/release-checklist/SKILL.md',
              children: null,
            },
          ],
        },
        targets: [],
        source: null,
      })
      vi.spyOn(skillApiV2, 'readFileContent').mockResolvedValue('Read the [docs](https://example.com/docs).')

      const { SkillDetailSlider } = await import('../components/skills-v2/SkillDetailSlider')
      render(<SkillDetailSlider skillId="release-checklist" open={true} onClose={() => {}} />)

      fireEvent.click(await screen.findByRole('link', { name: 'docs' }))

      expect(openShell).toHaveBeenCalledWith('https://example.com/docs')
    } finally {
      delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    }
  })

  it('AgentManagementPage uses the sidebar agent list and renders no picker in the content pane', async () => {
    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    const { container } = render(<AgentManagementPage />)
    expect(container.querySelector('.sm2__rail')).toBeNull()
    expect(container.querySelector('.sm2__agent-picker')).toBeNull()
    expect(container.querySelector('.sm2__main--full')).not.toBeNull()
    // 内容区展示本机 Agent 检测总览，但仍是详情主画布，不恢复旧 picker。
    expect(container.querySelector('.sm2-agent-inventory')).not.toBeNull()
    expect(screen.getAllByText('Claude Code').length).toBeGreaterThan(0)
  })


  it('adds a custom Claude-compatible agent from manual paths', async () => {
    const addCustom = vi.spyOn(agentApi, 'addCustom').mockResolvedValue(makeProgram({
      id: 'custom-antcc',
      displayName: 'AntCC',
      icon: 'claude-code',
      packageManager: 'custom',
      packageName: null,
      configDir: '/Users/me/.codefuse/engine/cc',
      skillsDir: '/Users/me/.codefuse/engine/cc/skills',
      isCustom: true,
    }))
    const loadOverview = vi.spyOn(useSkillStoreV2.getState(), 'loadOverview').mockResolvedValue(undefined)

    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)

    expect(screen.queryByRole('button', { name: /添加 Claude Code 实例/ })).not.toBeInTheDocument()
    act(() => useSkillStoreV2.getState().requestCustomAgentDialog())
    const dialog = await screen.findByRole('dialog', { name: /添加 Claude Code 实例/ })
    expect(dialog.closest('.sm2-custom-agent-overlay')).toBeInTheDocument()
    expect(dialog.querySelector('#custom-agent-engine')).toBeNull()
    expect(screen.getByPlaceholderText('例如研发团队 Claude Code')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: 'AntCC' } })
    fireEvent.change(screen.getByLabelText('配置根目录'), { target: { value: '~/.codefuse/engine/cc/' } })
    fireEvent.click(screen.getByRole('button', { name: '保存 Agent' }))

    await waitFor(() => expect(addCustom).toHaveBeenCalledWith({
      id: null,
      displayName: 'AntCC',
      category: 'claude-compatible',
      globalSkillsDir: '~/.codefuse/engine/cc/skills',
      iconName: 'claude-code',
      configDir: '~/.codefuse/engine/cc/',
      settingsFile: '~/.codefuse/engine/cc/settings.json',
    }))
    expect(loadOverview).toHaveBeenCalledWith(true)
    expect(screen.queryByRole('dialog', { name: /添加 Claude Code 实例/ })).not.toBeInTheDocument()
  })

  it('deletes a custom agent from the agent detail header', async () => {
    const customDetail: AgentDetail = {
      ...agentDetail,
      id: 'custom-antcc',
      displayName: 'AntCC',
      iconKey: 'claude-code',
      skillsDir: '/Users/me/.codefuse/engine/cc/skills',
      configPath: '/Users/me/.codefuse/engine/cc/settings.json',
      skills: [],
    }
    useSkillStoreV2.setState({
      selectedAgentId: 'custom-antcc',
      selectedAgentDetail: customDetail,
      agents: [
        { id: 'custom-antcc', displayName: 'AntCC', iconKey: 'claude-code', enabled: true, skillsDir: '/Users/me/.codefuse/engine/cc/skills', version: null, latestVersion: null, installed: true, managedSkillCount: 0, unmanagedSkillCount: 0 } as AgentSummary,
      ],
      unmanaged: [],
    })
    vi.spyOn(agentApi, 'list').mockResolvedValue([
      makeProgram({
        id: 'custom-antcc',
        displayName: 'AntCC',
        icon: 'claude-code',
        packageManager: 'custom',
        packageName: null,
        configDir: '/Users/me/.codefuse/engine/cc',
        skillsDir: '/Users/me/.codefuse/engine/cc/skills',
        isCustom: true,
      }),
    ])
    const removeCustom = vi.spyOn(agentApi, 'removeCustom').mockResolvedValue(undefined)
    const loadOverview = vi.spyOn(useSkillStoreV2.getState(), 'loadOverview').mockResolvedValue(undefined)

    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)

    fireEvent.click(await screen.findByRole('button', { name: '删除此 Agent' }))
    expect(screen.getByRole('dialog', { name: '删除 Agent「AntCC」' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))

    await waitFor(() => expect(removeCustom).toHaveBeenCalledWith('custom-antcc'))
    expect(loadOverview).toHaveBeenCalledWith(true)
    expect(useSkillStoreV2.getState().selectedAgentId).toBeNull()
  })

  it('does not treat the shared .agents directory as an agent in management views', async () => {
    const sharedDetail: AgentDetail = {
      ...agentDetail,
      id: 'agents',
      displayName: '.agents',
      iconKey: 'agents',
      skillsDir: '/Users/me/.agents/skills',
      skills: [],
    }
    useSkillStoreV2.setState({
      activeTab: 'agents',
      selectedAgentId: 'agents',
      selectedAgentDetail: sharedDetail,
      agents: [
        { id: 'agents', displayName: '.agents', iconKey: 'agents', enabled: true, skillsDir: '/Users/me/.agents/skills', version: null, latestVersion: null, installed: true, managedSkillCount: 0, unmanagedSkillCount: 68 } as AgentSummary,
        { id: 'claude-code', displayName: 'Claude Code', iconKey: 'claude-code', enabled: true, skillsDir: '/c', version: null, latestVersion: null, installed: true, managedSkillCount: 1, unmanagedSkillCount: 0 } as AgentSummary,
      ],
    })
    vi.spyOn(skillApiV2, 'getAgentDetail').mockResolvedValue(agentDetail)

    const { SettingsSidebar } = await import('../components/settings/SettingsSidebar')
    render(
      <SettingsSidebar
        activeSection="skill-manager-v2"
        collapsed={false}
        onCollapsedChange={() => {}}
        onSelect={() => {}}
      />,
    )

    expect(screen.queryByText('.agents')).not.toBeInTheDocument()
    expect(screen.getByText('Claude Code')).toBeInTheDocument()
    expect(screen.getByText('已检测到程序').parentElement).toHaveTextContent('1')
    const addAgentButton = screen.getByRole('button', { name: /添加 Claude Code 实例/ })
    expect(addAgentButton.parentElement?.lastElementChild).toBe(addAgentButton)
    fireEvent.click(addAgentButton)
    expect(useSkillStoreV2.getState().customAgentDialogRequest).toBe(1)

    cleanup()
    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)

    await waitFor(() => expect(useSkillStoreV2.getState().selectedAgentId).toBe('claude-code'))
    expect(screen.queryByText('.agents')).not.toBeInTheDocument()
  })

  it('sorts installed sidebar agents by active usage and supports drag reorder', async () => {
    window.localStorage.removeItem('vibeboard.agentManagement.agentOrder.v1')
    useSkillStoreV2.setState({
      activeTab: 'agents',
      selectedAgentId: null,
      selectedAgentDetail: null,
      agents: [
        makeSidebarAgent('claude-code', 'Claude Code', { managed: 8 }),
        makeSidebarAgent('codex', 'Codex', { managed: 1 }),
        makeSidebarAgent('workbuddy', 'WorkBuddy', { managed: 0 }),
      ],
    })
    const workbuddySession = makeSidebarSession('workbuddy', { id: 'workbuddy-active', lastActivityAt: Date.now() })
    useSessionStore.setState({
      sessions: { [workbuddySession.id]: workbuddySession },
      sessionList: [workbuddySession],
      activeSessionId: workbuddySession.id,
    })

    const { SettingsSidebar } = await import('../components/settings/SettingsSidebar')
    const { container } = render(
      <SettingsSidebar
        activeSection="skill-manager-v2"
        collapsed={false}
        onCollapsedChange={() => {}}
        onSelect={() => {}}
      />,
    )

    const labels = () => Array.from(container.querySelectorAll('.sm2-sidebar__subitem-label')).map((item) => item.textContent)
    expect(labels().slice(0, 3)).toEqual(['WorkBuddy', 'Claude Code', 'Codex'])

    const workbuddyRow = screen.getByText('WorkBuddy').closest('.sm2-sidebar__subitem-row')
    const claudeRow = screen.getByText('Claude Code').closest('.sm2-sidebar__subitem-row')
    expect(workbuddyRow).not.toBeNull()
    expect(claudeRow).not.toBeNull()
    vi.spyOn(workbuddyRow!, 'getBoundingClientRect').mockReturnValue({
      top: 0, bottom: 32, left: 0, right: 220, width: 220, height: 32, x: 0, y: 0, toJSON: () => ({}),
    })
    vi.spyOn(claudeRow!, 'getBoundingClientRect').mockReturnValue({
      top: 32, bottom: 64, left: 0, right: 220, width: 220, height: 32, x: 0, y: 32, toJSON: () => ({}),
    })
    fireEvent.mouseDown(workbuddyRow!, { button: 0, clientX: 20, clientY: 16 })
    fireEvent.mouseMove(window, { clientX: 20, clientY: 58 })
    fireEvent.mouseUp(window, { clientX: 20, clientY: 58 })

    expect(labels().slice(0, 3)).toEqual(['Claude Code', 'WorkBuddy', 'Codex'])
    expect(JSON.parse(window.localStorage.getItem('vibeboard.agentManagement.agentOrder.v1') || '[]')).toEqual(['claude-code', 'workbuddy', 'codex'])
    window.localStorage.removeItem('vibeboard.agentManagement.agentOrder.v1')
    useSessionStore.setState({ sessions: {}, sessionList: [], activeSessionId: null })
  })

  it('Agent skills default to cards and can switch to list view', async () => {
    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    const { container } = render(<AgentManagementPage />)
    fireEvent.click(screen.getByText('Skills (2)'))
    expect(screen.getByRole('button', { name: '已管理 1' })).toHaveClass('active')
    expect(screen.queryByText('未管理 Skills')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('选择 release-checklist')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /批量删除/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '批量选择' })).toBeInTheDocument()
    expect(container.querySelector('.sm2__agent-skill-grid')).not.toBeNull()
    const card = container.querySelector('.sm2__agent-skill-card')
    expect(card).not.toBeNull()
    expect(card).toHaveClass('sm2__agent-skill-card--clickable')
    expect(card).toHaveAttribute('role', 'button')
    expect(card).toHaveAttribute('tabindex', '0')
    expect(card?.querySelector('.sm2__agent-skill-card-head')).not.toBeNull()
    expect(card?.querySelector('.sm2__agent-skill-icon')).not.toBeNull()
    expect(card?.querySelector('.sm2__agent-skill-card-titleline')).not.toBeNull()
    expect(card?.querySelector('.sm2__agent-skill-meta')).not.toBeNull()
    expect(card?.querySelector('code')).not.toBeNull()
    fireEvent.click(screen.getByText('列表'))
    const row = container.querySelector('.sm2__agent-skill-list .sm2__object-row')
    expect(row).not.toBeNull()
    expect(row).toHaveClass('sm2__object-row--path', 'sm2__object-row--clickable')
    expect(row).toHaveAttribute('role', 'button')
    expect(row).toHaveAttribute('tabindex', '0')
    expect(row).toHaveTextContent('软连接 · 正常 · 直接生效')
  })

  it.each([
    { id: 'codex', displayName: 'Codex', skillsDir: '/Users/me/.codex/skills' },
    { id: 'kimi', displayName: 'Kimi Code', skillsDir: '/Users/me/.kimi-code/skills' },
    { id: 'openclaw', displayName: 'OpenClaw', skillsDir: '/Users/me/.openclaw/workspace/skills' },
    { id: 'zcode', displayName: 'ZCode', skillsDir: '/Users/me/.zcode/skills' },
  ])('shows $displayName shared skills in layered source and status tabs', async ({ id, displayName, skillsDir }) => {
    const consumerDetail: AgentDetail = {
      ...agentDetail,
      id,
      displayName,
      iconKey: id,
      skillsDir,
      skills: [],
      inheritsSharedSkills: true,
      inheritedManagedSkills: [makeSharedTarget('shared-review')],
      inheritedUnmanagedSkills: [makeSharedUnmanaged('shared-writing')],
    }
    useSkillStoreV2.setState({
      agents: [
        { id, displayName, iconKey: id, enabled: true, skillsDir, version: '3.5.3', latestVersion: null, installed: true, managedSkillCount: 0, unmanagedSkillCount: 0 } as AgentSummary,
      ],
      selectedAgentId: id,
      selectedAgentDetail: consumerDetail,
      unmanaged: [
        {
          id: 'shared-source-item',
          agentId: 'agents',
          itemType: 'skill',
          path: '/Users/me/.agents/skills/shared-source-item',
          inferredSkillId: 'shared-source-item',
          hash: null,
          reason: 'shared_agents_directory',
        },
      ],
    })
    const previewAdopt = vi.spyOn(skillApiV2, 'previewAdopt').mockResolvedValue({
      agentId: 'agents',
      unmanagedId: 'raw-shared-writing',
      skillPath: '/Users/me/.agents/skills/shared-writing',
      inferredSkillId: 'shared-writing',
      hash: 'hash-shared-writing',
      centerHasSameId: false,
      canQuickAdopt: true,
      options: [
        { value: 'import_cleanup', label: 'Import and clean up', destructive: true },
        { value: 'skip', label: 'Keep as unmanaged', destructive: false },
      ],
    })

    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    const { container } = render(<AgentManagementPage />)

    expect(screen.getByRole('button', { name: 'Skills (2)' })).toBeInTheDocument()
    expect(screen.getByText('共享继承', { selector: '.sm2__stat span' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Skills (2)' }))

    expect(screen.getByRole('button', { name: 'Agent 专属 0' })).toHaveClass('active')
    expect(screen.getByRole('button', { name: 'Agent 专属 0' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '已管理 0' })).toHaveClass('active')
    expect(screen.getByRole('button', { name: '已管理 0' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '未管理 0' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^全部(?:\s|$)/ })).not.toBeInTheDocument()
    expect(screen.queryByText('shared-source-item')).not.toBeInTheDocument()

    const inheritedTab = screen.getByRole('button', { name: '共享继承 2' })
    fireEvent.click(inheritedTab)

    expect(inheritedTab).toHaveClass('active')
    expect(screen.getByRole('button', { name: '已管理 1' })).toHaveClass('active')
    expect(screen.getByRole('button', { name: '未管理 1' })).toBeInTheDocument()
    expect(screen.getByText(new RegExp(`${displayName} 默认读取 ~\\/.agents\\/skills`))).toBeInTheDocument()
    expect(screen.getByText('/Users/me/.agents/skills/shared-review')).toBeInTheDocument()
    expect(screen.queryByText('/Users/me/.agents/skills/shared-writing')).not.toBeInTheDocument()
    const inheritedCard = screen.getByText('shared-review').closest('article')
    expect(inheritedCard).not.toBeNull()
    expect(inheritedCard).toHaveClass('sm2__agent-skill-card--clickable')
    expect(inheritedCard).not.toHaveClass('sm2__agent-skill-card--adopting')
    expect(inheritedCard).toHaveAttribute('role', 'button')
    expect(inheritedCard).toHaveAttribute('tabindex', '0')
    expect(inheritedCard).not.toHaveAttribute('aria-busy')
    expect(inheritedCard?.querySelector('.sm2__agent-skill-card-head')).not.toBeNull()
    expect(inheritedCard?.querySelector('.sm2__agent-skill-icon')).not.toBeNull()
    expect(inheritedCard?.querySelector('.sm2__agent-skill-card-titleline')).not.toBeNull()
    expect(inheritedCard?.querySelector('code')).toHaveTextContent('/Users/me/.agents/skills/shared-review')
    expect(within(inheritedCard!).getByText('软连接', { selector: '.sm2__source-pill' })).toBeInTheDocument()
    expect(within(inheritedCard!).getByText('正常')).toBeInTheDocument()
    expect(within(inheritedCard!).getByRole('button', { name: '删除 shared-review' })).toBeInTheDocument()
    expect(within(inheritedCard!).queryByRole('checkbox')).not.toBeInTheDocument()
    expect(within(inheritedCard!).queryByRole('button', { name: /归入技能包/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '批量选择' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新增SKILL' })).not.toBeInTheDocument()

    fireEvent.click(within(inheritedCard!).getByRole('button', { name: '删除 shared-review' }))
    expect(document.body.querySelector('.sm2__slideover--skill-detail')).toBeNull()
    const sharedDeleteDialog = screen.getByRole('heading', { name: '移除共享的已管理 Skill？' }).closest<HTMLElement>('[role="dialog"]')
    expect(sharedDeleteDialog).not.toBeNull()
    expect(within(sharedDeleteDialog!).getByText(/所有读取该共享目录的 Agent/)).toBeInTheDocument()
    expect(within(sharedDeleteDialog!).getByText(/中心库中的 Skill 会保留/)).toBeInTheDocument()
    fireEvent.click(within(sharedDeleteDialog!).getByRole('button', { name: '取消' }))

    fireEvent.click(screen.getByText('列表'))
    const managedInheritedRow = screen.getByText('/Users/me/.agents/skills/shared-review').closest<HTMLElement>('.sm2__object-row')
    expect(managedInheritedRow).not.toBeNull()
    expect(managedInheritedRow).toHaveClass('sm2__object-row--path', 'sm2__object-row--clickable')
    expect(managedInheritedRow).toHaveAttribute('role', 'button')
    expect(managedInheritedRow).toHaveAttribute('tabindex', '0')
    expect(managedInheritedRow).toHaveTextContent('软连接 · 正常 · 直接生效')
    expect(within(managedInheritedRow!).getByRole('button', { name: '删除 shared-review' })).toBeInTheDocument()
    fireEvent.click(screen.getByText('卡片'))

    fireEvent.change(screen.getByPlaceholderText('搜索 Skill 名称 / 路径 / 来源 / 原因'), { target: { value: 'missing-skill' } })
    expect(screen.getByRole('button', { name: '共享继承 2' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '已管理 1' })).toBeInTheDocument()
    expect(screen.getByText('没有匹配的已管理共享 Skill。')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('搜索 Skill 名称 / 路径 / 来源 / 原因'), { target: { value: '' } })

    fireEvent.click(screen.getByRole('button', { name: '未管理 1' }))
    expect(screen.getByText('/Users/me/.agents/skills/shared-writing')).toBeInTheDocument()
    expect(screen.queryByText('/Users/me/.agents/skills/shared-review')).not.toBeInTheDocument()
    const unmanagedCard = screen.getByText('shared-writing').closest('article')
    expect(unmanagedCard).not.toBeNull()
    expect(unmanagedCard).toHaveClass('sm2__agent-skill-card--clickable', 'sm2__agent-skill-card--unmanaged')
    expect(unmanagedCard).toHaveAttribute('role', 'button')
    expect(unmanagedCard).toHaveAttribute('tabindex', '0')
    expect(unmanagedCard?.querySelector('.sm2__agent-skill-card-head')).not.toBeNull()
    expect(unmanagedCard?.querySelector('.sm2__agent-skill-icon')).not.toBeNull()
    expect(unmanagedCard?.querySelector('.sm2__agent-skill-card-titleline')).not.toBeNull()
    expect(unmanagedCard?.querySelector('code')).toHaveTextContent('/Users/me/.agents/skills/shared-writing')
    expect(within(unmanagedCard!).getByText('.agents 共享目录', { selector: '.sm2__source-pill' })).toBeInTheDocument()
    expect(within(unmanagedCard!).getByText('未管理')).toBeInTheDocument()
    expect(within(unmanagedCard!).getByRole('button', { name: '接管' })).toBeInTheDocument()
    expect(within(unmanagedCard!).getByRole('button', { name: '删除 shared-writing' })).toBeInTheDocument()
    expect(within(unmanagedCard!).queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '批量管理' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /一键接管/ })).not.toBeInTheDocument()

    fireEvent.click(within(unmanagedCard!).getByRole('button', { name: '接管' }))
    expect(document.body.querySelector('.sm2__slideover--skill-detail')).toBeNull()
    await waitFor(() => {
      expect(previewAdopt).toHaveBeenCalledTimes(1)
      expect(previewAdopt).toHaveBeenCalledWith('agents', 'raw-shared-writing')
    })
    const adoptHeading = await screen.findByRole('heading', { name: '接管 shared-writing' })
    const adoptDialog = adoptHeading.closest<HTMLElement>('[role="dialog"]')
    expect(adoptDialog).not.toBeNull()
    fireEvent.click(within(adoptDialog!).getByRole('button', { name: '取消' }))

    fireEvent.click(screen.getByText('列表'))
    expect(container.querySelector('.sm2__agent-skill-list')).not.toBeNull()
    const inheritedRow = screen.getByText('/Users/me/.agents/skills/shared-writing').closest<HTMLElement>('.sm2__object-row')
    expect(inheritedRow).not.toBeNull()
    expect(inheritedRow).toHaveClass('sm2__object-row--path', 'sm2__object-row--clickable')
    expect(inheritedRow).toHaveAttribute('role', 'button')
    expect(inheritedRow).toHaveAttribute('tabindex', '0')
    expect(inheritedRow).toHaveTextContent('未在中心库 · .agents 共享目录')
    expect(within(inheritedRow!).getByRole('button', { name: '接管' })).toBeInTheDocument()
    expect(within(inheritedRow!).getByRole('button', { name: '删除 shared-writing' })).toBeInTheDocument()
  })

  it('renders shared managed and unmanaged actions from the English action translations', async () => {
    await i18n.changeLanguage('en')
    useSkillStoreV2.setState({
      agents: [makeSidebarAgent('codex', 'Codex')],
      selectedAgentId: 'codex',
      selectedAgentDetail: {
        ...agentDetail,
        id: 'codex',
        displayName: 'Codex',
        iconKey: 'codex',
        skillsDir: '/Users/me/.codex/skills',
        inheritsSharedSkills: true,
        inheritedManagedSkills: [makeSharedTarget('shared-review')],
        inheritedUnmanagedSkills: [makeSharedUnmanaged('shared-writing')],
      },
      unmanaged: [],
    })

    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Skills (3)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Inherited 2' }))

    expect(screen.getByRole('button', { name: 'Delete shared-review' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Multi-select' }))
    expect(screen.getByText('0 selected')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Select current' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete 0 Skills' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel selection' }))

    fireEvent.click(screen.getByRole('button', { name: 'Unmanaged 1' }))
    expect(screen.getByRole('button', { name: 'Adopt' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete shared-writing' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Batch manage' }))
    expect(screen.getByRole('button', { name: 'Select current adoptable' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Adopt into center library' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel selection' })).toBeInTheDocument()
  })

  it('deduplicates the top-level Skills count by logical Skill ID across Agent and shared sources', async () => {
    useSkillStoreV2.setState({
      agents: [makeSidebarAgent('codex', 'Codex')],
      selectedAgentId: 'codex',
      selectedAgentDetail: {
        ...agentDetail,
        id: 'codex',
        displayName: 'Codex',
        iconKey: 'codex',
        skillsDir: '/Users/me/.codex/skills',
        inheritsSharedSkills: true,
        inheritedManagedSkills: [makeSharedTarget('release-checklist')],
        inheritedUnmanagedSkills: [],
      },
      unmanaged: [],
    })

    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Skills (1)' }))
    expect(screen.getByRole('button', { name: 'Agent 专属 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '共享继承 1' })).toBeInTheDocument()
  })

  it('opens shared managed Skill details through the standard managed card', async () => {
    const consumerDetail: AgentDetail = {
      ...agentDetail,
      id: 'codex',
      displayName: 'Codex',
      iconKey: 'codex',
      skillsDir: '/Users/me/.codex/skills',
      skills: [],
      inheritsSharedSkills: true,
      inheritedManagedSkills: [makeSharedTarget('shared-review')],
      inheritedUnmanagedSkills: [],
    }
    useSkillStoreV2.setState({
      agents: [makeSidebarAgent('codex', 'Codex')],
      selectedAgentId: 'codex',
      selectedAgentDetail: consumerDetail,
      unmanaged: [],
    })
    const getSkillDetail = vi.spyOn(skillApiV2, 'getSkillDetail').mockResolvedValue({
      ...makeSkill({
        id: 'shared-review',
        name: 'shared-review',
        centerPath: '/Users/me/.agentbro/skills/shared-review',
        installedAgents: [
          { agentId: 'agents', displayName: '.agents', iconKey: 'agents', mode: 'link', status: 'ok' },
        ],
      }),
      frontmatter: {},
      files: null,
      targets: [
        makeTarget({
          id: 'target-shared-review',
          skillId: 'shared-review',
          agentId: 'agents',
          targetPath: '/Users/me/.agents/skills/shared-review',
        }),
      ],
      source: null,
    })

    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Skills (1)' }))
    fireEvent.click(screen.getByRole('button', { name: '共享继承 1' }))
    const inheritedCard = screen.getByText('shared-review', { selector: '.sm2__agent-skill-card-titleline strong' }).closest('article')
    expect(inheritedCard).not.toBeNull()
    fireEvent.click(inheritedCard!)

    const slider = await waitFor(() => {
      const node = document.body.querySelector('.sm2__slideover--skill-detail')
      expect(node).not.toBeNull()
      return node as HTMLElement
    })
    expect(within(slider).getByRole('button', { name: '概览' })).toBeInTheDocument()
    expect(within(slider).getByRole('button', { name: '文件' })).toBeInTheDocument()
    expect(within(slider).getByRole('button', { name: '来源' })).toBeInTheDocument()
    expect(slider.querySelector('.sm2__detail-pills .sm2__tag--ok')).toHaveTextContent('正常')
    expect(getSkillDetail).toHaveBeenCalledWith('shared-review')
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

  it('keeps the inherited scope visible for a consumer with an empty shared directory', async () => {
    useSkillStoreV2.setState({
      agents: [
        {
          id: 'codex',
          displayName: 'Codex',
          iconKey: 'codex',
          enabled: true,
          skillsDir: '/Users/me/.codex/skills',
          version: null,
          latestVersion: null,
          installed: true,
          managedSkillCount: 1,
          unmanagedSkillCount: 0,
        } as AgentSummary,
      ],
      selectedAgentId: 'codex',
      selectedAgentDetail: {
        ...agentDetail,
        id: 'codex',
        displayName: 'Codex',
        iconKey: 'codex',
        skillsDir: '/Users/me/.codex/skills',
        inheritsSharedSkills: true,
        inheritedManagedSkills: [],
        inheritedUnmanagedSkills: [],
      },
      unmanaged: [],
    })

    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Skills (1)' }))
    expect(screen.getByRole('button', { name: 'Agent 专属 1' })).toHaveClass('active')
    fireEvent.click(screen.getByRole('button', { name: '共享继承 0' }))
    expect(screen.getByText(/Codex 默认读取 ~\/.agents\/skills/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '已管理 0' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '未管理 0' })).toBeInTheDocument()
    expect(screen.getByText('没有匹配的已管理共享 Skill。')).toBeInTheDocument()
  })

  it('keeps shared status paging within the selected source', async () => {
    const inheritedUnmanagedSkills = Array.from(
      { length: 29 },
      (_, index) => makeSharedUnmanaged(`shared-${index}`),
    )
    useSkillStoreV2.setState({
      agents: [makeSidebarAgent('codex', 'Codex')],
      selectedAgentId: 'codex',
      selectedAgentDetail: {
        ...agentDetail,
        id: 'codex',
        displayName: 'Codex',
        iconKey: 'codex',
        skillsDir: '/Users/me/.codex/skills',
        skills: [],
        inheritsSharedSkills: true,
        inheritedManagedSkills: [],
        inheritedUnmanagedSkills,
      },
      unmanaged: [],
    })

    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Skills (29)' }))
    fireEvent.click(screen.getByRole('button', { name: '共享继承 29' }))
    fireEvent.click(screen.getByRole('button', { name: '未管理 29' }))

    expect(screen.getByText('shared-27')).toBeInTheDocument()
    expect(screen.queryByText('shared-28')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '继续显示 1 个' }))
    expect(screen.getByText('shared-28')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '未管理 29' })).toBeInTheDocument()
  })

  it('does not expose shared inventory as inherited or unmanaged for a non-consumer', async () => {
    useSkillStoreV2.setState({
      selectedAgentDetail: {
        ...agentDetail,
        inheritsSharedSkills: false,
        inheritedManagedSkills: [],
        inheritedUnmanagedSkills: [],
      },
      unmanaged: [
        {
          id: 'shared-source-item',
          agentId: 'agents',
          itemType: 'skill',
          path: '/Users/me/.agents/skills/shared-source-item',
          inferredSkillId: 'shared-source-item',
          hash: null,
          reason: 'shared_agents_directory',
        },
      ],
    })

    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Skills (1)' }))
    expect(screen.queryByRole('button', { name: /共享继承/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Agent 专属/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '已管理 1' })).toHaveClass('active')
    expect(screen.getByRole('button', { name: '未管理 0' })).toBeInTheDocument()
    expect(screen.queryByText('shared-source-item')).not.toBeInTheDocument()
  })

  it('resets shared source and unmanaged status when changing Agents', async () => {
    const codexDetail: AgentDetail = {
      ...agentDetail,
      id: 'codex',
      displayName: 'Codex',
      iconKey: 'codex',
      skillsDir: '/Users/me/.codex/skills',
      skills: [],
      inheritsSharedSkills: true,
      inheritedManagedSkills: [],
      inheritedUnmanagedSkills: [makeSharedUnmanaged('shared-reset')],
    }
    useSkillStoreV2.setState({
      agents: [
        makeSidebarAgent('codex', 'Codex'),
        makeSidebarAgent('claude-code', 'Claude Code', { managed: 1, unmanaged: 1 }),
      ],
      selectedAgentId: 'codex',
      selectedAgentDetail: codexDetail,
      unmanaged: [],
    })

    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Skills (1)' }))
    fireEvent.click(screen.getByRole('button', { name: '共享继承 1' }))
    fireEvent.click(screen.getByRole('button', { name: '未管理 1' }))
    expect(screen.getByText('shared-reset')).toBeInTheDocument()

    act(() => {
      useSkillStoreV2.setState({
        selectedAgentId: 'claude-code',
        selectedAgentDetail: {
          ...agentDetail,
          inheritsSharedSkills: false,
          inheritedManagedSkills: [],
          inheritedUnmanagedSkills: [],
        },
        unmanaged: [
          {
            id: 'claude-unmanaged-reset',
            agentId: 'claude-code',
            itemType: 'skill',
            path: '/c/skills/unmanaged-reset',
            inferredSkillId: 'unmanaged-reset',
            hash: null,
            reason: 'not_in_center_library',
          },
        ],
      })
    })

    await waitFor(() => expect(screen.queryByRole('button', { name: /共享继承/ })).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /共享继承/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Agent 专属/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '已管理 1' })).toHaveClass('active')
    expect(screen.getByText('release-checklist')).toBeInTheDocument()
    expect(screen.queryByText('unmanaged-reset')).not.toBeInTheDocument()
  })

  it('opens a center library install dialog from Agent skills and distributes only to the selected agent', async () => {
    useSkillStoreV2.setState({
      skills: [
        makeSkill({
          id: 'release-checklist',
          name: 'Release Checklist',
          description: 'Pre-release QA skill',
          sourceType: 'skills.sh',
          installedAgents: [
            { agentId: 'claude-code', displayName: 'Claude Code', iconKey: 'claude-code', mode: 'link', status: 'ok' },
          ],
        }),
        makeSkill({
          id: 'frontend-design',
          name: 'frontend-design',
          description: 'Visual design guidance',
          sourceType: 'github',
          installedAgents: [],
        }),
      ],
    })
    const preview: DistributionPreview = {
      skillIds: ['frontend-design'],
      targetAgents: ['claude-code'],
      requestedMode: 'link',
      changes: [
        {
          skillId: 'frontend-design',
          agentId: 'claude-code',
          action: 'create',
          actualMode: 'link',
          targetPath: '/c/skills/frontend-design',
        },
      ],
      blockers: [],
      blockerDecisions: [],
    }
    const previewDistribute = vi.spyOn(skillApiV2, 'previewDistribute').mockResolvedValueOnce(preview)
    const executeDistribute = vi.spyOn(skillApiV2, 'executeDistribute').mockResolvedValueOnce(preview)
    const loadAgentDetail = vi.spyOn(useSkillStoreV2.getState(), 'loadAgentDetail').mockResolvedValue(undefined)
    const loadOverview = vi.spyOn(useSkillStoreV2.getState(), 'loadOverview').mockResolvedValue(undefined)

    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)
    fireEvent.click(screen.getByText('Skills (2)'))
    fireEvent.click(screen.getByRole('button', { name: '新增SKILL' }))

    expect(screen.getByRole('heading', { name: '从技能库添加' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '从技能库添加' }).closest('.sm2__modal')).toHaveClass('sm2__modal--light-surface')
    expect(screen.getByText('目标：')).toBeInTheDocument()
    expect(screen.getAllByText('Claude Code').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: '未安装 1' })).toHaveClass('active')
    expect(screen.getByText('frontend-design')).toBeInTheDocument()
    expect(screen.queryByText('Release Checklist')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '已安装 1' }))
    expect(screen.getByText('Release Checklist')).toBeInTheDocument()
    expect(screen.queryByText('frontend-design')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '未安装 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'GitHub' }))
    fireEvent.click(screen.getByLabelText('选择 frontend-design'))
    fireEvent.click(screen.getByRole('button', { name: '添加 1 个 Skill' }))

    await waitFor(() => {
      expect(previewDistribute).toHaveBeenCalledWith(['frontend-design'], ['claude-code'], 'link')
    })
    fireEvent.click(await screen.findByRole('button', { name: '执行生效' }))
    await waitFor(() => expect(executeDistribute).toHaveBeenCalledWith(preview))
    expect(loadAgentDetail).toHaveBeenCalledWith('claude-code', true)
    expect(loadOverview).toHaveBeenCalledWith(true)
  })

  it('shows Doubao built-in skills separately without adopt or delete actions', async () => {
    useSkillStoreV2.setState({
      agents: [
        {
          ...makeSidebarAgent('doubao', 'Doubao'),
          readOnlySkillCount: 1,
        },
      ],
      selectedAgentId: 'doubao',
      selectedAgentDetail: {
        ...agentDetail,
        id: 'doubao',
        displayName: 'Doubao',
        iconKey: 'doubao',
        skillsDir: '/Users/me/Doubao/skills',
        skills: [],
      },
      unmanaged: [
        {
          id: 'doubao-builtin-browser-task',
          agentId: 'doubao',
          itemType: 'agent_skill',
          path: '/Users/me/Library/Application Support/Doubao/Default/.doubao/agent_mode/workspace/.skills/browser-task',
          inferredSkillId: 'browser-task',
          hash: 'builtin-hash',
          reason: 'agent_builtin_read_only',
          readOnly: true,
        },
      ],
    })

    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)
    fireEvent.click(screen.getByText('Skills (1)'))
    fireEvent.click(screen.getByRole('button', { name: '内置只读 1' }))

    expect(screen.getByText('browser-task')).toBeInTheDocument()
    expect(screen.getByText(/1 个 Skill 由 Doubao 内置提供/)).toBeInTheDocument()
    expect(screen.getAllByText('Agent 内置（只读）').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: '接管' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /删除 browser-task/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '批量管理' })).not.toBeInTheDocument()
  })

  it('enters managed skill multi-select only after a batch action', async () => {
    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)
    fireEvent.click(screen.getByText('Skills (2)'))

    expect(screen.queryByLabelText('选择 release-checklist')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '批量选择' }))

    expect(screen.getByLabelText('选择 release-checklist')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '批量删除 0 个' })).toBeInTheDocument()
  })

  it('shows immediate deleting feedback for a managed skill card', async () => {
    let finishDelete: (() => void) | null = null
    vi.spyOn(skillApiV2, 'deleteSkillTargetDistributions').mockImplementationOnce((targetIds) => new Promise((resolve) => {
      finishDelete = () => resolve({ deleted: targetIds.length, failures: [] })
    }))
    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    const { container } = render(<AgentManagementPage />)
    fireEvent.click(screen.getByText('Skills (2)'))

    fireEvent.click(screen.getByRole('button', { name: '删除 release-checklist' }))

    const deletingButton = (await screen.findAllByRole('button', { name: /删除中/ })).find((element) => element.tagName === 'BUTTON')
    expect(deletingButton).toBeTruthy()
    expect(deletingButton!).toHaveAttribute('aria-busy', 'true')
    expect(container.querySelector('.sm2__agent-skill-card--deleting')).not.toBeNull()

    expect(finishDelete).toBeTypeOf('function')
    ;(finishDelete as unknown as () => void)()
  })

  it('deletes managed skills directly from the agent skill cards and in batches', async () => {
    const deleteTargets = vi.spyOn(skillApiV2, 'deleteSkillTargetDistributions').mockResolvedValue({ deleted: 1, failures: [] })
    deleteTargets.mockClear()
    const refreshAgentSkillView = vi.mocked(skillApiV2.refreshAgentSkillView)
    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)
    fireEvent.click(screen.getByText('Skills (2)'))

    fireEvent.click(screen.getByRole('button', { name: '删除 release-checklist' }))
    await waitFor(() => expect(deleteTargets).toHaveBeenCalledWith(['target-1']))
    await waitFor(() => expect(screen.queryByRole('button', { name: '删除 release-checklist' })).not.toBeInTheDocument())

    act(() => {
      useSkillStoreV2.setState({ selectedAgentDetail: agentDetail })
    })

    fireEvent.click(screen.getByRole('button', { name: '批量选择' }))
    fireEvent.click(screen.getByLabelText('选择 release-checklist'))
    fireEvent.click(screen.getByRole('button', { name: '批量删除 1 个' }))
    expect(screen.getByRole('heading', { name: '确认批量删除 Skill？' })).toBeInTheDocument()
    expect(screen.getByText('1个SKILL 将从当前Agent直接删除，您后续仍旧可以从中心库安装')).toBeInTheDocument()
    expect(deleteTargets).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    expect(screen.queryByRole('heading', { name: '确认批量删除 Skill？' })).not.toBeInTheDocument()
    await waitFor(() => expect(deleteTargets).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(refreshAgentSkillView).toHaveBeenCalledWith('claude-code'))
  })

  it('retries the composite Agent Skill refresh once without using the legacy list chain', async () => {
    vi.spyOn(skillApiV2, 'deleteSkillTargetDistributions').mockResolvedValue({ deleted: 1, failures: [] })
    const refreshAgentSkillView = vi.mocked(skillApiV2.refreshAgentSkillView)
    refreshAgentSkillView.mockRejectedValueOnce(new Error('temporary refresh failure'))
    const listUnmanaged = vi.spyOn(skillApiV2, 'listUnmanaged')
    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)
    fireEvent.click(screen.getByText('Skills (2)'))

    fireEvent.click(screen.getByRole('button', { name: '删除 release-checklist' }))

    await waitFor(() => expect(refreshAgentSkillView).toHaveBeenCalledTimes(2))
    expect(listUnmanaged).not.toHaveBeenCalled()
    expect(useSkillStoreV2.getState().error).toBeNull()
  })

  it('cancels managed skill batch deletion from the confirmation dialog', async () => {
    const deleteTargets = vi.spyOn(skillApiV2, 'deleteSkillTargetDistributions').mockResolvedValue({ deleted: 1, failures: [] })
    deleteTargets.mockClear()
    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)
    fireEvent.click(screen.getByText('Skills (2)'))
    fireEvent.click(screen.getByRole('button', { name: '批量选择' }))
    fireEvent.click(screen.getByLabelText('选择 release-checklist'))

    fireEvent.click(screen.getByRole('button', { name: '批量删除 1 个' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    expect(screen.queryByRole('heading', { name: '确认批量删除 Skill？' })).not.toBeInTheDocument()
    expect(deleteTargets).not.toHaveBeenCalled()
    expect(screen.getByLabelText('选择 release-checklist')).toBeChecked()
  })

  it('confirms global impact before deleting a shared managed Skill by its target ID', async () => {
    useSkillStoreV2.setState({
      selectedAgentDetail: {
        ...agentDetail,
        id: 'codex',
        displayName: 'Codex',
        iconKey: 'codex',
        inheritsSharedSkills: true,
        inheritedManagedSkills: [makeSharedTarget('shared-review', { id: 'target-shared-review' })],
        inheritedUnmanagedSkills: [],
      },
      selectedAgentId: 'codex',
      agents: [makeSidebarAgent('codex', 'Codex')],
      unmanaged: [],
    })
    let finishDelete: (() => void) | null = null
    const deleteTargets = vi.spyOn(skillApiV2, 'deleteSkillTargetDistributions').mockImplementation(() => new Promise((resolve) => {
      finishDelete = () => resolve({ deleted: 1, failures: [] })
    }))
    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Skills (2)' }))
    fireEvent.click(screen.getByRole('button', { name: '共享继承 1' }))

    fireEvent.click(screen.getByRole('button', { name: '删除 shared-review' }))

    const dialog = screen.getByRole('dialog', { name: '移除共享的已管理 Skill？' })
    expect(dialog).toHaveTextContent('所有读取该共享目录的 Agent 都将无法再使用它')
    expect(dialog).toHaveTextContent('中心库中的 Skill 会保留')
    expect(deleteTargets).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: '从共享目录删除' }))

    expect(screen.queryByRole('dialog', { name: '移除共享的已管理 Skill？' })).not.toBeInTheDocument()
    await waitFor(() => expect(deleteTargets).toHaveBeenCalledWith(['target-shared-review']))
    expect(screen.getByRole('button', { name: '删除中 shared-review' })).toHaveAttribute('aria-busy', 'true')
    expect(finishDelete).toBeTypeOf('function')
    ;(finishDelete as unknown as () => void)()
    await waitFor(() => expect(screen.queryByText('shared-review')).not.toBeInTheDocument())
  })

  it('batch deletes shared managed Skills through the standard selection controls', async () => {
    useSkillStoreV2.setState({
      selectedAgentDetail: {
        ...agentDetail,
        id: 'codex',
        displayName: 'Codex',
        iconKey: 'codex',
        inheritsSharedSkills: true,
        inheritedManagedSkills: [
          makeSharedTarget('shared-review', { id: 'target-shared-review' }),
          makeSharedTarget('shared-writing', { id: 'target-shared-writing' }),
        ],
        inheritedUnmanagedSkills: [],
      },
      selectedAgentId: 'codex',
      agents: [makeSidebarAgent('codex', 'Codex')],
      unmanaged: [],
    })
    const deleteTargets = vi.spyOn(skillApiV2, 'deleteSkillTargetDistributions').mockResolvedValue({ deleted: 2, failures: [] })
    vi.spyOn(skillApiV2, 'listUnmanaged').mockResolvedValue([])
    vi.spyOn(useSkillStoreV2.getState(), 'loadAgentDetail').mockResolvedValue(undefined)
    vi.spyOn(useSkillStoreV2.getState(), 'loadOverview').mockResolvedValue(undefined)
    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Skills (3)' }))
    fireEvent.click(screen.getByRole('button', { name: '共享继承 2' }))
    fireEvent.click(screen.getByRole('button', { name: '批量选择' }))
    fireEvent.click(screen.getByRole('button', { name: '选择当前' }))
    fireEvent.click(screen.getByRole('button', { name: '批量删除 2 个' }))

    const dialog = screen.getByRole('dialog', { name: '移除共享的已管理 Skill？' })
    fireEvent.click(within(dialog).getByRole('button', { name: '从共享目录删除' }))

    await waitFor(() => expect(deleteTargets).toHaveBeenCalledWith(['target-shared-review', 'target-shared-writing']))
  })

  it('deletes an unmanaged agent skill from the skill card after confirmation', async () => {
    const deleteUnmanaged = vi.spyOn(skillApiV2, 'deleteUnmanagedAgentSkills').mockResolvedValue({ deleted: 1, failures: [] })
    const refreshAgentSkillView = vi.mocked(skillApiV2.refreshAgentSkillView)
    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)
    fireEvent.click(screen.getByText('Skills (2)'))
    fireEvent.click(screen.getByRole('button', { name: '未管理 1' }))

    fireEvent.click(screen.getByRole('button', { name: '删除 manual-skill' }))
    const dialog = screen.getByRole('dialog', { name: '删除 Skill「manual-skill」？' })
    expect(dialog).toBeInTheDocument()
    expect(dialog).toHaveTextContent('/c/skills/manual-skill')
    fireEvent.click(screen.getByRole('button', { name: '直接删除' }))
    expect(screen.queryByRole('dialog', { name: '删除 Skill「manual-skill」？' })).not.toBeInTheDocument()

    await waitFor(() => expect(deleteUnmanaged).toHaveBeenCalledWith('claude-code', ['unmanaged-1']))
    await waitFor(() => expect(refreshAgentSkillView).toHaveBeenCalledWith('claude-code'))
  })

  it('permanently deletes a shared unmanaged Skill with owner agents after confirmation', async () => {
    useSkillStoreV2.setState({
      selectedAgentDetail: {
        ...agentDetail,
        id: 'codex',
        displayName: 'Codex',
        iconKey: 'codex',
        inheritsSharedSkills: true,
        inheritedManagedSkills: [],
        inheritedUnmanagedSkills: [makeSharedUnmanaged('shared-writing')],
      },
      selectedAgentId: 'codex',
      agents: [makeSidebarAgent('codex', 'Codex')],
      unmanaged: [],
    })
    const deleteUnmanaged = vi.spyOn(skillApiV2, 'deleteUnmanagedAgentSkills').mockResolvedValue({ deleted: 1, failures: [] })
    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Skills (2)' }))
    fireEvent.click(screen.getByRole('button', { name: '共享继承 1' }))
    fireEvent.click(screen.getByRole('button', { name: '未管理 1' }))

    fireEvent.click(screen.getByRole('button', { name: '删除 shared-writing' }))

    const dialog = screen.getByRole('dialog', { name: '永久删除共享的未管理 Skill？' })
    expect(dialog).toHaveTextContent('所有读取该共享目录的 Agent 都会受到影响')
    expect(dialog).toHaveTextContent('不会复制到中心库')
    expect(deleteUnmanaged).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: '从共享目录删除' }))
    expect(screen.queryByRole('dialog', { name: '永久删除共享的未管理 Skill？' })).not.toBeInTheDocument()

    await waitFor(() => expect(deleteUnmanaged).toHaveBeenCalledWith('agents', ['raw-shared-writing']))
  })

  it('closes the unmanaged confirmation dialog and keeps failed items visible', async () => {
    const codexItem = {
      id: 'unmanaged-codex-bird',
      agentId: 'codex',
      itemType: 'skill' as const,
      path: '/Users/me/.codex/skills/bird',
      inferredSkillId: 'bird',
      hash: null,
      reason: 'not_in_center_library',
    }
    useSkillStoreV2.setState({
      selectedAgentId: 'codex',
      selectedAgentDetail: {
        ...agentDetail,
        id: 'codex',
        displayName: 'Codex',
        iconKey: 'codex',
        skillsDir: '/Users/me/.codex/skills',
      },
      agents: [
        { id: 'codex', displayName: 'Codex', iconKey: 'codex', enabled: true, skillsDir: '/Users/me/.codex/skills', version: null, latestVersion: null, installed: true, managedSkillCount: 1, unmanagedSkillCount: 1 } as AgentSummary,
      ],
      unmanaged: [codexItem],
    })
    const mismatch = new Error(
      "Unmanaged item 'unmanaged-codex-bird' does not belong to agent 'codex'.",
    )
    const deleteUnmanaged = vi.spyOn(skillApiV2, 'deleteUnmanagedAgentSkills').mockResolvedValue({
      deleted: 0,
      failures: [{ unmanagedId: 'unmanaged-codex-bird', error: mismatch.message }],
    })
    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)
    fireEvent.click(screen.getByText('Skills (2)'))
    fireEvent.click(screen.getByRole('button', { name: '未管理 1' }))
    fireEvent.click(screen.getByRole('button', { name: '删除 bird' }))

    const dialog = screen.getByRole('dialog', { name: '删除 Skill「bird」？' })
    expect(dialog).toHaveClass('sm2__modal--unmanaged-delete')
    fireEvent.click(within(dialog).getByRole('button', { name: '直接删除' }))

    expect(screen.queryByRole('dialog', { name: '删除 Skill「bird」？' })).not.toBeInTheDocument()
    await waitFor(() => expect(deleteUnmanaged).toHaveBeenCalledWith('codex', ['unmanaged-codex-bird']))
    expect(await screen.findByText(/该未管理 Skill 不属于 Agent「codex」，请重新扫描后重试/)).toBeInTheDocument()
    expect(useSkillStoreV2.getState().unmanaged).toContainEqual(codexItem)
  })

  it('deletes selected unmanaged agent skills in a batch after confirmation', async () => {
    useSkillStoreV2.setState({
      unmanaged: [
        ...useSkillStoreV2.getState().unmanaged,
        {
          id: 'unmanaged-2',
          agentId: 'claude-code',
          itemType: 'skill',
          path: '/c/skills/another-skill',
          inferredSkillId: 'another-skill',
          hash: null,
          reason: 'not_in_center_library',
        },
      ],
    })
    const deleteUnmanaged = vi.spyOn(skillApiV2, 'deleteUnmanagedAgentSkills').mockResolvedValue({ deleted: 2, failures: [] })
    const refreshAgentSkillView = vi.mocked(skillApiV2.refreshAgentSkillView)
    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)
    fireEvent.click(screen.getByText('Skills (3)'))
    fireEvent.click(screen.getByRole('button', { name: '未管理 2' }))
    fireEvent.click(screen.getByRole('button', { name: '批量管理' }))
    fireEvent.click(screen.getByRole('button', { name: '选择当前可接管' }))

    fireEvent.click(screen.getByRole('button', { name: '批量删除 2 个' }))
    const dialog = screen.getByRole('dialog', { name: '确认批量删除未管理 Skill？' })
    expect(dialog).toHaveTextContent('2 个未管理 Skill 将从当前 Agent 直接删除。')
    expect(deleteUnmanaged).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    expect(screen.queryByRole('dialog', { name: '确认批量删除未管理 Skill？' })).not.toBeInTheDocument()

    await waitFor(() => expect(deleteUnmanaged).toHaveBeenCalledWith('claude-code', ['unmanaged-1', 'unmanaged-2']))
    await waitFor(() => expect(refreshAgentSkillView).toHaveBeenCalledWith('claude-code'))
  })

  it('removes successful unmanaged batch items and keeps failed items selected', async () => {
    const failedItem: UnmanagedItemDto = {
      id: 'unmanaged-2',
      agentId: 'claude-code',
      itemType: 'skill',
      path: '/c/skills/another-skill',
      inferredSkillId: 'another-skill',
      hash: null,
      reason: 'not_in_center_library',
    }
    useSkillStoreV2.setState({
      unmanaged: [...useSkillStoreV2.getState().unmanaged, failedItem],
    })
    vi.spyOn(skillApiV2, 'deleteUnmanagedAgentSkills').mockResolvedValue({
      deleted: 1,
      failures: [{ unmanagedId: failedItem.id, error: 'permission denied' }],
    })
    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)
    fireEvent.click(screen.getByText('Skills (3)'))
    fireEvent.click(screen.getByRole('button', { name: '未管理 2' }))
    fireEvent.click(screen.getByRole('button', { name: '批量管理' }))
    fireEvent.click(screen.getByRole('button', { name: '选择当前可接管' }))
    fireEvent.click(screen.getByRole('button', { name: '批量删除 2 个' }))

    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))

    await waitFor(() => expect(screen.queryByText('manual-skill')).not.toBeInTheDocument())
    expect(screen.getByText('another-skill')).toBeInTheDocument()
    expect(screen.getByLabelText('选择 another-skill')).toBeChecked()
    expect(useSkillStoreV2.getState().error).toContain('permission denied')
  })

  it('batch deletes shared unmanaged Skills with owner agents', async () => {
    useSkillStoreV2.setState({
      selectedAgentDetail: {
        ...agentDetail,
        id: 'codex',
        displayName: 'Codex',
        iconKey: 'codex',
        inheritsSharedSkills: true,
        inheritedManagedSkills: [],
        inheritedUnmanagedSkills: [
          makeSharedUnmanaged('shared-writing'),
          makeSharedUnmanaged('shared-review'),
        ],
      },
      selectedAgentId: 'codex',
      agents: [makeSidebarAgent('codex', 'Codex')],
      unmanaged: [],
    })
    const deleteUnmanaged = vi.spyOn(skillApiV2, 'deleteUnmanagedAgentSkills').mockResolvedValue({ deleted: 2, failures: [] })
    vi.spyOn(skillApiV2, 'listUnmanaged').mockResolvedValue([])
    vi.spyOn(useSkillStoreV2.getState(), 'loadAgentDetail').mockResolvedValue(undefined)
    vi.spyOn(useSkillStoreV2.getState(), 'loadOverview').mockResolvedValue(undefined)
    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Skills (3)' }))
    fireEvent.click(screen.getByRole('button', { name: '共享继承 2' }))
    fireEvent.click(screen.getByRole('button', { name: '未管理 2' }))
    fireEvent.click(screen.getByRole('button', { name: '批量管理' }))
    fireEvent.click(screen.getByRole('button', { name: '选择当前可接管' }))
    fireEvent.click(screen.getByRole('button', { name: '批量删除 2 个' }))

    const dialog = screen.getByRole('dialog', { name: '永久删除共享的未管理 Skill？' })
    fireEvent.click(within(dialog).getByRole('button', { name: '从共享目录删除' }))

    await waitFor(() => expect(deleteUnmanaged).toHaveBeenCalledWith('agents', ['raw-shared-writing', 'raw-shared-review']))
  })

  it('batch adopts shared unmanaged Skills through the standard flow with owner agents', async () => {
    useSkillStoreV2.setState({
      selectedAgentDetail: {
        ...agentDetail,
        id: 'codex',
        displayName: 'Codex',
        iconKey: 'codex',
        inheritsSharedSkills: true,
        inheritedManagedSkills: [],
        inheritedUnmanagedSkills: [
          makeSharedUnmanaged('shared-writing'),
          makeSharedUnmanaged('shared-review'),
        ],
      },
      selectedAgentId: 'codex',
      agents: [makeSidebarAgent('codex', 'Codex')],
      unmanaged: [],
    })
    const execute = vi.spyOn(skillApiV2, 'executeAdoptBatch').mockResolvedValue({
      items: [
        { unmanagedId: 'raw-shared-writing', skillId: 'shared-writing', error: null },
        { unmanagedId: 'raw-shared-review', skillId: 'shared-review', error: null },
      ],
      finalizationError: null,
    })
    vi.spyOn(skillApiV2, 'listUnmanaged').mockResolvedValue([])
    vi.spyOn(useSkillStoreV2.getState(), 'loadAgentDetail').mockResolvedValue(undefined)
    vi.spyOn(useSkillStoreV2.getState(), 'loadOverview').mockResolvedValue(undefined)
    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Skills (3)' }))
    fireEvent.click(screen.getByRole('button', { name: '共享继承 2' }))
    fireEvent.click(screen.getByRole('button', { name: '未管理 2' }))
    fireEvent.click(screen.getByRole('button', { name: '批量管理' }))
    fireEvent.click(screen.getByRole('button', { name: '选择当前可接管' }))
    fireEvent.click(screen.getByRole('button', { name: '接管到中心库' }))
    fireEvent.click(screen.getByRole('button', { name: '确认接管' }))

    await waitFor(() => expect(execute).toHaveBeenCalledWith([
      {
        agentId: 'agents',
        unmanagedId: 'raw-shared-writing',
        option: 'import_cleanup',
        renamedId: null,
      },
      {
        agentId: 'agents',
        unmanagedId: 'raw-shared-review',
        option: 'import_cleanup',
        renamedId: null,
      },
    ]))
  })

  it('switches unmanaged skills into a peer tab and batch adopts them like agent sync', async () => {
    const execute = vi.spyOn(skillApiV2, 'executeAdoptBatch').mockResolvedValue({
      items: [{ unmanagedId: 'unmanaged-1', skillId: 'manual-skill', error: null }],
      finalizationError: null,
    })
    const listUnmanaged = vi.spyOn(skillApiV2, 'listUnmanaged').mockResolvedValue([])
    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)
    fireEvent.click(screen.getByText('Skills (2)'))
    fireEvent.click(screen.getByRole('button', { name: '未管理 1' }))

    expect(screen.queryByLabelText('选择 manual-skill')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '批量管理' })).toBeInTheDocument()
    expect(screen.queryByText('选择当前可接管')).not.toBeInTheDocument()
    expect(screen.queryByText('已管理 Skills')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '批量管理' }))
    fireEvent.click(screen.getByText('选择当前可接管'))
    fireEvent.click(screen.getByRole('button', { name: '接管到中心库' }))

    expect(screen.getByRole('heading', { name: '批量接管 1 个 Skill' })).toBeInTheDocument()
    expect(screen.getByText('批量接管适用范围')).toBeInTheDocument()
    expect(screen.getByText(/需要你决定保留中心版本、覆盖中心库或重命名/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '确认接管' }))

    await waitFor(() => {
      expect(execute).toHaveBeenCalledWith([{
        agentId: 'claude-code',
        unmanagedId: 'unmanaged-1',
        option: 'import_keep',
        renamedId: null,
      }])
    })
    expect(listUnmanaged).toHaveBeenCalled()
  })

  it('takes over every same-name center skill in one action and preserves local-only skills', async () => {
    const sameNameSkills = [
      {
        id: 'unmanaged-same',
        agentId: 'claude-code',
        itemType: 'skill' as const,
        path: '/c/skills/same-skill',
        inferredSkillId: 'same-skill',
        hash: 'same-hash',
        reason: 'same_name_as_center_skill',
      },
      {
        id: 'unmanaged-conflict',
        agentId: 'claude-code',
        itemType: 'skill' as const,
        path: '/c/skills/conflict-skill',
        inferredSkillId: 'conflict-skill',
        hash: 'agent-hash',
        reason: 'same_name_as_center_skill',
      },
    ]
    const localOnly = {
      id: 'unmanaged-local',
      agentId: 'claude-code',
      itemType: 'skill' as const,
      path: '/c/skills/local-only',
      inferredSkillId: 'local-only',
      hash: 'local-hash',
      reason: 'not_in_center_library',
    }
    useSkillStoreV2.setState({ unmanaged: [...sameNameSkills, localOnly] })
    const takeover = vi.spyOn(skillApiV2, 'takeoverCenterSkills').mockResolvedValue({
      items: sameNameSkills.map((item) => ({
        unmanagedId: item.id,
        skillId: item.inferredSkillId,
        error: null,
      })),
      finalizationError: null,
    })
    vi.spyOn(skillApiV2, 'listUnmanaged').mockResolvedValue([localOnly])
    const loadAgentDetail = vi.spyOn(useSkillStoreV2.getState(), 'loadAgentDetail').mockResolvedValue(undefined)
    const loadOverview = vi.spyOn(useSkillStoreV2.getState(), 'loadOverview').mockResolvedValue(undefined)
    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)
    fireEvent.click(screen.getByText('Skills (4)'))
    fireEvent.click(screen.getByRole('button', { name: '未管理 3' }))

    expect(screen.getAllByText('中心库已有同名 Skill').length).toBeGreaterThan(0)
    expect(screen.queryByText('same_name_as_center_skill')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '一键接管 2 个' }))

    expect(screen.getByRole('heading', { name: '接管中心库已有的 2 个 Skill？' })).toBeInTheDocument()
    expect(screen.getByText(/替换为指向中心库的软连接/)).toBeInTheDocument()
    expect(screen.getByText('其余 1 个未管理 Skill 不在中心库中，将保持不变。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '以中心库为准接管' }))

    await waitFor(() => {
      expect(takeover).toHaveBeenCalledWith('claude-code', [
        'unmanaged-same',
        'unmanaged-conflict',
      ])
    })
    expect(loadAgentDetail).toHaveBeenCalledWith('claude-code', true)
    expect(loadOverview).toHaveBeenCalledWith(true)
    expect(await screen.findByText('一键接管完成：已接管 2 个，失败 0 个；其他未管理 Skill 保持不变。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '批量管理' })).toBeInTheDocument()
  })

  it('explains which batch adoption conflicts require individual review', async () => {
    const conflicts = [
      {
        id: 'unmanaged-ant-skill-creator',
        agentId: 'claude-code',
        itemType: 'skill' as const,
        path: '/c/skills/ant-skill-creator',
        inferredSkillId: 'ant-skill-creator',
        hash: 'different-ant-hash',
        reason: 'same_name_as_center_skill',
      },
      {
        id: 'unmanaged-dws',
        agentId: 'claude-code',
        itemType: 'skill' as const,
        path: '/c/skills/dws',
        inferredSkillId: 'dws',
        hash: 'different-dws-hash',
        reason: 'same_name_as_center_skill',
      },
    ]
    useSkillStoreV2.setState({ unmanaged: conflicts })
    const unavailable = new Error(
      "Adopt option 'import_keep' is not allowed for 'conflict'. Re-run preview and choose one of the suggested actions.",
    )
    const execute = vi.spyOn(skillApiV2, 'executeAdoptBatch').mockResolvedValue({
      items: conflicts.map((item) => ({
        unmanagedId: item.id,
        skillId: null,
        error: unavailable.message,
      })),
      finalizationError: null,
    })
    vi.spyOn(skillApiV2, 'listUnmanaged').mockResolvedValue(conflicts)
    vi.spyOn(useSkillStoreV2.getState(), 'loadAgentDetail').mockResolvedValue(undefined)
    vi.spyOn(useSkillStoreV2.getState(), 'loadOverview').mockResolvedValue(undefined)
    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)
    fireEvent.click(screen.getByText('Skills (3)'))
    fireEvent.click(screen.getByRole('button', { name: '未管理 2' }))
    fireEvent.click(screen.getByRole('button', { name: '批量管理' }))
    fireEvent.click(screen.getByText('选择当前可接管'))
    fireEvent.click(screen.getByRole('button', { name: '接管到中心库' }))

    expect(screen.getByText('批量接管适用范围')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '确认接管' }))

    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/以下 2 个 Skill 需要单独确认，批量接管已跳过：ant-skill-creator、dws/)).toBeInTheDocument()
    expect(screen.getByText(/分别点击对应卡片上的「接管」/)).toBeInTheDocument()
    expect(screen.getByText('批量接管完成：已接管 0 个，需单独确认 2 个，失败 0 个')).toBeInTheDocument()
    expect(screen.queryByText(/当前选择的接管方式已不可用/)).not.toBeInTheDocument()
  })

  it('localizes managed mode, direct claim, and unmanaged reason labels on the agent page', async () => {
    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)
    fireEvent.click(screen.getByText('Skills (2)'))

    expect(screen.getByText('软连接')).toBeInTheDocument()
    expect(screen.getAllByText('直接生效').length).toBeGreaterThan(0)
    expect(screen.getByText('正常')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '未管理 1' }))
    expect(screen.getByText('未在中心库')).toBeInTheDocument()
    expect(screen.queryByText('link')).not.toBeInTheDocument()
    expect(screen.queryByText('direct')).not.toBeInTheDocument()
    expect(screen.queryByText('ok')).not.toBeInTheDocument()
    expect(screen.queryByText('独立安装')).not.toBeInTheDocument()
    expect(screen.queryByText('not_in_center_library')).not.toBeInTheDocument()
  })

  it('localizes distribution preview mode labels', async () => {
    vi.spyOn(skillApiV2, 'previewDistribute').mockResolvedValueOnce({
      skillIds: ['release-checklist'],
      targetAgents: ['claude-code'],
      requestedMode: 'link',
      changes: [
        {
          skillId: 'release-checklist',
          agentId: 'claude-code',
          action: 'create',
          actualMode: 'link',
          targetPath: '/c/skills/release-checklist',
        },
      ],
      blockers: [],
      blockerDecisions: [],
    })
    const { DistributeDialog } = await import('../components/skills-v2/DistributeDialog')
    render(
      <DistributeDialog
        skill={makeSkill({ installedAgents: [] })}
        agents={[
          { id: 'claude-code', displayName: 'Claude Code', iconKey: 'claude-code', enabled: true, skillsDir: '/c', version: null, latestVersion: null, installed: true, managedSkillCount: 0, unmanagedSkillCount: 0 } as AgentSummary,
        ]}
        defaultMode="link"
        onClose={() => {}}
        onDone={() => {}}
      />,
    )

    expect(screen.getByText('推荐')).toBeInTheDocument()
    expect(screen.getByText('修改同步生效')).toBeInTheDocument()
    expect(screen.queryByText('中心库更新后自动生效')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Claude Code'))
    fireEvent.click(screen.getByText('预览影响'))

    expect(await screen.findAllByText('软连接')).toHaveLength(2)
    expect(screen.queryByText('link')).not.toBeInTheDocument()
  })

  it('allows hook-installed agents to be selected even when the skill is already distributed', async () => {
    const previewDistribute = vi.spyOn(skillApiV2, 'previewDistribute').mockResolvedValueOnce({
      skillIds: ['release-checklist'],
      targetAgents: ['codex'],
      requestedMode: 'link',
      changes: [
        {
          skillId: 'release-checklist',
          agentId: 'codex',
          action: 'reinstall',
          actualMode: 'link',
          targetPath: '/codex/release-checklist',
          reason: 'Already managed - will refresh target from the center library.',
        },
      ],
      blockers: [],
      blockerDecisions: [],
    })
    const { DistributeDialog } = await import('../components/skills-v2/DistributeDialog')
    render(
      <DistributeDialog
        skill={makeSkill({
          installedAgents: [
            { agentId: 'codex', displayName: 'Codex', iconKey: 'codex', mode: 'link', status: 'ok' },
          ],
        })}
        agents={[
          { id: 'claude-code', displayName: 'Claude Code', iconKey: 'claude-code', enabled: true, skillsDir: '/c', version: null, latestVersion: null, installed: true, managedSkillCount: 0, unmanagedSkillCount: 0 } as AgentSummary,
          { id: 'codex', displayName: 'Codex', iconKey: 'codex', enabled: true, skillsDir: '/codex', version: null, latestVersion: null, installed: true, managedSkillCount: 0, unmanagedSkillCount: 0 } as AgentSummary,
          { id: 'gemini-cli', displayName: 'Gemini CLI', iconKey: 'gemini-cli', enabled: true, skillsDir: null, version: null, latestVersion: null, installed: false, managedSkillCount: 0, unmanagedSkillCount: 0 } as AgentSummary,
        ]}
        defaultMode="link"
        onClose={() => {}}
        onDone={() => {}}
      />,
    )

    expect(screen.getByText('Claude Code')).toBeInTheDocument()
    expect(screen.getByText('Codex')).toBeInTheDocument()
    expect(screen.queryByText('Gemini CLI')).not.toBeInTheDocument()
    expect(screen.getByText('0/2')).toBeInTheDocument()
    expect(screen.getByText('2 个可选')).toBeInTheDocument()
    expect(screen.getByText('已安装 · 将重新软连接')).toBeInTheDocument()
    expect(Array.from(document.body.querySelectorAll('.sm2-distribute__agent strong')).map((node) => node.textContent)).toEqual([
      'Codex',
      'Claude Code',
    ])

    const codexRow = screen.getByText('Codex').closest('label')
    expect(codexRow?.querySelector('input')).not.toBeDisabled()

    fireEvent.click(screen.getByText('Codex'))
    fireEvent.click(screen.getByText('预览影响'))

    await waitFor(() => {
      expect(previewDistribute).toHaveBeenCalledWith(['release-checklist'], ['codex'], 'link')
    })
  })

  it('localizes distribution change reasons in the confirmation preview', async () => {
    vi.spyOn(skillApiV2, 'previewDistribute').mockResolvedValueOnce({
      skillIds: ['release-checklist'],
      targetAgents: ['codex'],
      requestedMode: 'copy',
      changes: [
        {
          skillId: 'release-checklist',
          agentId: 'codex',
          action: 'convert',
          actualMode: 'copy',
          targetPath: '/codex/release-checklist',
          reason: 'Already managed as link — will convert to copy.',
        },
      ],
      blockers: [],
      blockerDecisions: [],
    })
    const { DistributeDialog } = await import('../components/skills-v2/DistributeDialog')
    render(
      <DistributeDialog
        skill={makeSkill({
          installedAgents: [
            { agentId: 'codex', displayName: 'Codex', iconKey: 'codex', mode: 'link', status: 'ok' },
          ],
        })}
        agents={[
          { id: 'codex', displayName: 'Codex', iconKey: 'codex', enabled: true, skillsDir: '/codex', version: null, latestVersion: null, installed: true, managedSkillCount: 0, unmanagedSkillCount: 0 } as AgentSummary,
        ]}
        defaultMode="copy"
        onClose={() => {}}
        onDone={() => {}}
      />,
    )

    fireEvent.click(screen.getByText('Codex'))
    fireEvent.click(screen.getByText('预览影响'))

    expect(await screen.findByText('已通过软连接管理，将转换为复制。')).toBeInTheDocument()
    expect(screen.queryByText('Already managed as link — will convert to copy.')).not.toBeInTheDocument()
  })

  it('shows busy feedback while executing the final distribution action', async () => {
    const distributionPreview: DistributionPreview = {
      skillIds: ['release-checklist'],
      targetAgents: ['codex'],
      requestedMode: 'link',
      changes: [
        {
          skillId: 'release-checklist',
          agentId: 'codex',
          action: 'reinstall',
          actualMode: 'link',
          targetPath: '/codex/release-checklist',
          reason: 'Already managed - will refresh target from the center library.',
        },
      ],
      blockers: [],
      blockerDecisions: [],
    }
    vi.spyOn(skillApiV2, 'previewDistribute').mockResolvedValueOnce(distributionPreview)
    let resolveExecute: (preview: DistributionPreview) => void = () => {}
    const executePromise = new Promise<typeof distributionPreview>((resolve) => {
      resolveExecute = resolve
    })
    const execute = vi.spyOn(skillApiV2, 'executeDistribute').mockReturnValue(executePromise)
    const { DistributeDialog } = await import('../components/skills-v2/DistributeDialog')
    render(
      <DistributeDialog
        skill={makeSkill({
          installedAgents: [
            { agentId: 'codex', displayName: 'Codex', iconKey: 'codex', mode: 'link', status: 'ok' },
          ],
        })}
        agents={[
          { id: 'codex', displayName: 'Codex', iconKey: 'codex', enabled: true, skillsDir: '/codex', version: null, latestVersion: null, installed: true, managedSkillCount: 0, unmanagedSkillCount: 0 } as AgentSummary,
        ]}
        defaultMode="link"
        onClose={() => {}}
        onDone={() => {}}
      />,
    )

    fireEvent.click(screen.getByText('Codex'))
    fireEvent.click(screen.getByText('预览影响'))
    fireEvent.click(await screen.findByRole('button', { name: '执行生效' }))

    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
    const busyButton = screen.getByRole('button', { name: '处理中…' })
    expect(busyButton).toBeDisabled()
    expect(busyButton).toHaveAttribute('aria-busy', 'true')
    expect(busyButton).toHaveAttribute('data-busy', 'true')
    expect(busyButton.querySelector('.sm2__spinner')).not.toBeNull()
    expect(screen.getByText('正在让 1 个目标生效')).toBeInTheDocument()
    const progress = screen.getByRole('progressbar', { name: '生效进度' })
    expect(progress).toHaveAttribute('aria-valuemin', '0')
    expect(progress).toHaveAttribute('aria-valuemax', '100')
    expect(progress).toHaveAttribute('aria-valuenow')

    resolveExecute(distributionPreview)
  })

  it('does not offer the shared .agents directory as a distribution target', async () => {
    const { DistributeDialog } = await import('../components/skills-v2/DistributeDialog')
    render(
      <DistributeDialog
        skill={makeSkill({ installedAgents: [] })}
        agents={[
          { id: 'agents', displayName: '.agents', iconKey: 'agents', enabled: true, skillsDir: '/Users/me/.agents/skills', version: null, latestVersion: null, installed: true, managedSkillCount: 0, unmanagedSkillCount: 0 } as AgentSummary,
          { id: 'claude-code', displayName: 'Claude Code', iconKey: 'claude-code', enabled: true, skillsDir: '/c', version: null, latestVersion: null, installed: true, managedSkillCount: 0, unmanagedSkillCount: 0 } as AgentSummary,
        ]}
        defaultMode="link"
        onClose={() => {}}
        onDone={() => {}}
      />,
    )

    expect(screen.queryByText('.agents')).not.toBeInTheDocument()
    expect(screen.getByText('Claude Code')).toBeInTheDocument()
    expect(screen.getByText('1 个可选')).toBeInTheDocument()
  })

  it('marks changed copy targets before redistributing them', async () => {
    const { DistributeDialog } = await import('../components/skills-v2/DistributeDialog')
    render(
      <DistributeDialog
        skill={makeSkill({
          installedAgents: [
            { agentId: 'codex', displayName: 'Codex', iconKey: 'codex', mode: 'copy', status: 'copy_modified' },
          ],
        })}
        agents={[
          { id: 'codex', displayName: 'Codex', iconKey: 'codex', enabled: true, skillsDir: '/codex', version: null, latestVersion: null, installed: true, managedSkillCount: 0, unmanagedSkillCount: 0 } as AgentSummary,
        ]}
        defaultMode="copy"
        onClose={() => {}}
        onDone={() => {}}
      />,
    )

    expect(screen.getByText('已安装 · 副本已修改 · 将重新复制')).toBeInTheDocument()
    expect(screen.getByText('1 个可选')).toBeInTheDocument()
    expect(screen.getByText('Codex').closest('label')?.querySelector('input')).not.toBeDisabled()
  })

  it('allows selecting fully installed agents when switching distribution mode', async () => {
    const previewDistribute = vi.spyOn(skillApiV2, 'previewDistribute').mockResolvedValueOnce({
      skillIds: ['release-checklist', 'db-debug'],
      targetAgents: ['codex'],
      requestedMode: 'link',
      changes: [
        {
          skillId: 'release-checklist',
          agentId: 'codex',
          action: 'convert',
          actualMode: 'link',
          targetPath: '/codex/release-checklist',
        },
      ],
      blockers: [],
      blockerDecisions: [],
    })
    const { DistributeDialog } = await import('../components/skills-v2/DistributeDialog')
    render(
      <DistributeDialog
        skills={[
          makeSkill({
            id: 'release-checklist',
            name: 'Release Checklist',
            installedAgents: [
              { agentId: 'codex', displayName: 'Codex', iconKey: 'codex', mode: 'copy', status: 'ok' },
            ],
          }),
          makeSkill({
            id: 'db-debug',
            name: 'Database Debugging',
            installedAgents: [
              { agentId: 'codex', displayName: 'Codex', iconKey: 'codex', mode: 'copy', status: 'ok' },
            ],
          }),
        ]}
        agents={[
          { id: 'codex', displayName: 'Codex', iconKey: 'codex', enabled: true, skillsDir: '/codex', version: null, latestVersion: null, installed: true, managedSkillCount: 0, unmanagedSkillCount: 0 } as AgentSummary,
        ]}
        defaultMode="link"
        onClose={() => {}}
        onDone={() => {}}
      />,
    )

    expect(screen.getByText('1 个可选')).toBeInTheDocument()
    const codexRow = screen.getByText('Codex').closest('label')
    expect(codexRow?.querySelector('input')).not.toBeDisabled()

    fireEvent.click(screen.getByText('Codex'))
    fireEvent.click(screen.getByText('预览影响'))

    await waitFor(() => {
      expect(previewDistribute).toHaveBeenCalledWith(['release-checklist', 'db-debug'], ['codex'], 'link')
    })
  })

  it('localizes distribution blocker reasons', async () => {
    vi.spyOn(skillApiV2, 'previewDistribute').mockResolvedValueOnce({
      skillIds: ['find-skills'],
      targetAgents: ['claude-code'],
      requestedMode: 'link',
      changes: [],
      blockers: [
        {
          skillId: 'find-skills',
          agentId: 'claude-code',
          reason: "An unmanaged 'find-skills' already exists at the target path. Adopt/overwrite/rename it first.",
          existingPath: '/c/skills/find-skills',
          existingPathKind: 'symlink',
          resolvedExistingPath: '/Users/mac/.skills-manager/skills/find-skills',
        },
      ],
      blockerDecisions: [],
    })
    vi.spyOn(skillApiV2, 'executeDistribute').mockRejectedValueOnce(
      "Target path '/Users/mac/.codex/skills/find-skills' must be a direct child of /Users/mac/.codex/skills.",
    )
    const openPath = vi.spyOn(skillApiV2, 'openPath').mockResolvedValue(undefined)
    const { DistributeDialog } = await import('../components/skills-v2/DistributeDialog')
    render(
      <DistributeDialog
        skill={{ ...makeSkill({ installedAgents: [] }), id: 'find-skills', name: 'find-skills' }}
        agents={[
          { id: 'claude-code', displayName: 'Claude Code', iconKey: 'claude-code', enabled: true, skillsDir: '/c', version: null, latestVersion: null, installed: true, managedSkillCount: 0, unmanagedSkillCount: 0 } as AgentSummary,
        ]}
        defaultMode="link"
        onClose={() => {}}
        onDone={() => {}}
      />,
    )

    fireEvent.click(screen.getByText('Claude Code'))
    fireEvent.click(screen.getByText('预览影响'))

    expect(await screen.findByText('目标路径已存在未管理的 Skill「find-skills」。请选择覆盖安装或忽略此目标。')).toBeInTheDocument()
    expect(screen.queryByText(/An unmanaged/)).not.toBeInTheDocument()
    expect(screen.getAllByText('软连接').length).toBeGreaterThan(1)
    expect(screen.getByText(/真实路径/)).toBeInTheDocument()
    expect(screen.getByText('/Users/mac/.skills-manager/skills/find-skills')).toBeInTheDocument()
    fireEvent.click(screen.getByText('打开文件夹'))
    expect(openPath).toHaveBeenCalledWith('/c/skills/find-skills')

    fireEvent.click(screen.getByText('覆盖安装'))
    fireEvent.click(screen.getByText('按选择执行'))
    expect(await screen.findByText("目标路径 '/Users/mac/.codex/skills/find-skills' 必须直接位于 /Users/mac/.codex/skills 下。")).toBeInTheDocument()
    expect(screen.queryByText(/must be a direct child/)).not.toBeInTheDocument()
  })

  it('shows localized skill target mode labels and explains resolved target paths', async () => {
    vi.spyOn(skillApiV2, 'getSkillDetail').mockResolvedValueOnce({
      ...makeSkill(),
      frontmatter: {},
      files: null,
      targets: agentDetail.skills.map((target) => ({
        ...target,
        resolvedTargetPath: '/center/skills/release-checklist',
      })),
      source: null,
    })
    const openPath = vi.spyOn(skillApiV2, 'openPath').mockResolvedValue(undefined)
    const { SkillDetailSlider } = await import('../components/skills-v2/SkillDetailSlider')
    render(<SkillDetailSlider skillId="release-checklist" open={true} onClose={() => {}} />)

    fireEvent.click(await screen.findByText('Agent (1)'))
    expect(await screen.findByText(/软连接 · 正常/)).toBeInTheDocument()
    expect(screen.getByText('直接生效')).toBeInTheDocument()
    expect(screen.getByText(/打开将跳转到真实路径/)).toBeInTheDocument()
    expect(screen.getByText('/center/skills/release-checklist')).toBeInTheDocument()
    fireEvent.click(screen.getByText('打开'))
    expect(openPath).toHaveBeenCalledWith('/c/skills/release-checklist')
  })

  it('shows a rescan action inside the empty unmanaged skills section', async () => {
    useSkillStoreV2.setState({ unmanaged: [] })
    const scan = vi.spyOn(skillApiV2, 'scanAgentInventory').mockResolvedValue({ agentId: 'claude-code', managed: 1, unmanaged: 0 })
    vi.spyOn(skillApiV2, 'listUnmanaged').mockResolvedValue([])
    vi.spyOn(skillApiV2, 'overview').mockResolvedValue(makeOverview())
    vi.spyOn(skillApiV2, 'getAgentDetail').mockResolvedValue(agentDetail)

    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    const { container } = render(<AgentManagementPage />)
    fireEvent.click(screen.getByText('Skills (1)'))
    fireEvent.click(screen.getByRole('button', { name: '未管理 0' }))

    const empty = container.querySelector('.sm2__unmanaged-empty')
    expect(empty).not.toBeNull()
    const button = empty?.querySelector('button')
    expect(button).toHaveTextContent('重新扫描此 Agent')

    fireEvent.click(button!)
    await waitFor(() => expect(scan).toHaveBeenCalledWith('claude-code'))
  })

  it('shows immediate busy feedback while preparing to adopt an unmanaged skill', async () => {
    let resolvePreview: (preview: AdoptPreview) => void = () => {}
    const previewPromise = new Promise<AdoptPreview>((resolve) => {
      resolvePreview = resolve
    })
    const preview = vi.spyOn(skillApiV2, 'previewAdopt').mockReturnValue(previewPromise)

    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)
    fireEvent.click(screen.getByText('Skills (2)'))
    fireEvent.click(screen.getByRole('button', { name: '未管理 1' }))

    fireEvent.click(screen.getByRole('button', { name: '接管' }))

    await waitFor(() => expect(preview).toHaveBeenCalledWith('claude-code', 'unmanaged-1'))
    const busyButton = screen.getByRole('button', { name: '准备接管' })
    expect(busyButton).toBeDisabled()
    expect(busyButton).toHaveAttribute('aria-busy', 'true')

    resolvePreview({
      agentId: 'claude-code',
      unmanagedId: 'unmanaged-1',
      skillPath: '/c/skills/manual-skill',
      inferredSkillId: 'manual-skill',
      hash: 'manual-hash',
      centerHasSameId: false,
      canQuickAdopt: true,
      options: [
        { value: 'import_keep', label: 'Import to center, keep agent file as-is', destructive: false },
      ],
    })
  })

  it('hides unmanaged skills when the setting is disabled', async () => {
    const hiddenOverview = makeOverview()
    hiddenOverview.settings.showUnmanaged = false
    useSkillStoreV2.setState({
      settings: hiddenOverview.settings,
      unmanaged: [
        {
          id: 'unmanaged-hidden',
          agentId: 'claude-code',
          itemType: 'skill',
          path: '/c/skills/hidden-skill',
          inferredSkillId: 'hidden-skill',
          hash: null,
          reason: 'not_in_center_library',
        },
      ],
    })
    vi.spyOn(skillApiV2, 'overview').mockResolvedValue(hiddenOverview)

    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)

    fireEvent.click(screen.getByText('Skills (1)'))
    expect(screen.queryByText('未管理 Skills')).not.toBeInTheDocument()
    expect(screen.queryByText('hidden-skill')).not.toBeInTheDocument()
  })






  it('keeps an agent uninstalled when program metadata is missing', async () => {
    const cursorDetail: AgentDetail = {
      ...agentDetail,
      id: 'cursor',
      displayName: 'Cursor',
      iconKey: 'cursor',
      version: null,
      latestVersion: null,
      skillsDir: '/cursor',
      skills: [],
    }
    useSkillStoreV2.setState({
      selectedAgentId: 'cursor',
      selectedAgentDetail: cursorDetail,
      agents: [
        { id: 'cursor', displayName: 'Cursor', iconKey: 'cursor', enabled: true, skillsDir: '/cursor', version: null, latestVersion: null, installed: false, managedSkillCount: 0, unmanagedSkillCount: 0 } as AgentSummary,
      ],
      unmanaged: [],
    })
    vi.spyOn(agentApi, 'list').mockResolvedValue([])
    vi.spyOn(skillApiV2, 'overview').mockResolvedValue(makeOverview())
    vi.spyOn(skillApiV2, 'getAgentDetail').mockResolvedValue(cursorDetail)

    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    const { container } = render(<AgentManagementPage />)

    // 没有程序信息时仍按本机真实状态显示「未检测到」，不伪装成已安装。
    expect(await screen.findByTitle('Cursor · 未检测到')).toBeInTheDocument()
    // 版本与安装 / 更新入口已从 Agent 视图移除。
    expect(container.querySelector('.sm2__agent-version-pill')).toBeNull()
    expect(container.querySelector('.sm2__agent-hero .sm2__btn--primary')).toBeNull()
  })

  it('rescans Agent installation state when refreshing the overview', async () => {
    vi.spyOn(agentApi, 'list').mockResolvedValue([makeProgram()])
    const refresh = vi.spyOn(useSkillStoreV2.getState(), 'refresh').mockResolvedValue(undefined)

    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)

    fireEvent.click(await screen.findByRole('button', { name: '刷新总览' }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it('uninstalls a supported agent from the page header after confirmation', async () => {
    useSkillStoreV2.setState({ unmanaged: [] })
    vi.spyOn(agentApi, 'list').mockResolvedValue([makeProgram()])
    const uninstall = vi.spyOn(agentApi, 'uninstall').mockResolvedValue(undefined)
    vi.spyOn(skillApiV2, 'listUnmanaged').mockResolvedValue([])
    vi.spyOn(skillApiV2, 'overview').mockResolvedValue(makeOverview())
    vi.spyOn(skillApiV2, 'getAgentDetail').mockResolvedValue(agentDetail)

    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)

    fireEvent.click(await screen.findByRole('button', { name: '卸载 Agent' }))
    expect(screen.getByRole('dialog', { name: '卸载 Agent「Claude Code」' })).toBeInTheDocument()
    expect(screen.getByText('npm uninstall -g @anthropic-ai/claude-code')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '确认卸载' }))

    await waitFor(() => expect(uninstall).toHaveBeenCalledWith('claude-code'))
    expect(await screen.findByText('Agent「Claude Code」已卸载，已清理 1 个 Skills')).toBeInTheDocument()
  })

  it('removes an uninstalled Agent from the installed sidebar and selects the next one', async () => {
    const codexDetail: AgentDetail = {
      ...agentDetail,
      id: 'codex',
      displayName: 'Codex',
      iconKey: 'codex',
      skillsDir: '/Users/me/.codex/skills',
      skills: [],
    }
    useSkillStoreV2.setState({
      activeTab: 'agents',
      selectedAgentId: 'claude-code',
      selectedAgentDetail: agentDetail,
      agents: [
        makeSidebarAgent('claude-code', 'Claude Code', { managed: 1 }),
        makeSidebarAgent('codex', 'Codex'),
      ],
      unmanaged: [],
    })
    vi.spyOn(agentApi, 'list').mockResolvedValue([makeProgram()])
    vi.spyOn(agentApi, 'uninstall').mockResolvedValue(undefined)
    vi.spyOn(skillApiV2, 'deleteSkillTargetDistributions').mockResolvedValue({ deleted: 1, failures: [] })
    vi.spyOn(skillApiV2, 'listUnmanaged').mockResolvedValue([])
    vi.spyOn(skillApiV2, 'getAgentDetail').mockImplementation(async (agentId) => (
      agentId === 'codex' ? codexDetail : agentDetail
    ))
    vi.spyOn(useSkillStoreV2.getState(), 'loadOverview').mockResolvedValue(undefined)

    const { SettingsSidebar } = await import('../components/settings/SettingsSidebar')
    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    const { container } = render(
      <>
        <SettingsSidebar
          activeSection="skill-manager-v2"
          collapsed={false}
          onCollapsedChange={() => {}}
          onSelect={() => {}}
        />
        <AgentManagementPage />
      </>,
    )

    expect(container.querySelector('[data-agent-id="claude-code"]')).not.toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: '卸载 Agent' }))
    fireEvent.click(screen.getByRole('button', { name: '确认卸载' }))

    await waitFor(() => {
      expect(container.querySelector('[data-agent-id="claude-code"]')).toBeNull()
      expect(container.querySelector('[data-agent-id="codex"]')).not.toBeNull()
      expect(useSkillStoreV2.getState().selectedAgentId).toBe('codex')
    })
  })

  it('offers safe Trash removal for a standalone macOS agent app', async () => {
    const kiroDetail: AgentDetail = {
      ...agentDetail,
      id: 'kiro',
      displayName: 'Kiro',
      iconKey: 'kiro',
      skillsDir: '/Users/me/.kiro/skills',
      skills: [],
    }
    useSkillStoreV2.setState({
      selectedAgentId: 'kiro',
      selectedAgentDetail: kiroDetail,
      agents: [
        { id: 'kiro', displayName: 'Kiro', iconKey: 'kiro', enabled: true, skillsDir: '/Users/me/.kiro/skills', version: null, latestVersion: null, installed: true, managedSkillCount: 0, unmanagedSkillCount: 0 } as AgentSummary,
      ],
      unmanaged: [],
    })
    vi.spyOn(agentApi, 'list').mockResolvedValue([
      makeProgram({
        id: 'kiro',
        displayName: 'Kiro',
        icon: 'kiro',
        kind: 'app',
        packageManager: 'app',
        packageName: null,
        binaryPath: '/Applications/Kiro.app/Contents/MacOS/Kiro',
        appPath: '/Applications/Kiro.app',
        uninstallCommand: 'Move application to Trash',
      }),
    ])

    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)

    fireEvent.click(await screen.findByRole('button', { name: '卸载 Agent' }))
    expect(screen.getByRole('dialog', { name: '卸载 Agent「Kiro」' })).toHaveTextContent('程序移到废纸篓')
    expect(screen.getByText('移到废纸篓：/Applications/Kiro.app')).toBeInTheDocument()
  })

  it('offers the official npm uninstall command for GitHub Copilot CLI', async () => {
    const copilotDetail: AgentDetail = {
      ...agentDetail,
      id: 'copilot',
      displayName: 'Copilot',
      iconKey: 'copilot',
      skillsDir: '/Users/me/.copilot/skills',
      skills: [],
    }
    useSkillStoreV2.setState({
      selectedAgentId: 'copilot',
      selectedAgentDetail: copilotDetail,
      agents: [makeSidebarAgent('copilot', 'Copilot')],
      unmanaged: [],
    })
    vi.spyOn(agentApi, 'list').mockResolvedValue([
      makeProgram({
        id: 'copilot',
        displayName: 'GitHub Copilot',
        icon: 'copilot',
        packageName: '@github/copilot',
        binaryPath: '/opt/homebrew/bin/copilot',
        configDir: '/Users/me/.copilot',
        downloadUrl: 'https://docs.github.com/copilot/how-tos/set-up/install-copilot-cli',
        installCommand: 'npm install -g @github/copilot',
        updateCommand: 'npm install -g @github/copilot@latest',
        uninstallCommand: 'npm uninstall -g @github/copilot',
        skillsDir: '/Users/me/.copilot/skills',
      }),
    ])

    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)

    fireEvent.click(await screen.findByRole('button', { name: '卸载 Agent' }))
    expect(screen.getByRole('dialog', { name: '卸载 Agent「Copilot」' })).toBeInTheDocument()
    expect(screen.getByText('npm uninstall -g @github/copilot')).toBeInTheDocument()
  })

  it('does not offer uninstall for Aider when only its config directory remains', async () => {
    const aiderDetail: AgentDetail = {
      ...agentDetail,
      id: 'aider',
      displayName: 'Aider',
      iconKey: 'aider',
      skillsDir: '/Users/me/.aider/skills',
      skills: [],
    }
    useSkillStoreV2.setState({
      selectedAgentId: 'aider',
      selectedAgentDetail: aiderDetail,
      agents: [
        { id: 'aider', displayName: 'Aider', iconKey: 'aider', enabled: true, skillsDir: '/Users/me/.aider/skills', version: null, latestVersion: null, installed: true, managedSkillCount: 0, unmanagedSkillCount: 0 } as AgentSummary,
      ],
      unmanaged: [],
    })
    vi.spyOn(agentApi, 'list').mockResolvedValue([
      makeProgram({
        id: 'aider',
        displayName: 'Aider',
        icon: 'aider',
        status: 'notInstalled',
        packageManager: 'uv',
        packageName: 'aider-chat',
        binaryPath: null,
        configDir: '/Users/me/.aider',
        installCommand: 'uv tool install --force --python python3.12 --with pip aider-chat@latest',
        updateCommand: 'uv tool install --force --python python3.12 --with pip aider-chat@latest',
        uninstallCommand: 'uv tool uninstall aider-chat',
      }),
    ])

    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)

    // 只发现配置的 Agent 默认收在「＋」后面，点开后才显示。
    await waitFor(() => expect(screen.queryByTitle('Aider · 仅发现配置')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /其他 Agent/ }))
    expect(screen.getByTitle('Aider · 仅发现配置')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '卸载 Agent' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '安装此 Agent' })).not.toBeInTheDocument()
  })

  it('cleans managed and unmanaged Skills when the Agent program is already absent', async () => {
    const unmanagedItem = {
      id: 'unmanaged-aider',
      agentId: 'aider',
      itemType: 'agent_skill' as const,
      path: '/Users/me/.aider/skills/local-only',
      inferredSkillId: 'local-only',
      hash: 'local-hash',
      reason: 'not_in_center_library',
    }
    const aiderDetail: AgentDetail = {
      ...agentDetail,
      id: 'aider',
      displayName: 'Aider',
      iconKey: 'aider',
      skillsDir: '/Users/me/.aider/skills',
      skills: agentDetail.skills.map((skill) => ({
        ...skill,
        id: 'target-aider',
        agentId: 'aider',
        targetPath: '/Users/me/.aider/skills/release-checklist',
      })),
    }
    useSkillStoreV2.setState({
      selectedAgentId: 'aider',
      selectedAgentDetail: aiderDetail,
      agents: [
        { id: 'aider', displayName: 'Aider', iconKey: 'aider', enabled: true, skillsDir: '/Users/me/.aider/skills', version: null, latestVersion: null, installed: true, managedSkillCount: 1, unmanagedSkillCount: 1 } as AgentSummary,
      ],
      unmanaged: [unmanagedItem],
    })
    const program = makeProgram({
      id: 'aider',
      displayName: 'Aider',
      icon: 'aider',
      status: 'notInstalled',
      packageManager: 'uv',
      packageName: 'aider-chat',
      binaryPath: null,
      configDir: '/Users/me/.aider',
      installCommand: 'uv tool install --force --python python3.12 --with pip aider-chat@latest',
      updateCommand: 'uv tool install --force --python python3.12 --with pip aider-chat@latest',
      uninstallCommand: 'uv tool uninstall aider-chat',
      hooksInstalled: true,
    })
    vi.spyOn(agentApi, 'list').mockResolvedValue([program])
    const uninstall = vi.spyOn(agentApi, 'uninstall').mockResolvedValue(undefined)
    const uninstallHook = vi.spyOn(agentApi, 'uninstallHook').mockResolvedValue(undefined)
    const deleteManaged = vi.spyOn(skillApiV2, 'deleteSkillTargetDistributions').mockResolvedValue({ deleted: 1, failures: [] })
    let unmanagedPresent = true
    const deleteUnmanaged = vi.spyOn(skillApiV2, 'deleteUnmanagedAgentSkill').mockImplementation(async () => {
      unmanagedPresent = false
    })
    vi.spyOn(skillApiV2, 'listUnmanaged').mockImplementation(async () => unmanagedPresent ? [unmanagedItem] : [])
    vi.spyOn(skillApiV2, 'overview').mockResolvedValue(makeOverview())
    vi.spyOn(skillApiV2, 'getAgentDetail').mockResolvedValue({ ...aiderDetail, skills: [] })

    const { AgentManagementPage } = await import('../components/skills-v2/AgentManagementPage')
    render(<AgentManagementPage />)

    fireEvent.click(await screen.findByRole('button', { name: '卸载 Agent' }))
    const dialog = screen.getByRole('dialog', { name: '卸载 Agent「Aider」' })
    expect(dialog).toHaveTextContent('未安装，仅清理残留')
    expect(dialog).toHaveTextContent('1已管理 Skills')
    expect(dialog).toHaveTextContent('1未管理 Skills')
    fireEvent.click(screen.getByRole('button', { name: '确认卸载' }))

    await waitFor(() => expect(deleteManaged).toHaveBeenCalledWith(['target-aider']))
    expect(deleteUnmanaged).toHaveBeenCalledWith('aider', 'unmanaged-aider')
    expect(uninstallHook).toHaveBeenCalledWith('aider')
    expect(uninstall).not.toHaveBeenCalled()
    expect(await screen.findByText('Agent「Aider」已卸载，已清理 2 个 Skills')).toBeInTheDocument()
  })
})

function makeProgram(overrides: Partial<AgentProgramInfo> = {}): AgentProgramInfo {
  return {
    id: 'claude-code',
    displayName: 'Claude Code',
    icon: 'claude-code',
    kind: 'cli',
    status: 'installed',
    packageManager: 'npm',
    packageName: '@anthropic-ai/claude-code',
    installedVersion: null,
    latestVersion: null,
    binaryPath: '/usr/local/bin/claude',
    configDir: '/Users/me/.claude',
    appPath: null,
    downloadUrl: 'https://docs.anthropic.com/en/docs/claude-code',
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    updateCommand: 'npm install -g @anthropic-ai/claude-code@latest',
    uninstallCommand: 'npm uninstall -g @anthropic-ai/claude-code',
    hooksInstalled: false,
    skillsDir: '/Users/me/.claude/skills',
    isCustom: false,
    ...overrides,
  }
}

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

describe('Skill manager settings page', () => {
  beforeEach(() => {
    cleanup()
    useSkillStoreV2.setState({
      settings: {
        centerPath: '/Users/mac/.agentbro/skills',
        sqlitePath: '/Users/mac/.agentbro/skill-manager/skill-manager.db',
        defaultDistributeMode: 'link',
        linkFailPolicy: 'ask',
        startupScan: true,
        showUnmanaged: true,
      },
      error: null,
    })
  })

  it('reveals the SQLite database in Finder and shows feedback', async () => {
    const revealPath = vi.spyOn(skillApiV2, 'revealPath').mockResolvedValue(undefined)
    const { SettingsPageV2 } = await import('../components/skills-v2/SettingsPageV2')

    render(<SettingsPageV2 />)
    fireEvent.click(screen.getByText('在 Finder 中显示 SQLite'))

    await waitFor(() => expect(revealPath).toHaveBeenCalledWith('/Users/mac/.agentbro/skill-manager/skill-manager.db'))
    expect(screen.getByText('已在 Finder 中定位 SQLite')).toBeInTheDocument()
  })

  it('does not expose a center library path editor', async () => {
    const { SettingsPageV2 } = await import('../components/skills-v2/SettingsPageV2')

    render(<SettingsPageV2 />)

    expect(screen.queryByText('中心库路径')).not.toBeInTheDocument()
    expect(screen.queryByText('默认 ~/.agentbro/skills。修改后下次刷新生效。')).not.toBeInTheDocument()
  })
})

describe('Skill issues inside the library', () => {
  beforeEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useSkillStoreV2.setState({
      issues: [],
      unmanaged: [],
      busyAction: null,
      error: null,
    })
  })

  it('shows a broken symlink as a hint on the Skill library page instead of a separate tab', async () => {
    const brokenLinkIssues = [
      {
        id: 'target-broken-target-9',
        issueType: 'broken_link',
        severity: 'warning' as const,
        fixKind: 'auto' as const,
        title: 'Broken symlink',
        detail: "Target '/Users/mac/.claude/skills/bird' link points at a missing skill.",
        entityType: 'target' as const,
        entityId: 'target-9',
        actions: [{ id: 'fix:broken_link', label: 'Clean broken link', destructive: false }],
      },
    ]
    vi.spyOn(skillApiV2, 'listDiagnosisIssues').mockResolvedValue(brokenLinkIssues)
    vi.spyOn(skillApiV2, 'listUnmanaged').mockResolvedValue([])
    vi.spyOn(skillApiV2, 'listProjects').mockResolvedValue([])
    useSkillStoreV2.setState({
      initialized: true,
      skills: [],
      overview: null,
      issues: brokenLinkIssues,
    })

    const { SkillLibraryPage } = await import('../components/skills-v2/SkillLibraryPage')
    render(<SkillLibraryPage />)

    expect(await screen.findByText('发现断开的 Skill 链接')).toBeInTheDocument()
    expect(screen.getByText(/指向的 Skill 已不存在/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '清理断开链接' })).toBeInTheDocument()
    // The old standalone tab is gone: issues are part of the library page.
    expect(screen.queryByText('诊断与修复')).not.toBeInTheDocument()
  })

  it('summarizes issue groups and safe-fix feedback on the library page', async () => {
    const initialIssues = [
      {
        id: 'snapshot-stale',
        issueType: 'snapshot_stale',
        severity: 'warning' as const,
        fixKind: 'auto' as const,
        title: 'JSON snapshot is out of date',
        detail: 'The center library changed since the snapshot was last written.',
        entityType: 'snapshot' as const,
        entityId: null,
        actions: [{ id: 'fix:snapshot_stale', label: 'Refresh snapshot', destructive: false }],
      },
      {
        id: 'agent-unmanaged-codex-bird',
        issueType: 'agent_unmanaged',
        severity: 'info' as const,
        fixKind: 'info' as const,
        title: 'Unmanaged skill in Codex',
        detail: '/Users/mac/.codex/skills/bird — reason: same_name_as_center_skill',
        entityType: 'target' as const,
        entityId: 'codex-bird',
        actions: [],
      },
      {
        id: 'copy-modified',
        issueType: 'copy_modified',
        severity: 'error' as const,
        fixKind: 'confirm' as const,
        title: 'Copy was modified locally',
        detail: "'/Users/mac/.codex/skills/release-checklist' differs from the center snapshot.",
        entityType: 'target' as const,
        entityId: 'target-1',
        actions: [{ id: 'fix:copy_modified', label: 'Push to center', destructive: true }],
      },
    ]
    const afterFixIssues = initialIssues.slice(1)
    const runDiagnosis = vi.spyOn(skillApiV2, 'runDiagnosis').mockResolvedValue(afterFixIssues)
    vi.spyOn(skillApiV2, 'listUnmanaged').mockResolvedValue([])
    vi.spyOn(skillApiV2, 'executeSafeFixes').mockResolvedValue(1)
    useSkillStoreV2.setState({ initialized: true, skills: [], overview: null, issues: initialIssues })

    const { SkillLibraryPage } = await import('../components/skills-v2/SkillLibraryPage')
    render(<SkillLibraryPage />)

    expect(await screen.findByText(/Skill 状态需要整理/)).toBeInTheDocument()
    expect(screen.getAllByText(/可以安全修复/).length).toBeGreaterThan(0)
    expect(screen.getByText('未接管的 Skill')).toBeInTheDocument()
    expect(screen.getByText(/本地已有同名 Skill/)).toBeInTheDocument()
    expect(screen.queryByText(/same_name_as_center_skill/)).not.toBeInTheDocument()
    expect(screen.getByText(/不会删除 Skill 内容/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '修复安全项' }))

    expect(await screen.findByText('已处理 1 项安全问题，还剩 2 项需要查看。')).toBeInTheDocument()
    expect(runDiagnosis).toHaveBeenCalledTimes(1)
  })
})
