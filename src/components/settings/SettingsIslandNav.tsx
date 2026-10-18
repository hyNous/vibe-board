import { Fragment, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSessionStore } from '../../stores/sessionStore'
import { sidebarGroups, type SidebarItem } from './sidebarGroups'

interface SettingsIslandNavProps {
  activeSection: string
  onSelect: (section: string) => void
}

// 设置窗口顶部的岛形导航：和灵动岛同一种胶囊，当前页用一块白色滑块标出。
// 页面顺序与分组来自 sidebarGroups，组与组之间画一道分隔线。
export function SettingsIslandNav({ activeSection, onSelect }: SettingsIslandNavProps) {
  const { t } = useTranslation()
  const waiting = useSessionStore((s) => s.sessionList.filter((session) => session.phase === 'waiting_input').length)
  const navRef = useRef<HTMLElement>(null)
  const [slab, setSlab] = useState<{ left: number; width: number; animate: boolean } | null>(null)
  const current = activeSection

  useLayoutEffect(() => {
    const nav = navRef.current
    if (!nav) return
    const place = (animate: boolean) => {
      const item = nav.querySelector<HTMLElement>(`[data-section="${current}"]`)
      if (!item || !item.offsetWidth) {
        setSlab(null)
        return
      }
      setSlab({ left: item.offsetLeft, width: item.offsetWidth, animate })
    }
    place(slab !== null)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => place(false))
    observer.observe(nav)
    return () => observer.disconnect()
    // slab 只用来判断是否已经放好过，不作为依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current])

  const select = (item: SidebarItem) => onSelect(item.id)

  return (
    <nav
      ref={navRef}
      className={`settings-island${slab ? ' settings-island--ready' : ''}`}
      aria-label={t('settings.nav.label', { defaultValue: '设置页面' })}
    >
      <span
        className="settings-island__slab"
        aria-hidden="true"
        style={slab ? {
          transform: `translateX(${slab.left}px)`,
          width: slab.width,
          transition: slab.animate ? undefined : 'none',
        } : undefined}
      />
      <img className="settings-island__logo" src="/vibe-board-app-icon.png" alt="Vibe Board" />
      {sidebarGroups.map((group, gi) => {
        const items = group.items.filter((item) => !item.hidden)
        if (items.length === 0) return null
        return (
          <Fragment key={gi}>
            {gi > 0 && <span className="settings-island__sep" aria-hidden="true" />}
            <div
              role="group"
              className="settings-island__group"
              aria-label={group.labelKey ? t(group.labelKey, { defaultValue: group.labelDefault }) : undefined}
            >
              {items.map((item) => {
                const label = t(item.labelKey, { defaultValue: item.labelDefault })
                const isActive = current === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-section={item.id}
                    className={`settings-island__item${isActive ? ' settings-island__item--active' : ''}`}
                    aria-label={label}
                    aria-current={isActive ? 'page' : undefined}
                    title={label}
                    onClick={() => select(item)}
                  >
                    {t(item.shortKey, { defaultValue: item.shortDefault })}
                    {item.id === 'tasks' && waiting > 0 && <span className="settings-island__dot" aria-hidden="true" />}
                  </button>
                )
              })}
            </div>
          </Fragment>
        )
      })}
    </nav>
  )
}
