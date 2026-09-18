import { shortcutDisplayParts } from '../../utils/keyboardShortcuts'
import { isApplePlatform } from '../../utils/platform'

export function formatShortcut(shortcut: string): string {
  const parts = shortcutDisplayParts(shortcut)
  return isApplePlatform() ? parts.join('') : parts.join('+')
}

export function buildTips(config: {
  globalShortcut: string
  shortcutApprove: string
  shortcutApproveEnabled: boolean
  shortcutDeny: string
  shortcutDenyEnabled: boolean
  shortcutSkip: string
  shortcutSkipEnabled: boolean
}): string[] {
  const tips = [
    `${formatShortcut(config.globalShortcut)} 切换灵动岛显示`,
    'ESC 收起当前展开面板',
    '悬停灵动岛查看会话详情',
    '点击设置图标可调整主题、声音和快捷键',
    '在 Agents 设置里安装或修复各 Agent hooks',
    '开启 Follow Focus 后只看当前窗口相关会话',
    '空闲提示可以在 Island 设置里关闭',
    '通知声音、静音时段和快捷键都可以单独配置',
    '开启用量展示后可在灵动岛查看 5h/7d 额度',
    'Webhook 可把完成、失败和审批事件同步到群里',
  ]

  if (config.shortcutApproveEnabled) {
    tips.push(`${formatShortcut(config.shortcutApprove)} 批准当前权限请求`)
  }
  if (config.shortcutDenyEnabled) {
    tips.push(`${formatShortcut(config.shortcutDeny)} 拒绝当前权限请求`)
  }
  if (config.shortcutSkipEnabled) {
    tips.push(`${formatShortcut(config.shortcutSkip)} 跳过当前问题`)
  }

  return tips
}

export function shuffleTips(tips: string[]): string[] {
  const shuffled = [...tips]
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = shuffled[i]
    shuffled[i] = shuffled[j]
    shuffled[j] = tmp
  }
  return shuffled
}
