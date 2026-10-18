import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const readSkillManagerCss = () => readFileSync(resolve(process.cwd(), 'src/components/skills-v2/SkillManagerV2.css'), 'utf8')

const blockFor = (css, selector) => {
  const start = css.indexOf(selector)
  if (start < 0) return ''
  return css.slice(start, css.indexOf('}', start) + 1)
}

describe('Skill Manager settings theme scope', () => {
  it('uses island theme colors instead of the retired light palette', () => {
    const skillManagerCss = readSkillManagerCss()

    expect(skillManagerCss).toContain('.settings-content--skills .sm2 {')
    expect(skillManagerCss).toContain('--text-primary: var(--vb-text);')
    expect(skillManagerCss).toContain('--text-secondary: var(--vb-text-2);')
    expect(skillManagerCss).toContain('--card-bg: var(--vb-s1);')
    expect(skillManagerCss).toContain('--border: var(--vb-line);')
  })

  it('gives the portaled overlays their own island palette', () => {
    const skillManagerCss = readSkillManagerCss()

    for (const root of ['.sm2__overlay', '.sm2__slideover-overlay']) {
      const block = blockFor(skillManagerCss, root)
      expect(block, `${root} must define the island palette`).toContain('--sm2-surface: var(--vb-s1);')
    }
  })

  it('keeps no light-theme surfaces behind', () => {
    const skillManagerCss = readSkillManagerCss()

    expect(skillManagerCss).not.toContain('--sm2-surface: #ffffff')
    expect(skillManagerCss).not.toContain('--sm2-surface-soft: #f8fafc')
    expect(skillManagerCss).not.toContain('--sm2-modal-surface: rgba(255, 255, 255, 0.98)')
  })
})
