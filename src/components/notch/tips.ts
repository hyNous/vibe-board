import { shortcutDisplayParts } from '../../utils/keyboardShortcuts'
import { isApplePlatform } from '../../utils/platform'

export function formatShortcut(shortcut: string): string {
  const parts = shortcutDisplayParts(shortcut)
  return isApplePlatform() ? parts.join('') : parts.join('+')
}

export function buildTips(config: { globalShortcut: string }): string[] {
  return [
    `${formatShortcut(config.globalShortcut)} 切换灵动岛显示`,
    'ESC 收起当前展开面板',
    '悬停灵动岛查看会话详情',
    '点击设置图标可调整主题、声音和快捷键',
    'Hook 自检失败时，灵动岛上的健康指示可一键重新安装',
    '开启 Follow Focus 后只看当前窗口相关会话',
    '空闲提示可以在 Island 设置里关闭',
    '通知声音、静音时段和快捷键都可以单独配置',
    '开启用量展示后可在灵动岛查看 5h/7d 额度',
    'Webhook 可把完成和失败事件同步到群里',
  ]
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
