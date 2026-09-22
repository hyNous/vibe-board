import { fireEvent, render, screen, cleanup, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, beforeAll } from 'vitest'
import type {
  DispatchApplyResult,
  DispatchDetection,
  DispatchPlan,
  DispatchPlanFile,
} from '../services/dispatchApi'

const dispatchMocks = vi.hoisted(() => ({
  detect: vi.fn(),
  plan: vi.fn(),
  apply: vi.fn(),
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

const DISPATCH_SKILL_IDS = [
  'external-agent-core',
  'external-agent-setup',
  'opencode-agent',
  'antigravity-agent',
]

function planFile(
  agentId: string,
  skillId: string,
  relativePath: string,
  change: DispatchPlanFile['change'] = 'create',
): DispatchPlanFile {
  const agentDir = agentId === 'claude-code' ? '.claude' : '.codex'
  return {
    skillId,
    agentId,
    relativePath,
    sourcePath: `/resources/dispatch-skills/${skillId}/${relativePath}`,
    targetPath: `/home/tester/${agentDir}/skills/${skillId}/${relativePath}`,
    change,
  }
}

function detection(overrides: Partial<DispatchDetection> = {}): DispatchDetection {
  return {
    node: { available: true, programPath: '/usr/local/bin/node', version: 'v20.11.0' },
    workers: [
      {
        id: 'opencode',
        displayName: 'OpenCode',
        command: 'opencode',
        detected: true,
        programPath: '/home/tester/.opencode/bin/opencode',
        version: '1.2.3',
        credentialFilePresent: true,
      },
      {
        id: 'antigravity',
        displayName: 'Antigravity',
        command: 'agy',
        detected: false,
        programPath: null,
        version: null,
        credentialFilePresent: null,
      },
    ],
    targets: [
      {
        agentId: 'claude-code',
        displayName: 'Claude Code',
        programDetected: true,
        skillsDir: '/home/tester/.claude/skills',
        installedSkills: [],
      },
      {
        agentId: 'codex',
        displayName: 'Codex',
        programDetected: true,
        skillsDir: '/home/tester/.codex/skills',
        installedSkills: [],
      },
    ],
    skills: DISPATCH_SKILL_IDS.map((id) => ({ id, present: true, fileCount: 5 })),
    resourcesRoot: '/resources/dispatch-skills',
    ...overrides,
  }
}

function plan(overrides: Partial<DispatchPlan> = {}): DispatchPlan {
  const files = [
    planFile('claude-code', 'external-agent-core', 'SKILL.md'),
    planFile('claude-code', 'external-agent-core', 'scripts/run-agent.mjs'),
    planFile('codex', 'external-agent-core', 'SKILL.md'),
    planFile('codex', 'opencode-agent', 'SKILL.md'),
  ]
  return {
    detection: detection(),
    files,
    blockers: [],
    canApply: true,
    ...overrides,
  }
}

function applyResult(files: DispatchPlanFile[]): DispatchApplyResult {
  return { writtenFiles: files, targets: ['claude-code', 'codex'] }
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

describe('dispatch setup wizard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dispatchMocks.detect.mockResolvedValue(detection())
    dispatchMocks.plan.mockResolvedValue(plan())
    dispatchMocks.apply.mockResolvedValue(applyResult(plan().files))
  })

  afterEach(() => {
    cleanup()
  })

  it('shows worker paths, versions and credential-file presence without credential values', async () => {
    await renderSection()

    const opencode = await screen.findByTestId('dispatch-worker-opencode')
    expect(within(opencode).getByText('OpenCode')).toBeInTheDocument()
    expect(within(opencode).getByText('/home/tester/.opencode/bin/opencode')).toBeInTheDocument()
    expect(within(opencode).getByText('1.2.3')).toBeInTheDocument()
    expect(within(opencode).getByText('存在（不读取内容）')).toBeInTheDocument()

    const antigravity = screen.getByTestId('dispatch-worker-antigravity')
    expect(within(antigravity).getByText('未检测到')).toBeInTheDocument()
    expect(within(antigravity).getByText('不适用')).toBeInTheDocument()

    const node = screen.getByTestId('dispatch-node')
    expect(within(node).getByText('v20.11.0')).toBeInTheDocument()
    expect(within(node).getByText('/usr/local/bin/node')).toBeInTheDocument()

    const claude = screen.getByTestId('dispatch-target-claude-code')
    expect(within(claude).getByText('已检测到')).toBeInTheDocument()
    expect(within(claude).getByText('/home/tester/.claude/skills')).toBeInTheDocument()
    expect(within(claude).getByText('已安装 0/4')).toBeInTheDocument()
  })

  it('previews every planned path and writes only after confirmation', async () => {
    const planned = plan()
    dispatchMocks.plan.mockResolvedValue(planned)
    await renderSection()

    expect(dispatchMocks.apply).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByTestId('dispatch-preview'))

    const preview = await screen.findByTestId('dispatch-preview-files')
    const previewedPaths = within(preview)
      .getAllByTestId('dispatch-file')
      .map((item) => item.textContent)
    expect(previewedPaths).toEqual(planned.files.map((file) => file.targetPath))
    expect(within(preview).getByText('共 4 个文件')).toBeInTheDocument()
    expect(dispatchMocks.apply).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('dispatch-install'))

    expect(await screen.findByTestId('dispatch-installed')).toHaveTextContent('已写入 4 个文件。')
    expect(dispatchMocks.apply).toHaveBeenCalledTimes(1)
    expect(dispatchMocks.apply).toHaveBeenCalledWith(true)

    const writtenPaths = within(screen.getByTestId('dispatch-preview-files'))
      .getAllByTestId('dispatch-file')
      .map((item) => item.textContent)
    expect(writtenPaths).toEqual(previewedPaths)
  })

  it('warns before overwriting files that already exist with different content', async () => {
    dispatchMocks.plan.mockResolvedValue(plan({
      files: [
        planFile('claude-code', 'opencode-agent', 'SKILL.md', 'overwrite'),
        planFile('claude-code', 'external-agent-core', 'SKILL.md', 'unchanged'),
        planFile('codex', 'opencode-agent', 'SKILL.md'),
      ],
    }))
    await renderSection()
    fireEvent.click(await screen.findByTestId('dispatch-preview'))

    const warning = await screen.findByTestId('dispatch-overwrite-warning')
    expect(warning).toHaveTextContent('其中 1 个文件已存在且内容不同')
    const items = within(screen.getByTestId('dispatch-preview-files')).getAllByTestId('dispatch-file')
    expect(items.map((item) => item.getAttribute('data-change'))).toEqual(['overwrite', 'unchanged', 'create'])
    expect(items[0]).toHaveTextContent('将覆盖')
    expect(items[1]).toHaveTextContent('已是最新')
  })

  it('shows no overwrite warning when nothing would be replaced', async () => {
    await renderSection()
    fireEvent.click(await screen.findByTestId('dispatch-preview'))
    await screen.findByTestId('dispatch-preview-files')
    expect(screen.queryByTestId('dispatch-overwrite-warning')).not.toBeInTheDocument()
  })

  it('shows the Node.js hint and refuses to install when Node.js is missing', async () => {
    const noNode = detection({
      node: { available: false, programPath: null, version: null },
    })
    const blocked: DispatchPlan = {
      detection: noNode,
      files: [planFile('claude-code', 'external-agent-core', 'SKILL.md')],
      blockers: ['node_missing'],
      canApply: false,
    }
    dispatchMocks.detect.mockResolvedValue(noNode)
    dispatchMocks.plan.mockResolvedValue(blocked)

    await renderSection()

    expect(await screen.findByTestId('dispatch-node-missing')).toHaveTextContent(
      '未检测到 Node.js。派发 Skill 依赖 Node 运行；请先自行安装 Node.js，本向导不会自动安装。',
    )
    expect(screen.getByTestId('dispatch-install')).toBeDisabled()

    fireEvent.click(screen.getByTestId('dispatch-preview'))

    expect(await screen.findByTestId('dispatch-blockers')).toHaveTextContent(
      '未检测到 Node.js，向导不会安装任何文件。',
    )
    expect(screen.getByTestId('dispatch-install')).toBeDisabled()
    expect(dispatchMocks.apply).not.toHaveBeenCalled()
  })

  it('points unknown CLI tools at external-agent-setup without any form', async () => {
    const { container } = await renderSection()

    const hint = await screen.findByTestId('dispatch-unknown-tools')
    expect(hint).toHaveTextContent('external-agent-setup')
    expect(container.querySelector('form')).toBeNull()
    expect(container.querySelectorAll('input, select, textarea')).toHaveLength(0)
  })

  it('explains that dispatch rules belong in the user global instruction files', async () => {
    await renderSection()

    const description = await screen.findByTestId('dispatch-rules-desc')
    expect(description).toHaveTextContent('~/.claude/CLAUDE.md')
    expect(description).toHaveTextContent('~/.codex/AGENTS.md')
    expect(description).toHaveTextContent('也不代写派发规则')

    const example = screen.getByTestId('dispatch-rules-example')
    expect(example).toHaveTextContent('派发规则（示例）')
    expect(example).toHaveTextContent('$opencode-agent')
    expect(screen.getByTestId('dispatch-copy-rules')).toBeInTheDocument()
  })
})
