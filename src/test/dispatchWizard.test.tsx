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
  install: vi.fn(),
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

function connection(
  workerId: string,
  displayName: string,
  skillId: string,
  overrides: Partial<DispatchConnection> = {},
): DispatchConnection {
  return {
    workerId,
    displayName,
    skillId,
    dir: `/home/tester/.claude/skills/${skillId}`,
    sharedWith: [],
    ...overrides,
  }
}

function agentNode(overrides: Partial<DispatchAgentNode> = {}): DispatchAgentNode {
  return {
    agentId: 'claude-code',
    displayName: 'Claude Code',
    verified: true,
    readDirs: [{ path: '/home/tester/.claude/skills', shared: false }],
    connections: [],
    addableWorkers: ['opencode', 'antigravity'],
    ...overrides,
  }
}

function tree(overrides: Partial<DispatchTree> = {}): DispatchTree {
  return {
    node: { available: true, programPath: '/usr/local/bin/node', version: 'v20.11.0' },
    toolInstalled: true,
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
      agentNode({
        agentId: 'codex',
        displayName: 'Codex',
        readDirs: [
          { path: '/home/tester/.agents/skills', shared: true },
          { path: '/home/tester/.codex/skills', shared: false },
        ],
      }),
      agentNode({
        agentId: 'gemini',
        displayName: 'Gemini CLI',
        verified: false,
        readDirs: [{ path: '/home/tester/.gemini/skills', shared: false }],
      }),
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
    sourcePath: `/home/tester/.agents/skills/${skillId}/${relativePath}`,
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
      {
        skillId: 'opencode-agent',
        targetPath: '/home/tester/.claude/skills/opencode-agent',
        action: 'remove',
        sharedWith: [],
      },
      {
        skillId: 'external-agent-core',
        targetPath: '/home/tester/.claude/skills/external-agent-core',
        action: 'remove',
        sharedWith: [],
      },
    ],
    kept: [],
    affectedAgents: [],
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
    dispatchMocks.install.mockResolvedValue({ toolInstalled: true, sourceRecorded: true })
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

  it('cancelling the GitHub install writes nothing', async () => {
    dispatchMocks.tree.mockResolvedValue(tree({ toolInstalled: false, workers: [] }))
    await renderSection()

    fireEvent.click(await screen.findByTestId('dispatch-install-start'))
    fireEvent.click(screen.getByTestId('dispatch-install-cancel'))

    expect(screen.queryByTestId('dispatch-install-confirm')).not.toBeInTheDocument()
    expect(dispatchMocks.install).not.toHaveBeenCalled()
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
        sharedWith: [],
      }],
      kept: [{
        skillId: 'external-agent-core',
        targetPath: '/home/tester/.claude/skills/external-agent-core',
        action: 'keep_modified',
        sharedWith: [],
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
})
