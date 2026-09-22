export interface SidebarItem {
  id: string
  labelKey: string
  labelDefault: string
  icon: string
  hidden?: boolean
}

export interface SidebarGroup {
  labelKey?: string
  labelDefault?: string
  items: SidebarItem[]
}

// 左侧导航按职责分组：运行（任务看板、使用额度）／管理（Skill、派活关系）／
// 外观／快捷键／系统（通用、重看教程与向导、关于）。文案走 i18n；
// 窄窗口只收窄侧栏宽度，不隐藏标签文字。
// 教程与它的测试按这里的顺序逐个板块介绍功能，改顺序只需改这一处。
export const sidebarGroups: SidebarGroup[] = [
  {
    labelKey: 'settings.nav.groups.run',
    labelDefault: '运行',
    items: [
      { id: 'tasks', labelKey: 'settings.nav.tasks', labelDefault: '任务看板', icon: '✓' },
      { id: 'usage', labelKey: 'settings.nav.usage', labelDefault: '使用额度', icon: '▥' },
    ],
  },
  {
    labelKey: 'settings.nav.groups.manage',
    labelDefault: '管理',
    items: [
      { id: 'skills', labelKey: 'settings.nav.skills', labelDefault: 'Skill', icon: '🧩' },
      { id: 'dispatch', labelKey: 'settings.nav.dispatch', labelDefault: '派活关系', icon: '🤖' },
    ],
  },
  {
    labelKey: 'settings.nav.groups.appearance',
    labelDefault: '外观',
    items: [
      { id: 'island', labelKey: 'settings.nav.island', labelDefault: '外观', icon: '🏝' },
    ],
  },
  {
    labelKey: 'settings.nav.groups.shortcuts',
    labelDefault: '快捷键',
    items: [
      { id: 'shortcuts', labelKey: 'settings.nav.shortcuts', labelDefault: '快捷键', icon: '⌨' },
    ],
  },
  {
    labelKey: 'settings.nav.groups.system',
    labelDefault: '系统',
    items: [
      { id: 'general', labelKey: 'settings.nav.general', labelDefault: '通用', icon: '⚙' },
      { id: 'tutorial', labelKey: 'settings.nav.tutorial', labelDefault: '重看教程与向导', icon: '🎓' },
      { id: 'about', labelKey: 'settings.nav.about', labelDefault: '关于', icon: 'ℹ' },
    ],
  },
]
