import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    health: [],
  }
}

const overview: SkillManagerOverview = {
  metrics: { centerSkillCount: 0, targetCount: 0, unmanagedCount: 0, issueCount: 0 },
  skills: [],
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

  it('defaults to Agents whose program was detected and hides the rest behind +', async () => {
    vi.spyOn(agentApi, 'list').mockResolvedValue([
      program('claude-code', 'Claude Code', 'installed'),
      program('codex', 'Codex', 'notInstalled'),
      program('gemini', 'Gemini CLI', 'unavailable'),
      program('kiro', 'Kiro', 'unavailable'),
    ])
    vi.spyOn(skillApiV2, 'getAgentDetail').mockResolvedValue(detail('claude-code', 'Claude Code'))

    render(<AgentManagementPage />)

    // 程序检测到已安装：即使没有本机 skills 目录也默认显示。
    expect(await screen.findByTitle('Claude Code · 已安装')).toBeInTheDocument()
    expect(screen.getByText('程序已安装 1 / 5 · 仅发现配置 2')).toBeInTheDocument()

    // 仅发现配置（Codex / Kiro）与未检测到程序（Cursor / Gemini）默认收起。
    await waitFor(() => expect(screen.queryByTitle('Codex · 仅发现配置')).not.toBeInTheDocument())
    expect(screen.queryByTitle('Kiro · 仅发现配置')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Cursor · 未检测到')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Gemini CLI · 不可用')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /其他 Agent/ }))

    expect(await screen.findByTitle('Codex · 仅发现配置')).toBeInTheDocument()
    expect(screen.getByTitle('Kiro · 仅发现配置')).toBeInTheDocument()
    expect(screen.getByTitle('Cursor · 未检测到')).toBeInTheDocument()
    expect(screen.getByTitle('Gemini CLI · 不可用')).toBeInTheDocument()
  })

  it('lists only program-detected Agents in the skill sidebar and reveals the rest from +', async () => {
    useSkillStoreV2.setState({
      activeTab: 'agents',
      agents: [
        { ...summary('claude-code', 'Claude Code', true), programInstalled: true },
        { ...summary('kiro', 'Kiro', true), programInstalled: false },
        { ...summary('cursor', 'Cursor', false), programInstalled: false },
      ],
    })

    const { SettingsSidebar } = await import('../components/settings/SettingsSidebar')
    render(
      <SettingsSidebar
        activeSection="skill-manager-v2"
        collapsed={false}
        onCollapsedChange={() => {}}
        onSelect={() => {}}
      />,
    )

    expect(screen.getByText('Claude Code')).toBeInTheDocument()
    expect(screen.queryByText('Kiro')).not.toBeInTheDocument()
    expect(screen.queryByText('Cursor')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /其他 Agent/ }))

    expect(screen.getByText('Kiro')).toBeInTheDocument()
    expect(screen.getByText('Cursor')).toBeInTheDocument()
  })

  it('explains the page purpose without claiming online support', async () => {
    vi.spyOn(agentApi, 'list').mockResolvedValue([])

    render(<AgentManagementPage />)

    expect(await screen.findByText(/检测到可执行程序/)).toBeInTheDocument()
    expect(screen.getByText(/不是在线状态/)).toBeInTheDocument()
    // 程序信息缺失时不过滤，避免把已安装的 Agent 误藏起来。
    expect(screen.getByTitle('Codex · 仅发现配置')).toBeInTheDocument()
    expect(screen.getByTitle('Claude Code · 未检测到')).toBeInTheDocument()
    expect(screen.getByText('程序已安装 0 / 5 · 仅发现配置 2')).toBeInTheDocument()
  })

  it('keeps config-only details honest while still allowing a local rescan', async () => {
    useSkillStoreV2.setState({
      selectedAgentId: 'codex',
      selectedAgentDetail: detail('codex', 'Codex'),
    })
    vi.spyOn(agentApi, 'list').mockResolvedValue([
      program('codex', 'Codex', 'notInstalled'),
    ])

    render(<AgentManagementPage />)

    // 只发现配置的 Agent 仍可扫描本机 Skills/配置。
    expect(await screen.findByRole('button', { name: '重新扫描此 Agent' })).toBeEnabled()
    // 版本、Hook 与配置视图不再出现在 Agent 视图里。
    expect(screen.queryByText(/当前版本/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Hooks' })).not.toBeInTheDocument()
    expect(screen.queryByText('路径与设置')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Skills \(/ })).toBeInTheDocument()
  })
})
