import { create } from 'zustand'

// 设置窗口的提示条：从顶部岛形导航下方弹出，说出一次操作的结果。
interface SettingsToastState {
  text: string
  visible: boolean
  show: (text: string) => void
  hide: () => void
}

let hideTimer: ReturnType<typeof setTimeout> | undefined

export const useSettingsToast = create<SettingsToastState>((set) => ({
  text: '',
  visible: false,
  show: (text) => {
    clearTimeout(hideTimer)
    set({ text, visible: true })
    hideTimer = setTimeout(() => set({ visible: false }), 1800)
  },
  hide: () => {
    clearTimeout(hideTimer)
    set({ visible: false })
  },
}))
