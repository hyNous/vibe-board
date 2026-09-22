import { describe, expect, it } from 'vitest'
import tutorial from '../../public/tutorial/index.html?raw'
import { sidebarGroups } from '../components/settings/sidebarGroups'

function parseTutorial() {
  return new DOMParser().parseFromString(tutorial, 'text/html')
}

describe('bundled offline tutorial', () => {
  it('references no network resources, external scripts, fonts, or CDNs', () => {
    expect(tutorial).not.toMatch(/https?:\/\//i)
    expect(tutorial).not.toMatch(/<script[^>]+src\s*=/i)
    expect(tutorial).not.toMatch(/<link[^>]+href\s*=/i)
    expect(tutorial).not.toMatch(/<img[\s>]/i)
    expect(tutorial).not.toMatch(/<iframe[\s>]/i)
    expect(tutorial).not.toMatch(/@import/i)
    expect(tutorial).not.toMatch(/@font-face/i)
    expect(tutorial).not.toMatch(/url\(\s*['"]?(?:https?:)?\/\//i)
  })

  it('draws its illustrations with inline SVG and CSS animations', () => {
    expect(tutorial).toContain('<svg')
    expect(tutorial).toMatch(/@keyframes\s+[a-z-]+/i)
    expect(tutorial).toMatch(/animation:\s*[a-z-]+/i)
  })

  it('opens with the island, then follows the settings sidebar order block by block', () => {
    const sidebarEntries = sidebarGroups.flatMap((group) => group.items.filter((item) => !item.hidden))
    const doc = parseTutorial()

    const sections = Array.from(doc.querySelectorAll('main > section[data-settings-section]'))
    expect(sections.map((section) => section.getAttribute('data-settings-section')))
      .toEqual(sidebarEntries.map((item) => item.id))
    expect(sections.map((section) => section.id)).toEqual(sidebarEntries.map((item) => item.id))

    // Each tutorial section is titled with the exact sidebar label.
    sidebarEntries.forEach((item, index) => {
      const heading = sections[index].querySelector('h2 [data-zh]')
      expect(heading?.getAttribute('data-zh'), item.id).toBe(item.labelDefault)
    })

    // The island intro comes first, and the on-page contents mirror the order.
    const allSections = Array.from(doc.querySelectorAll('main > section'))
    expect(allSections[0].id).toBe('island-intro')
    expect(allSections[0].querySelector('h2 [data-zh]')?.getAttribute('data-zh')).toBe('灵动岛怎么用')

    const navTargets = Array.from(doc.querySelectorAll('header nav .nav a')).map((anchor) => anchor.getAttribute('href'))
    expect(navTargets).toEqual(['#island-intro', ...sidebarEntries.map((item) => `#${item.id}`)])
  })

  it('gives every section a lead sentence and at least one usage fact', () => {
    const doc = parseTutorial()
    const allSections = Array.from(doc.querySelectorAll('main > section'))
    expect(allSections.length).toBeGreaterThanOrEqual(10)
    for (const section of allSections) {
      const lead = section.querySelector('.section-lead')?.textContent?.trim() ?? ''
      expect(lead.length, section.id).toBeGreaterThan(10)
    }
    for (const section of doc.querySelectorAll('main > section[data-settings-section]')) {
      expect(section.querySelectorAll('.facts li').length, section.id).toBeGreaterThanOrEqual(2)
    }

    // The opening section covers the most common island operations.
    const introZh = Array.from(doc.querySelectorAll('#island-intro [data-zh]'))
      .map((node) => node.getAttribute('data-zh'))
      .join(' ')
    for (const topic of ['展开', '收起', '点任务', 'Esc', 'Ctrl/Cmd+J']) {
      expect(introZh).toContain(topic)
    }
  })

  it('states the real behaviours and omits removed features', () => {
    const realBehaviours = [
      '这个任务没有可唤回的窗口，请到它的终端里查看进度。',
      '重新连接',
      'Ctrl/Cmd+J',
      '生效于',
      '自定义',
      '从 Agent 同步',
      '用量与花费',
      '今天 / 本周 / 本月',
      '估算',
      '没有公开价格的模型只统计 token，不显示金额',
      '在灵动岛显示额度',
      '允许查询',
      '＋ 添加工人',
      '断开',
      '全局指令文件',
      'external-agent-setup',
      '恢复灵动岛默认设置',
      '选择要接入的 Agent',
    ]
    for (const phrase of realBehaviours) {
      expect(tutorial, phrase).toContain(phrase)
    }

    // Removed in M2–M6 and must never be promised by the tutorial.
    expect(tutorial).not.toMatch(/MCP|Plugin|技能包|宿主|角色主题|审批|回答|与 ?Agent 对话/)
  })

  it('carries both Chinese and English text for every translated element', () => {
    const translatedTags = tutorial.match(/<[a-z][^>]*data-zh="[^"]*"[^>]*>/gi) ?? []
    expect(translatedTags.length).toBeGreaterThan(20)
    for (const tag of translatedTags) {
      expect(tag).toMatch(/\sdata-en="[^"]+"/i)
    }

    const zhValues = [...tutorial.matchAll(/data-zh="([^"]*)"/gi)].map((match) => match[1])
    const enValues = [...tutorial.matchAll(/data-en="([^"]*)"/gi)].map((match) => match[1])
    expect(zhValues).toHaveLength(enValues.length)
    expect(zhValues.every((value) => value.trim().length > 0)).toBe(true)
    expect(enValues.every((value) => value.trim().length > 0)).toBe(true)

    // The inline fallback text is English, so the page still reads correctly
    // before the language script runs.
    const parsed = parseTutorial()
    const translatedNodes = parsed.querySelectorAll('[data-zh][data-en]')
    expect(translatedNodes.length).toBe(translatedTags.length)
    for (const node of translatedNodes) {
      expect(node.textContent?.trim()).toBe(node.getAttribute('data-en')?.trim())
    }
  })

  it('falls back to English for every language other than Chinese', () => {
    expect(tutorial).toMatch(/requested\.toLowerCase\(\)\.indexOf\('zh'\) === 0/)
    expect(tutorial).toContain("getAttribute('data-' + language)")
  })
})
