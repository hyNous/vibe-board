import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AgentManagementPage } from '../components/skills-v2/AgentManagementPage'
import { agentApi, type AgentProgramInfo } from '../services/agentApi'
import type { AgentDetail, AgentSummary, SkillManagerOverview } from '../services/skillApiV2'
import { skillApiV2 } from '../services/skillApiV2'
import { useSkillStoreV2 } from '../stores/skillStoreV2'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn().mockResolvedValue(null) }))
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn().mockResolvedValue(undefined) }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'zh' },
  }),
}))

function summary(id: string, displayName: string, installed: boolean): AgentSummary {
  return {
    id,
    displayName,
    iconKey: id,
    enabled: installed,
    skillsDir: installed ? `/home/user/.${id}/skills` : null,
    version: null,
    latestVersion: null,
    installed,
    managedSkillCount: 0,
    unmanagedSkillCount: 0,
  }
}

function program(id: string, displayName: string, status: AgentProgramInfo['status']): AgentProgramInfo {
  return {
    id,
    displayName,
    icon: id,
    kind: 'cli',
    status,
    packageManager: null,
    packageName: null,
    installedVersion: status === 'installed' ? '1.2.3' : null,
    latestVersion: null,
    binaryPath: null,
    configDir: null,
    appPath: null,
    downloadUrl: null,
    installCommand: status === 'notInstalled' ? `install ${id}` : null,
    updateCommand: null,
    uninstallCommand: null,
    hooksInstalled: false,
    skillsDir: null,
    isCustom: false,
  }
}

function detail(id: string, displayName: string): AgentDetail {
  return {
    id,
    displayName,
    iconKey: id,
    version: null,
    latestVersion: null,
    skillsDir: null,
    configPath: null,
    agentDir: null,
    skills: [],
    inheritsSharedSkills: false,
    inheritedManagedSkills: [],
    inheritedUnmanagedSkills: [],
    appliedPacks: [],
    availablePacks: [],
    health: [],
  }
}

const overview: SkillManagerOverview = {
  metrics: { centerSkillCount: 0, targetCount: 0, unmanagedCount: 0, issueCount: 0 },
  skills: [],
  packs: [],
  issues: [],
  settings: {
    centerPath: '~/.agents/skills',
    sqlitePath: '~/.vibe/skills.db',
    defaultDistributeMode: 'link',
    linkFailPolicy: 'ask',
    startupScan: false,
    showUnmanaged: true,
  },
  agents: [],
}

describe('Agent management inventory', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    useSkillStoreV2.setState({
      runtimeEnvironmentId: 'local',
      initialized: true,
      loading: false,
      error: null,
      overview,
      skills: [],
      agents: [
        summary('claude-code', 'Claude Code', false),
        summary('codex', 'Codex', true),
        summary('gemini', 'Gemini CLI', false),
        summary('cursor', 'Cursor', false),
        summary('kiro', 'Kiro', true),
      ],
      selectedAgentId: 'claude-code',
      selectedAgentDetail: detail('claude-code', 'Claude Code'),
      unmanaged: [],
      lastOverviewLoadedAt: Date.now(),
    })
  })

  it('merges program detection with the skill inventory without faking installed program state', async () => {
    vi.spyOn(agentApi, 'refresh').mockResolvedValue([
      program('claude-code', 'Claude Code', 'installed'),
      program('codex', 'Codex', 'notInstalled'),
      program('gemini', 'Gemini CLI', 'unavailable'),
      program('kiro', 'Kiro', 'unavailable'),
    ])
    const loadAgentDetail = vi.spyOn(skillApiV2, 'getAgentDetail').mockResolvedValue(detail('claude-code', 'Claude Code'))

    render(<AgentManagementPage />)

    // Claude Code 没有本机 skills 目录，但程序检测到已安装；不能再被漏显示为未安装。
    expect(await screen.findByTitle('Claude Code · 已安装')).toBeInTheDocument()
    // Codex 程序明确未安装，技能库存命中只说明发现了配置，不能覆盖成程序已安装。
    expect(screen.getByTitle('Codex · 仅发现配置')).toBeInTheDocument()
    // 程序明确不可用且没有库存命中时保持真实不可用状态。
    expect(screen.getByTitle('Gemini CLI · 不可用')).toBeInTheDocument()
    // 程序不可用但有库存命中时同样只展示仅发现配置。
    expect(screen.getByTitle('Kiro · 仅发现配置')).toBeInTheDocument()
    // 完全没有检测信号时保持未检测到，不伪装成在线或已安装。
    expect(screen.getByTitle('Cursor · 未检测到')).toBeInTheDocument()
    expect(screen.getByText('程序已安装 1 / 5 · 仅发现配置 2')).toBeInTheDocument()
    expect(loadAgentDetail).not.toHaveBeenCalled()
    // 程序已安装但尚无 skills 目录时，详情仍可发起本机扫描。
    expect(screen.getByRole('button', { name: '重新扫描此 Agent' })).toBeEnabled()
  })

  it('explains the page purpose without claiming online support', async () => {
    vi.spyOn(agentApi, 'refresh').mockResolvedValue([])

    render(<AgentManagementPage />)

    expect(await screen.findByText(/本机真实检测结果/)).toBeInTheDocument()
    expect(screen.getByText(/不是在线状态/)).toBeInTheDocument()
    // 程序信息缺失时，库存命中只能展示为仅发现配置；其余 Agent 保持未检测到。
    expect(screen.getByTitle('Codex · 仅发现配置')).toBeInTheDocument()
    expect(screen.getByTitle('Claude Code · 未检测到')).toBeInTheDocument()
    expect(screen.getByText('程序已安装 0 / 5 · 仅发现配置 2')).toBeInTheDocument()
  })

  it('keeps config-only details honest while still allowing a local rescan', async () => {
    useSkillStoreV2.setState({
      selectedAgentId: 'codex',
      selectedAgentDetail: detail('codex', 'Codex'),
    })
    vi.spyOn(agentApi, 'refresh').mockResolvedValue([
      program('codex', 'Codex', 'notInstalled'),
    ])

    render(<AgentManagementPage />)

    expect(await screen.findByText('当前版本 未安装')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '安装此 Agent' })).toBeEnabled()
    // 程序未安装，但本机发现了配置/Skills，扫描操作仍然可用。
    expect(screen.getByRole('button', { name: '重新扫描此 Agent' })).toBeEnabled()
    expect(screen.getByTitle('Codex · 仅发现配置').querySelector('.sm2-agent-inventory__status')).toHaveClass('sm2-agent-inventory__status--config-only')
  })
})
