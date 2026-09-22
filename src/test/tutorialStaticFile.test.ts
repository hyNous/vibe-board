import { describe, expect, it } from 'vitest'
import tutorial from '../../public/tutorial/index.html?raw'

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

  it('covers the four first-run themes plus the full-only sections', () => {
    const markers = [
      'id="island"',
      'id="board"',
      'id="click"',
      'id="agents"',
      'id="skills"',
      'id="usage"',
      'id="dispatch"',
      '岛怎么用',
      '看板在显示什么',
      '点任务会发生什么',
      'Agent 接入',
      'Skill 管理',
      '使用额度',
    ]
    for (const marker of markers) {
      expect(tutorial, marker).toContain(marker)
    }
  })

  it('states the real behaviours and omits removed features', () => {
    const realBehaviours = [
      '请手动打开 CLI 查看执行进度',
      '会话开始时拉起看板',
      'Hook 健康指示',
      'Ctrl/Cmd+J',
      '生效于',
      '自定义',
      '从 Agent 同步',
      '用量与成本',
      '估算',
      'external-agent-setup',
    ]
    for (const phrase of realBehaviours) {
      expect(tutorial, phrase).toContain(phrase)
    }

    // Removed in M2–M6 and must never be promised by the tutorial.
    expect(tutorial).not.toMatch(/MCP|Plugin|技能包|宿主/)
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
    const parsed = new DOMParser().parseFromString(tutorial, 'text/html')
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
