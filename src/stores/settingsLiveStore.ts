import { create } from 'zustand'
import { getMonitorSessions, type MonitorSessionSummary } from '../services/monitorApi'
import { getUsageDashboard, isTauri, listUsageProviders, type UsageDashboard, type UsageSnapshot } from '../services/tauriApi'

// 设置窗口打开期间在后台持续刷新的数据：任务看板的会话、额度页的额度与各工具查询状态。
// 页面只读这里的最新结果，切换页面不再从空白重新加载；点「刷新」照样立刻重新查。

const USAGE_REFRESH_MS = 60_000

interface SettingsLiveState {
  monitorSessions: MonitorSessionSummary[]
  monitorLoaded: boolean
  monitorLoading: boolean
  monitorError: string
  usageDashboard: UsageDashboard | null
  usageLoading: boolean
  usageError: string
  usageProviders: UsageSnapshot[]
  providersLoading: boolean
  refreshMonitor: (options?: { showLoading?: boolean }) => Promise<void>
  refreshUsage: () => Promise<void>
  refreshProviders: (options?: { live?: boolean; showLoading?: boolean; timeoutMs?: number; timeoutMessage?: string }) => Promise<void>
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// 同一类请求只采纳最后发出的那次结果，避免慢的旧请求覆盖新结果。
const seq = { monitor: 0, usage: 0, providers: 0 }

export const useSettingsLive = create<SettingsLiveState>((set) => ({
  monitorSessions: [],
  monitorLoaded: false,
  monitorLoading: false,
  monitorError: '',
  usageDashboard: null,
  usageLoading: false,
  usageError: '',
  usageProviders: [],
  providersLoading: false,

  refreshMonitor: async ({ showLoading = false } = {}) => {
    const id = ++seq.monitor
    if (showLoading) set({ monitorLoading: true })
    try {
      const sessions = await getMonitorSessions()
      if (id === seq.monitor) set({ monitorSessions: sessions, monitorError: '' })
    } catch (error) {
      if (id === seq.monitor) set({ monitorError: message(error) })
    } finally {
      if (id === seq.monitor) set({ monitorLoaded: true, monitorLoading: false })
    }
  },

  refreshUsage: async () => {
    if (!isTauri()) return
    const id = ++seq.usage
    set({ usageLoading: true })
    try {
      const dashboard = await getUsageDashboard()
      if (id === seq.usage) set({ usageDashboard: dashboard, usageError: '' })
    } catch (error) {
      if (id === seq.usage) set({ usageError: message(error) })
    } finally {
      if (id === seq.usage) set({ usageLoading: false })
    }
  },

  refreshProviders: async ({ live = true, showLoading = false, timeoutMs, timeoutMessage } = {}) => {
    const id = ++seq.providers
    if (showLoading) set({ providersLoading: true })
    try {
      const request = listUsageProviders(live)
      const providers = timeoutMs
        ? await Promise.race([
          request,
          new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error(timeoutMessage ?? 'timeout')), timeoutMs)),
        ])
        : await request
      if (id === seq.providers) set({ usageProviders: providers })
    } finally {
      if (id === seq.providers && showLoading) set({ providersLoading: false })
    }
  },
}))

/** 设置窗口挂载时调用一次；返回停止函数。任务按配置的刷新间隔，额度每分钟一次。 */
export function startSettingsLive(taskIntervalMs: number): () => void {
  const live = useSettingsLive.getState()
  void live.refreshMonitor({ showLoading: true })
  void live.refreshUsage()
  void live.refreshProviders({ live: false }).catch(() => {})
  const taskTimer = window.setInterval(() => { void useSettingsLive.getState().refreshMonitor() }, taskIntervalMs)
  const usageTimer = window.setInterval(() => {
    const state = useSettingsLive.getState()
    void state.refreshUsage()
    void state.refreshProviders({ live: true }).catch(() => {})
  }, USAGE_REFRESH_MS)
  return () => {
    window.clearInterval(taskTimer)
    window.clearInterval(usageTimer)
  }
}

/** 额度页只列出本机检测到、且 Vibe Board 真能读到额度的工具。 */
export function isListedUsageProvider(provider: Pick<UsageSnapshot, 'detected' | 'implementationStatus'>): boolean {
  return provider.detected && provider.implementationStatus === 'active'
}
