import { afterEach, describe, expect, it } from 'vitest'
import i18n from '../i18n'
import { distributionBlockerReason, skillErrorMessage } from '../components/skills-v2/skillLabels'

const unavailableAdoptError = new Error(
  "Adopt option 'import_keep' is not allowed for 'fsd-alipay-business-skill'. Re-run preview and choose one of the suggested actions.",
)
const unmanagedAgentMismatchError = new Error(
  "Unmanaged item 'unm-agents-Users-me--agents-skills-bird' does not belong to agent 'codex'.",
)
const unmanagedDistributionBlocker = {
  skillId: 'lark-approval',
  agentId: 'zcode',
  reason: "An unmanaged 'lark-approval' already exists at the target path. Adopt/overwrite/rename it first.",
  existingPath: '/Users/me/.zcode/skills/lark-approval',
}

describe('skill error labels', () => {
  afterEach(async () => {
    await i18n.changeLanguage('zh')
  })

  it.each([
    ['zh', '当前选择的接管方式已不可用。请重新打开接管预览，并从建议操作中选择。'],
    ['en', 'The selected adoption method is no longer available. Reopen the adoption preview and choose one of the suggested actions.'],
  ])('localizes unavailable adoption options in %s', async (language, expected) => {
    await i18n.changeLanguage(language)
    expect(skillErrorMessage(i18n.t, unavailableAdoptError)).toBe(expected)
  })

  it.each([
    ['zh', '该未管理 Skill 不属于 Agent「codex」，请重新扫描后重试。'],
    ['en', "This unmanaged Skill does not belong to Agent 'codex'. Rescan and try again."],
  ])('localizes unmanaged Agent mismatch errors in %s', async (language, expected) => {
    await i18n.changeLanguage(language)
    expect(skillErrorMessage(i18n.t, unmanagedAgentMismatchError)).toBe(expected)
  })

  it.each([
    ['zh', '目标路径已存在未管理的 Skill「lark-approval」。请选择覆盖安装或忽略此目标。'],
    ['en', 'An unmanaged Skill “lark-approval” already exists at the target path. Choose overwrite or skip for this target.'],
  ])('localizes unmanaged distribution blockers in %s', async (language, expected) => {
    await i18n.changeLanguage(language)
    expect(distributionBlockerReason(i18n.t, unmanagedDistributionBlocker)).toBe(expected)
  })
})
