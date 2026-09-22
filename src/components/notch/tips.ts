import { shortcutDisplayParts } from '../../utils/keyboardShortcuts'
import { isApplePlatform } from '../../utils/platform'

type Translate = (key: string, options?: { defaultValue?: string; shortcut?: string }) => string

export function formatShortcut(shortcut: string): string {
  const parts = shortcutDisplayParts(shortcut)
  return isApplePlatform() ? parts.join('') : parts.join('+')
}

export function buildTips(t: Translate, config: { globalShortcut: string }): string[] {
  const shortcut = formatShortcut(config.globalShortcut)
  return [
    t('notch.tips.toggle', { shortcut, defaultValue: '按 {{shortcut}} 可以显示或隐藏灵动岛' }),
    t('notch.tips.esc', { defaultValue: '按 ESC 收起当前面板' }),
    t('notch.tips.hover', { defaultValue: '把鼠标移到灵动岛上，可以看到会话详情' }),
    t('notch.tips.settings', { defaultValue: '点齿轮图标可以调整外观、提示和快捷键' }),
    t('notch.tips.health', { defaultValue: '通知检查不通过时，右上角会出现警示图标，点一下就能重新连接' }),
    t('notch.tips.followFocus', { defaultValue: '打开「跟随鼠标所在显示器」后，只看当前屏幕上的会话' }),
    t('notch.tips.tipsOff', { defaultValue: '这些提示可以在「外观」页里关掉' }),
    t('notch.tips.usage', { defaultValue: '允许查询额度后，灵动岛顶部会显示剩余额度' }),
    t('notch.tips.dispatch', { defaultValue: '在「派活关系」页可以让一个 Agent 把任务派给另一个 Agent' }),
    t('notch.tips.update', { defaultValue: '有新版本时，灵动岛会提示你更新' }),
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
