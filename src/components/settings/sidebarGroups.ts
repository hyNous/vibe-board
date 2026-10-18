export interface SidebarItem {
  id: string
  labelKey: string
  labelDefault: string
  icon: string
  // 顶部岛形导航里显示的短名；完整名称仍用作无障碍名称和教程标题。
  shortKey: string
  shortDefault: string
  hidden?: boolean
}

export interface SidebarGroup {
  labelKey?: string
  labelDefault?: string
  items: SidebarItem[]
}

// 设置页面按职责分组：运行（任务看板、使用额度）／管理（Skill、派活关系）／
// 外观／快捷键／系统（通用、重看教程与向导、关于）。顶部岛形导航按这里的顺序
// 显示短名，组与组之间用分隔线隔开。文案走 i18n。
// 教程与它的测试按这里的顺序逐个板块介绍功能，改顺序只需改这一处。
export const sidebarGroups: SidebarGroup[] = [
  {
    labelKey: 'settings.nav.groups.run',
    labelDefault: '运行',
    items: [
      { id: 'tasks', labelKey: 'settings.nav.tasks', labelDefault: '任务看板', shortKey: 'settings.nav.short.tasks', shortDefault: '任务', icon: '✓' },
      { id: 'usage', labelKey: 'settings.nav.usage', labelDefault: '使用额度', shortKey: 'settings.nav.short.usage', shortDefault: '额度', icon: '▥' },
    ],
  },
  {
    labelKey: 'settings.nav.groups.manage',
    labelDefault: '管理',
    items: [
      { id: 'skills', labelKey: 'settings.nav.skills', labelDefault: 'Skill', shortKey: 'settings.nav.short.skills', shortDefault: 'Skill', icon: '🧩' },
      { id: 'dispatch', labelKey: 'settings.nav.dispatch', labelDefault: '派活关系', shortKey: 'settings.nav.short.dispatch', shortDefault: '派活', icon: '🤖' },
    ],
  },
  {
    labelKey: 'settings.nav.groups.appearance',
    labelDefault: '外观',
    items: [
      { id: 'island', labelKey: 'settings.nav.island', labelDefault: '外观', shortKey: 'settings.nav.short.island', shortDefault: '外观', icon: '🏝' },
    ],
  },
  {
    labelKey: 'settings.nav.groups.shortcuts',
    labelDefault: '快捷键',
    items: [
      { id: 'shortcuts', labelKey: 'settings.nav.shortcuts', labelDefault: '快捷键', shortKey: 'settings.nav.short.shortcuts', shortDefault: '快捷键', icon: '⌨' },
    ],
  },
  {
    labelKey: 'settings.nav.groups.system',
    labelDefault: '系统',
    items: [
      { id: 'general', labelKey: 'settings.nav.general', labelDefault: '通用', shortKey: 'settings.nav.short.general', shortDefault: '通用', icon: '⚙' },
      { id: 'tutorial', labelKey: 'settings.nav.tutorial', labelDefault: '重看教程与向导', shortKey: 'settings.nav.short.tutorial', shortDefault: '教程', icon: '🎓' },
      { id: 'about', labelKey: 'settings.nav.about', labelDefault: '关于', shortKey: 'settings.nav.short.about', shortDefault: '关于', icon: 'ℹ' },
    ],
  },
]
