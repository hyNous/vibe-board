import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConfigStore } from '../../../stores/configStore'
import {
  authorizeUsageProvider,
  getConfig,
  isTauri,
  listUsageProviders,
  openSystemPath,
  updateConfig as updateBackendConfig,
} from '../../../services/tauriApi'
import type { UsageProviderStatus } from '../../../services/tauriApi'
import { SettingGroup } from '../SettingGroup'
import { SettingRow } from '../SettingRow'
import { Toggle } from '../Toggle'
import { GlassButton } from '../../shared'

const USAGE_PROVIDER_REFRESH_TIMEOUT_MS = 10_000
const ACCOUNT_USAGE_PROVIDER_ORDER = [
  'codex',
  'claude-code',
  'z-ai',
  'kimi',
  'gemini-cli',
  'copilot',
  'cursor',
  'cursor-cli',
  'deepseek',
  'opencode',
  'droid',
  'stepfun',
  'antigravity',
  'kiro',
]
const ACCOUNT_USAGE_PROVIDER_RANK = new Map(
  ACCOUNT_USAGE_PROVIDER_ORDER.map((provider, index) => [provider, index]),
)

function readableError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message)
  }
  return String(error)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof window.setTimeout> | undefined
  const timeout = new Promise<T>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([
    promise.finally(() => {
      if (timer) window.clearTimeout(timer)
    }),
    timeout,
  ])
}

function persistUsageQuerySettings(next: Partial<{ usageQueryEnabled: boolean; showUsageQuota: boolean }>) {
  const state = useConfigStore.getState()
  getConfig()
    .then((backendConfig) => updateBackendConfig({
      ...backendConfig,
      usageQueryEnabled: next.usageQueryEnabled ?? state.usageQueryEnabled,
      showTokenUsage: next.showUsageQuota ?? state.showUsageQuota,
    }))
    .catch((err) => console.error('Failed to persist usage query settings:', err))
}

export function UsageProvidersPanel() {
  const { t } = useTranslation()
  const config = useConfigStore()
  const [usageProviders, setUsageProviders] = useState<UsageProviderStatus[]>([])
  const [usageLoading, setUsageLoading] = useState(false)
  const [usageAction, setUsageAction] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const usageRequestSeq = useRef(0)

  const fetchUsageProviders = useCallback(async (options: { live?: boolean; showLoading?: boolean } = {}) => {
    const { live = true, showLoading = true } = options
    const requestSeq = ++usageRequestSeq.current
    if (showLoading) setUsageLoading(true)
    try {
      const providers = await withTimeout(
        listUsageProviders(live),
        USAGE_PROVIDER_REFRESH_TIMEOUT_MS,
        t('settings.usageRefreshTimeout', { defaultValue: '用量查询超时，请稍后刷新。' }),
      )
      if (requestSeq === usageRequestSeq.current) {
        setUsageProviders(providers)
      }
    } catch (e) {
      if (showLoading && requestSeq === usageRequestSeq.current) {
        setError(readableError(e))
      }
    } finally {
      if (showLoading && requestSeq === usageRequestSeq.current) {
        setUsageLoading(false)
      }
    }
  }, [t])

  useEffect(() => {
    const timer = window.setTimeout(() => { fetchUsageProviders({ live: false, showLoading: false }) }, 0)
    return () => window.clearTimeout(timer)
  }, [fetchUsageProviders])

  const setUsageQueryEnabled = (enabled: boolean) => {
    config.updateConfig('usageQueryEnabled', enabled)
    config.updateConfig('showUsageQuota', enabled)
    persistUsageQuerySettings({ usageQueryEnabled: enabled, showUsageQuota: enabled })
    window.setTimeout(() => { fetchUsageProviders({ live: false, showLoading: false }) }, 150)
  }

  const authorizeProvider = async (provider: string) => {
    setError(null); setNotice(null)
    if (!isTauri()) {
      setNotice(t('settings.desktopOnlyHooks', { defaultValue: 'Hook management is available in the desktop app.' }))
      return
    }
    setUsageAction(provider)
    try {
      await authorizeUsageProvider(provider)
      setNotice(t('settings.usageAuthStarted', { defaultValue: '已打开终端授权，完成登录后点检测刷新状态。' }))
    } catch (e) {
      setError(readableError(e))
    } finally {
      setUsageAction(null)
    }
  }

  const accountUsageProviders = usageProviders
    .filter((provider) =>
      ACCOUNT_USAGE_PROVIDER_RANK.has(provider.provider)
      && (provider.catalogSupported || provider.implementationStatus === 'active'),
    )
    .sort((a, b) =>
      (ACCOUNT_USAGE_PROVIDER_RANK.get(a.provider) ?? Number.MAX_SAFE_INTEGER)
      - (ACCOUNT_USAGE_PROVIDER_RANK.get(b.provider) ?? Number.MAX_SAFE_INTEGER)
      || a.label.localeCompare(b.label),
    )
  const usageStatusLabel = (provider: UsageProviderStatus) => {
    if (!provider.enabled) return t('settings.disabled', { defaultValue: 'Disabled' })
    if (provider.available) return t('settings.connected', { defaultValue: 'Connected' })
    if (provider.authStatus === 'authorized') return t('settings.waitingData', { defaultValue: 'Waiting for data' })
    if (provider.authStatus === 'missing') return t('settings.needsAuth', { defaultValue: 'Needs authorization' })
    if (provider.implementationStatus === 'available') return t('settings.usageReaderAvailable', { defaultValue: '可接入' })
    if (provider.implementationStatus === 'unsupported') return t('settings.usageReaderPending', { defaultValue: '待接入' })
    return t('settings.needsAuth', { defaultValue: 'Needs authorization' })
  }

  const shouldShowUsageAuthorize = (provider: UsageProviderStatus) =>
    config.usageQueryEnabled
    && provider.canAuthorize
    && provider.authStatus !== 'authorized'
    && !provider.available

  return (
    <SettingGroup
      actions={(
        <button className="settings-mini-button" disabled={usageLoading} onClick={() => fetchUsageProviders({ live: true, showLoading: true })} type="button">
          {usageLoading ? t('settings.detecting', { defaultValue: '检测中...' }) : t('settings.refresh', { defaultValue: '刷新' })}
        </button>
      )}
      label={t('settings.accountQuota', { defaultValue: '账号配额' })}
    >
      {error && <div className="hook-error-card">{error}</div>}
      {notice && <div className="hook-notice-card">{notice}</div>}
      <SettingRow
        label={t('settings.usageQueryEnabled', { defaultValue: '启用用量查询' })}
        description={t('settings.usageQueryEnabledDesc', { defaultValue: '后台读取官方账号或 CLI 的 Token 配额，用于灵动岛顶部显示。第三方 API/中转站用量后续在单独模块配置。' })}
      >
        <Toggle checked={config.usageQueryEnabled} onChange={setUsageQueryEnabled} />
      </SettingRow>
      {accountUsageProviders.length === 0 && (
        <div className="hook-empty">
          {t('settings.noAccountQuotaProviders', { defaultValue: '暂无可查询的官方账号配额。' })}
        </div>
      )}
      {accountUsageProviders.map((provider) => (
        <div className="usage-provider-row" key={provider.provider} data-testid={`usage-provider-${provider.provider}`}>
          <div className="usage-provider-row__main">
            <div className="usage-provider-row__title">
              <span>{provider.label}</span>
              <strong>{usageStatusLabel(provider)}</strong>
            </div>
            <div className="usage-provider-row__detail" title={provider.authPath || provider.detail}>
              {provider.source ? `${provider.source} · ${provider.detail}` : provider.detail}
            </div>
            {provider.authPath && (
              <div className="usage-provider-row__path">{provider.authPath}</div>
            )}
          </div>
          <div className="usage-provider-row__actions">
            {provider.authPath && (
              <GlassButton variant="ghost" onClick={() => openSystemPath(provider.authPath!)}>
                {t('settings.openCredential', { defaultValue: '打开凭据' })}
              </GlassButton>
            )}
            {shouldShowUsageAuthorize(provider) && (
              <GlassButton
                variant="secondary"
                onClick={() => authorizeProvider(provider.provider)}
                disabled={usageAction === provider.provider}
              >
                {usageAction === provider.provider
                  ? t('settings.authorizing', { defaultValue: '授权中...' })
                  : t('settings.authorizeUsage', { defaultValue: '用量授权' })}
              </GlassButton>
            )}
          </div>
        </div>
      ))}
    </SettingGroup>
  )
}
