import { fireEvent, render, screen, within, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, beforeAll } from 'vitest'
import type {
  DispatchAgentNode,
  DispatchConnectPlan,
  DispatchConnectResult,
  DispatchConnection,
  DispatchDisconnectPlan,
  DispatchDisconnectResult,
  DispatchPlanFile,
  DispatchTree,
  DispatchWorkerStatus,
} from '../services/dispatchApi'

const dispatchMocks = vi.hoisted(() => ({
  tree: vi.fn(),
  connectPlan: vi.fn(),
  connectApply: vi.fn(),
  disconnectPlan: vi.fn(),
  disconnectApply: vi.fn(),
}))

vi.mock('../services/dispatchApi', () => ({
  dispatchApi: dispatchMocks,
}))

vi.mock('react-i18next', async () => {
  const zh = (await import('../i18n/locales/zh.json')).default as Record<string, unknown>
  const translate = (key: string, options?: Record<string, unknown>) => {
    const value = key
      .split('.')
      .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], zh)
    const template = typeof value === 'string' ? value : String(options?.defaultValue ?? key)
    return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? ''))
  }
  return {
    useTranslation: () => ({ t: translate, i18n: { language: 'zh' } }),
  }
})

function worker(overrides: Partial<DispatchWorkerStatus> = {}): DispatchWorkerStatus {
  return {
    id: 'opencode',
    displayName: 'OpenCode',
    detected: true,
    programPath: '/home/tester/.opencode/bin/opencode',
    version: '1.2.3',
    credentialFilePresent: true,
    ...overrides,
  }
}

function connection(workerId: string, displayName: string, skillId: string): DispatchConnection {
  return { workerId, displayName, skillId }
}

function agentNode(overrides: Partial<DispatchAgentNode> = {}): DispatchAgentNode {
  return {
    agentId: 'claude-code',
    displayName: 'Claude Code',
    verified: true,
    skillsDir: '/home/tester/.claude/skills',
    connections: [],
    addableWorkers: ['opencode', 'antigravity'],
    ...overrides,
  }
}

function tree(overrides: Partial<DispatchTree> = {}): DispatchTree {
  return {
    node: { available: true, programPath: '/usr/local/bin/node', version: 'v20.11.0' },
    skillsReady: true,
    workers: [
      worker(),
      worker({
        id: 'antigravity',
        displayName: 'Antigravity',
        programPath: '/home/tester/.agy/bin/agy',
        version: '3.4.5',
        credentialFilePresent: null,
      }),
    ],
    agents: [
      agentNode(),
      agentNode({ agentId: 'codex', displayName: 'Codex', skillsDir: '/home/tester/.codex/skills' }),
      agentNode({ agentId: 'gemini', displayName: 'Gemini CLI', verified: false, skillsDir: '/home/tester/.gemini/skills' }),
    ],
    ...overrides,
  }
}

function planFile(
  skillId: string,
  relativePath: string,
  change: DispatchPlanFile['change'] = 'create',
): DispatchPlanFile {
  return {
    skillId,
    relativePath,
    sourcePath: `/resources/dispatch-skills/${skillId}/${relativePath}`,
    targetPath: `/home/tester/.claude/skills/${skillId}/${relativePath}`,
    change,
  }
}

function connectPlan(overrides: Partial<DispatchConnectPlan> = {}): DispatchConnectPlan {
  return {
    agentId: 'claude-code',
    agentDisplayName: 'Claude Code',
    workerId: 'opencode',
    workerDisplayName: 'OpenCode',
    files: [
      planFile('external-agent-core', 'SKILL.md'),
      planFile('external-agent-setup', 'SKILL.md', 'unchanged'),
      planFile('opencode-agent', 'SKILL.md', 'overwrite'),
    ],
    blockers: [],
    canApply: true,
    ...overrides,
  }
}

function disconnectPlan(overrides: Partial<DispatchDisconnectPlan> = {}): DispatchDisconnectPlan {
  return {
    agentId: 'claude-code',
    agentDisplayName: 'Claude Code',
    workerId: 'opencode',
    workerDisplayName: 'OpenCode',
    removals: [
      { skillId: 'opencode-agent', targetPath: '/home/tester/.claude/skills/opencode-agent', action: 'remove' },
      { skillId: 'external-agent-core', targetPath: '/home/tester/.claude/skills/external-agent-core', action: 'remove' },
    ],
    kept: [],
    canApply: true,
    ...overrides,
  }
}

async function renderSection() {
  const { DispatchSection } = await import('../components/settings/sections/DispatchSection')
  return render(<DispatchSection />)
}

// Tests import these components lazily so the module mocks above apply. The
// first import transforms a large module graph; under a busy parallel run
// that alone can exceed the 5 s per-test timeout, and a timed-out import then
// renders into the next test. Warm the module cache once, outside any test.
beforeAll(async () => {
  await Promise.all([
    import('../components/settings/sections/DispatchSection'),
  ])
}, 60_000)

describe('dispatch relationship tree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dispatchMocks.tree.mockResolvedValue(tree())
    dispatchMocks.connectPlan.mockResolvedValue(connectPlan())
    dispatchMocks.connectApply.mockResolvedValue({ writtenFiles: connectPlan().files } as DispatchConnectResult)
    dispatchMocks.disconnectPlan.mockResolvedValue(disconnectPlan())
    dispatchMocks.disconnectApply.mockResolvedValue({
      removed: disconnectPlan().removals,
      kept: [],
    } as DispatchDisconnectResult)
  })

  afterEach(() => {
    cleanup()
  })

  it('shows every detected Agent, its connected workers and the unverified hint', async () => {
    dispatchMocks.tree.mockResolvedValue(tree({
      agents: [
        agentNode({
          connections: [connection('opencode', 'OpenCode', 'opencode-agent')],
          addableWorkers: ['antigravity'],
        }),
        agentNode({ agentId: 'codex', displayName: 'Codex', skillsDir: '/home/tester/.codex/skills' }),
        agentNode({ agentId: 'gemini', displayName: 'Gemini CLI', verified: false, skillsDir: '/home/tester/.gemini/skills' }),
      ],
    }))
    await renderSection()

    const claude = await screen.findByTestId('dispatch-agent-claude-code')
    const connected = within(claude).getByTestId('dispatch-connection-claude-code-opencode')
    expect(connected).toHaveTextContent('OpenCode')
    expect(within(connected).getByRole('button', { name: '断开' })).toBeInTheDocument()
    expect(within(claude).queryByText('Claude Code 还没有可以派活的工人。')).not.toBeInTheDocument()

    const codex = screen.getByTestId('dispatch-agent-codex')
    expect(within(codex).getByText('Codex 还没有可以派活的工人。')).toBeInTheDocument()

    expect(screen.queryByTestId('dispatch-unverified-claude-code')).not.toBeInTheDocument()
    expect(within(screen.getByTestId('dispatch-agent-gemini')).getByTestId('dispatch-unverified-gemini'))
      .toHaveTextContent('未验证')
    expect(within(screen.getByTestId('dispatch-agent-gemini')).getByTestId('dispatch-add-gemini'))
      .toBeEnabled()
  })

  it('offers only detected, unconnected workers and points other tools at external-agent-setup', async () => {
    const { container } = await renderSection()

    fireEvent.click(await screen.findByTestId('dispatch-add-codex'))

    const picker = screen.getByTestId('dispatch-picker-codex')
    expect(within(picker).getByTestId('dispatch-add-worker-codex-opencode')).toHaveTextContent('OpenCode')
    expect(within(picker).getByTestId('dispatch-add-worker-codex-antigravity')).toHaveTextContent('Antigravity')

    const otherTools = within(picker).getByTestId('dispatch-other-tools-codex')
    expect(otherTools).toHaveTextContent('其他工具')
    expect(otherTools).toHaveTextContent('$external-agent-setup')
    expect(container.querySelector('form')).toBeNull()
    expect(container.querySelectorAll('input, select, textarea')).toHaveLength(0)
  })

  it('confirms in plain language and writes only after confirmation', async () => {
    await renderSection()

    fireEvent.click(await screen.findByTestId('dispatch-add-claude-code'))
    fireEvent.click(screen.getByTestId('dispatch-add-worker-claude-code-opencode'))

    const confirm = await screen.findByTestId('dispatch-confirm-claude-code-opencode')
    expect(confirm).toHaveTextContent('让 Claude Code 可以把任务派给 OpenCode。')
    expect(dispatchMocks.connectApply).not.toHaveBeenCalled()

    const planned = connectPlan()
    expect(screen.queryByTestId('dispatch-files-claude-code-opencode-body')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('dispatch-files-claude-code-opencode'))
    const details = screen.getByTestId('dispatch-files-claude-code-opencode-body')
    expect(within(details).getByText('将写入以下文件（3 个）')).toBeInTheDocument()
    const previewed = within(details)
      .getAllByTestId('dispatch-file')
      .map((item) => item.querySelector('code')?.textContent)
    expect(previewed).toEqual(planned.files.map((file) => file.targetPath))
    expect(within(details).getAllByTestId('dispatch-file').map((item) => item.getAttribute('data-change')))
      .toEqual(['create', 'unchanged', 'overwrite'])

    fireEvent.click(screen.getByTestId('dispatch-confirm-apply'))

    expect(await screen.findByTestId('dispatch-notice')).toHaveTextContent(
      '已让 Claude Code 可以把任务派给 OpenCode。',
    )
    expect(dispatchMocks.connectApply).toHaveBeenCalledTimes(1)
    expect(dispatchMocks.connectApply).toHaveBeenCalledWith('claude-code', 'opencode', true)
    expect(dispatchMocks.tree).toHaveBeenCalledTimes(2)

    // The written files stay viewable afterwards through the details fold.
    expect(screen.queryByTestId('dispatch-applied-files-body')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('dispatch-applied-files'))
    const applied = within(screen.getByTestId('dispatch-applied-files-body'))
      .getAllByTestId('dispatch-applied-file')
      .map((item) => item.querySelector('code')?.textContent)
    expect(applied).toEqual(planned.files.map((file) => file.targetPath))
  })

  it('cancelling a connection writes nothing', async () => {
    await renderSection()

    fireEvent.click(await screen.findByTestId('dispatch-add-claude-code'))
    fireEvent.click(screen.getByTestId('dispatch-add-worker-claude-code-opencode'))
    await screen.findByTestId('dispatch-confirm-claude-code-opencode')

    fireEvent.click(screen.getByTestId('dispatch-confirm-cancel'))

    expect(screen.queryByTestId('dispatch-confirm-claude-code-opencode')).not.toBeInTheDocument()
    expect(dispatchMocks.connectApply).not.toHaveBeenCalled()
  })

  it('keeps paths, versions and file counts out of the default view', async () => {
    await renderSection()

    await screen.findByTestId('dispatch-agent-claude-code')
    expect(screen.queryByText('/home/tester/.claude/skills')).not.toBeInTheDocument()
    expect(screen.queryByText('/usr/local/bin/node')).not.toBeInTheDocument()
    expect(screen.queryByText('1.2.3')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('dispatch-agent-details-claude-code'))
    expect(within(screen.getByTestId('dispatch-agent-details-claude-code-body'))
      .getByText('/home/tester/.claude/skills')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('dispatch-detection-details'))
    const detection = screen.getByTestId('dispatch-detection-details-body')
    expect(within(detection).getByText('/usr/local/bin/node')).toBeInTheDocument()
    expect(within(detection).getByText('v20.11.0')).toBeInTheDocument()
    const opencode = within(detection).getByTestId('dispatch-worker-opencode')
    expect(within(opencode).getByText('1.2.3')).toBeInTheDocument()
    expect(within(opencode).getByText('/home/tester/.opencode/bin/opencode')).toBeInTheDocument()
    expect(within(opencode).getByText('存在（不读取内容）')).toBeInTheDocument()
  })

  it('blocks adding when Node.js is missing', async () => {
    dispatchMocks.tree.mockResolvedValue(tree({
      node: { available: false, programPath: null, version: null },
    }))
    await renderSection()

    expect(await screen.findByTestId('dispatch-node-missing')).toHaveTextContent(
      '没有找到 Node.js。派发功能需要 Node 运行，请先自行安装，然后重新打开这一页。',
    )
    expect(screen.getByTestId('dispatch-add-claude-code')).toBeDisabled()
    expect(dispatchMocks.connectApply).not.toHaveBeenCalled()
  })

  it('explains a missing bundled payload instead of offering workers', async () => {
    dispatchMocks.tree.mockResolvedValue(tree({ skillsReady: false }))
    await renderSection()

    expect(await screen.findByTestId('dispatch-skills-missing')).toBeInTheDocument()
    expect(screen.getByTestId('dispatch-add-claude-code')).toBeDisabled()
  })

  it('disconnects only after confirmation and reports what was kept', async () => {
    dispatchMocks.tree.mockResolvedValue(tree({
      agents: [agentNode({
        connections: [connection('opencode', 'OpenCode', 'opencode-agent')],
        addableWorkers: ['antigravity'],
      })],
    }))
    dispatchMocks.disconnectApply.mockResolvedValue({
      removed: [{
        skillId: 'opencode-agent',
        targetPath: '/home/tester/.claude/skills/opencode-agent',
        action: 'remove',
      }],
      kept: [{
        skillId: 'external-agent-core',
        targetPath: '/home/tester/.claude/skills/external-agent-core',
        action: 'keep_modified',
      }],
    } as DispatchDisconnectResult)
    await renderSection()

    fireEvent.click(await screen.findByTestId('dispatch-disconnect-claude-code-opencode'))

    const confirm = await screen.findByTestId('dispatch-disconnect-confirm-claude-code-opencode')
    expect(confirm).toHaveTextContent('断开后，Claude Code 就不能把任务派给 OpenCode 了。')
    expect(dispatchMocks.disconnectApply).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('dispatch-disconnect-apply'))

    const keptWarning = await screen.findByTestId('dispatch-kept-warning')
    expect(keptWarning).toHaveTextContent('已保留')
    expect(within(keptWarning).getByTestId('dispatch-kept-item'))
      .toHaveTextContent('/home/tester/.claude/skills/external-agent-core')
    expect(dispatchMocks.disconnectApply).toHaveBeenCalledWith('claude-code', 'opencode', true)
    expect(await screen.findByTestId('dispatch-notice')).toHaveTextContent(
      '已断开：Claude Code 不能再把任务派给 OpenCode。',
    )
  })

  it('warns before replacing a worker copy the user edited', async () => {
    dispatchMocks.connectPlan.mockResolvedValue(connectPlan({
      files: [
        planFile('external-agent-core', 'SKILL.md'),
        planFile('opencode-agent', 'SKILL.md', 'overwrite'),
      ],
    }))
    await renderSection()

    fireEvent.click(await screen.findByTestId('dispatch-add-claude-code'))
    fireEvent.click(screen.getByTestId('dispatch-add-worker-claude-code-opencode'))

    const warning = await screen.findByTestId('dispatch-overwrite-warning')
    expect(warning).toHaveTextContent('其中 1 个文件已存在且内容不同')
    expect(dispatchMocks.connectApply).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('dispatch-files-claude-code-opencode'))
    expect(screen.getByTestId('dispatch-files-claude-code-opencode-body')).toHaveTextContent('将覆盖')
  })

  it('shows no overwrite warning when nothing would be replaced', async () => {
    dispatchMocks.connectPlan.mockResolvedValue(connectPlan({
      files: [
        planFile('external-agent-core', 'SKILL.md'),
        planFile('external-agent-setup', 'SKILL.md', 'unchanged'),
        planFile('opencode-agent', 'SKILL.md'),
      ],
    }))
    await renderSection()

    fireEvent.click(await screen.findByTestId('dispatch-add-claude-code'))
    fireEvent.click(screen.getByTestId('dispatch-add-worker-claude-code-opencode'))

    await screen.findByTestId('dispatch-confirm-claude-code-opencode')
    expect(screen.queryByTestId('dispatch-overwrite-warning')).not.toBeInTheDocument()
  })

  it('says when no worker program is detected at all', async () => {
    dispatchMocks.tree.mockResolvedValue(tree({
      workers: [
        worker({ detected: false, programPath: null, version: null, credentialFilePresent: null }),
        worker({
          id: 'antigravity',
          displayName: 'Antigravity',
          detected: false,
          programPath: null,
          version: null,
          credentialFilePresent: null,
        }),
      ],
      agents: [agentNode({ addableWorkers: [] })],
    }))
    await renderSection()

    fireEvent.click(await screen.findByTestId('dispatch-add-claude-code'))

    expect(within(screen.getByTestId('dispatch-picker-claude-code')).getByText(
      '本机没有检测到 OpenCode 或 Antigravity。先安装其中之一，再回到这一页。',
    )).toBeInTheDocument()
  })

  it('keeps the dispatch-rules note and example in a fold at the bottom', async () => {
    await renderSection()

    await screen.findByTestId('dispatch-agent-claude-code')
    expect(screen.queryByTestId('dispatch-rules-desc')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('dispatch-rules-details'))

    const description = screen.getByTestId('dispatch-rules-desc')
    expect(description).toHaveTextContent('~/.claude/CLAUDE.md')
    expect(description).toHaveTextContent('也不代写派发规则')
    expect(screen.getByTestId('dispatch-rules-example')).toHaveTextContent('$opencode-agent')
    expect(screen.getByTestId('dispatch-copy-rules')).toBeInTheDocument()
  })
})
