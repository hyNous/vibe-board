import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { AdoptDialog } from '../components/skills-v2/AdoptDialog'
import i18n from '../i18n'
import { skillApiV2 } from '../services/skillApiV2'
import type { AdoptPreview } from '../services/skillApiV2'

const preview: AdoptPreview = {
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
  ],
}

describe('single Skill adoption', () => {
  beforeEach(async () => {
    cleanup()
    vi.restoreAllMocks()
    await i18n.changeLanguage('zh')
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('describes shared conflict choices as cleanup operations', () => {
    const sharedConflictPreview: AdoptPreview = {
      ...preview,
      agentId: 'agents',
      unmanagedId: 'shared-bird',
      skillPath: '/Users/me/.agents/skills/bird',
      centerHasSameId: true,
      canQuickAdopt: false,
      options: [
        { value: 'center_over_agent', label: 'Use center and remove shared source', destructive: true },
        { value: 'overwrite_center', label: 'Overwrite center and remove shared source', destructive: true },
        { value: 'rename', label: 'Rename and remove shared source', destructive: false },
      ],
    }

    render(
      <AdoptDialog
        preview={sharedConflictPreview}
        onClose={() => {}}
        onDone={() => {}}
      />,
    )

    expect(screen.getByLabelText('中心库为准')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('不会改动中心库；会删除 .agents/skills 中的同名共享 Skill 文件夹。')).toBeInTheDocument()
    expect(screen.getByText('会清理 .agents 共享副本')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('重命名导入'))

    expect(screen.getByText('不会覆盖中心库已有 Skill；会删除 .agents/skills 中的原共享 Skill 文件夹。')).toBeInTheDocument()
    expect(screen.getByText(/成功后清理 \.agents\/skills 中的原共享 Skill/)).toBeInTheDocument()
    expect(screen.queryByText(/原 Agent 文件会作为副本目标被管理/)).not.toBeInTheDocument()
  })

  it('keeps post-adoption refresh errors visible when close retries refresh', async () => {
    vi.spyOn(skillApiV2, 'executeAdopt').mockResolvedValue('bird')
    const onDone = vi.fn().mockRejectedValue(new Error('refresh still failed'))
    const onClose = vi.fn()

    render(
      <AdoptDialog
        preview={preview}
        onClose={onClose}
        onDone={onDone}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '确认接管' }))
    expect(await screen.findByText('refresh still failed')).toBeInTheDocument()

    await waitFor(() => expect(screen.getByRole('button', { name: '取消' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('refresh still failed')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })
})
