import { beforeEach, describe, expect, it, vi, beforeAll } from 'vitest'
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

// Tests import these components lazily so the module mocks above apply. The
// first import transforms a large module graph; under a busy parallel run
// that alone can exceed the 5 s per-test timeout, and a timed-out import then
// renders into the next test. Warm the module cache once, outside any test.
beforeAll(async () => {
  await Promise.all([
    import('../components/skills-v2/AgentRoster'),
  ])
}, 60_000)

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

  it('labels each Agent in the left list with its detection status and keeps undetected ones behind +', async () => {
    vi.spyOn(agentApi, 'list').mockResolvedValue([
      program('claude-code', 'Claude Code', 'installed'),
      program('codex', 'Codex', 'notInstalled'),
      program('gemini', 'Gemini CLI', 'unavailable'),
      program('kiro', 'Kiro', 'unavailable'),
    ])
    vi.spyOn(skillApiV2, 'getAgentDetail').mockResolvedValue(detail('claude-code', 'Claude Code'))
    // 真实数据里列表的「程序已安装」与程序检测出自同一次检测，这里保持一致。
    useSkillStoreV2.setState({
      agents: useSkillStoreV2.getState().agents.map((agent) => ({ ...agent, programInstalled: agent.id === 'claude-code' })),
    })

    const { container } = render(<AgentManagementPage />)
    const statusOf = (name: string) => Array.from(container.querySelectorAll('.sm2__rail .sm2-sidebar__subitem-label'))
      .find((label) => label.firstChild?.textContent === name)
      ?.querySelector('.sm2-sidebar__subitem-status')?.textContent

    // 程序检测到已安装的 Agent 默认显示，并如实标注「已安装」。
    await waitFor(() => expect(statusOf('Claude Code')).toBe('已安装'))
    // 只找到配置、或没检测到程序的 Agent 默认收在「其他 Agent」后面。
    expect(statusOf('Codex')).toBeUndefined()

    fireEvent.click(screen.getByRole('button', { name: /其他 Agent/ }))

    // 只找到配置不能说成已安装；没检测到程序的照实写。
    await waitFor(() => expect(statusOf('Codex')).toBe('仅发现配置'))
    expect(statusOf('Kiro')).toBe('仅发现配置')
    expect(statusOf('Cursor')).toBe('未检测到')
    expect(statusOf('Gemini CLI')).toBe('不可用')
    // 检测总览卡片已删除，Agent 只在左侧列表里选。
    expect(container.querySelector('.sm2-agent-inventory')).toBeNull()
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

    const { AgentRoster } = await import('../components/skills-v2/AgentRoster')
    render(<AgentRoster />)

    expect(screen.getByText('Claude Code')).toBeInTheDocument()
    expect(screen.queryByText('Kiro')).not.toBeInTheDocument()
    expect(screen.queryByText('Cursor')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /其他 Agent/ }))

    expect(screen.getByText('Kiro')).toBeInTheDocument()
    expect(screen.getByText('Cursor')).toBeInTheDocument()
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
