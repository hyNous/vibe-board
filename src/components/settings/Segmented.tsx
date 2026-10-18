import { useLayoutEffect, useRef, useState } from 'react'

interface SegmentedOption<T extends string> {
  value: T
  label: string
}

interface SegmentedProps<T extends string> {
  value: T
  options: SegmentedOption<T>[]
  onChange: (value: T) => void
  ariaLabel?: string
}

// 分段控件：选中项用一块白色滑块标出，切换时滑块移过去。
export function Segmented<T extends string>({ value, options, onChange, ariaLabel }: SegmentedProps<T>) {
  const ref = useRef<HTMLDivElement>(null)
  const [slab, setSlab] = useState<{ left: number; width: number; animate: boolean } | null>(null)

  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    const place = (animate: boolean) => {
      const item = root.querySelector<HTMLElement>('[aria-checked="true"]')
      if (!item || !item.offsetWidth) {
        setSlab(null)
        return
      }
      setSlab({ left: item.offsetLeft, width: item.offsetWidth, animate })
    }
    place(slab !== null)
    if (typeof ResizeObserver === 'undefined') return
    // 所在页面从隐藏变可见、或文字换了语言时重新定位。
    const observer = new ResizeObserver(() => place(false))
    observer.observe(root)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  return (
    <div ref={ref} role="radiogroup" aria-label={ariaLabel} className={`vb-seg${slab ? ' vb-seg--ready' : ''}`}>
      <span
        className="vb-seg__slab"
        aria-hidden="true"
        style={slab ? { transform: `translateX(${slab.left}px)`, width: slab.width, transition: slab.animate ? undefined : 'none' } : undefined}
      />
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className={`vb-seg__item${option.value === value ? ' vb-seg__item--active' : ''}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
