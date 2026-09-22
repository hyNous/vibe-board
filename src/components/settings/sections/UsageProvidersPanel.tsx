import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConfigStore } from '../../../stores/configStore'
import {
  authorizeUsageProvider,
  getConfig,
  isTauri,
  listUsageProviders,
  openSystemPath,
  setUsageNetworkAuthorization,
  updateConfig as updateBackendConfig,
} from '../../../services/tauriApi'
import type { UsageSnapshot } from '../../../services/tauriApi'
import { SettingGroup } from '../SettingGroup'
import { SettingRow } from '../SettingRow'
import { Toggle } from '../Toggle'
import { GlassButton } from '../../shared'

// `agy /usage` can take up to 20 seconds; leave headroom before the UI gives up.
const USAGE_PROVIDER_REFRESH_TIMEOUT_MS = 25_000

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
  const [usageProviders, setUsageProviders] = useState<UsageSnapshot[]>([])
  const [usageLoading, setUsageLoading] = useState(false)
  const [usageAction, setUsageAction] = useState<string | null>(null)
  const [pendingAuthorization, setPendingAuthorization] = useState<string | null>(null)
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

  const applyNetworkAuthorization = async (provider: string, authorized: boolean) => {
    setError(null); setNotice(null)
    if (!isTauri()) {
      setNotice(t('settings.desktopOnlyHooks', { defaultValue: 'Hook management is available in the desktop app.' }))
      return
    }
    setUsageAction(provider)
    try {
      await setUsageNetworkAuthorization(provider, authorized)
      setPendingAuthorization(null)
      setNotice(authorized
        ? t('settings.usageNetworkEnabledNotice', { defaultValue: '已允许联网查询，正在刷新额度。' })
        : t('settings.usageNetworkDisabledNotice', { defaultValue: '已撤销联网查询授权，该 Provider 不再发起请求。' }))
      await fetchUsageProviders({ live: authorized, showLoading: true })
    } catch (e) {
      setError(readableError(e))
    } finally {
      setUsageAction(null)
    }
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
    .filter((provider) => provider.settingsOrder != null)
    .sort((a, b) => (a.settingsOrder ?? 0) - (b.settingsOrder ?? 0))

  const usageStatusLabel = (provider: UsageSnapshot) => {
    if (!provider.enabled) return t('settings.disabled', { defaultValue: 'Disabled' })
    if (provider.state === 'ok') return t('settings.connected', { defaultValue: 'Connected' })
    if (provider.networkSupported && !provider.networkAuthorized) {
      return t('settings.usageNetworkNeedsAuthorization', { defaultValue: '未授权联网查询' })
    }
    if (provider.authStatus === 'authorized') return t('settings.waitingData', { defaultValue: 'Waiting for data' })
    if (provider.authStatus === 'missing') return t('settings.needsAuth', { defaultValue: 'Needs authorization' })
    if (provider.implementationStatus === 'available') return t('settings.usageReaderAvailable', { defaultValue: '可接入' })
    if (provider.implementationStatus === 'unsupported') return t('settings.usageReaderPending', { defaultValue: '待接入' })
    return t('settings.needsAuth', { defaultValue: 'Needs authorization' })
  }

  const networkRequestSummary = (provider: UsageSnapshot) => {
    const target = provider.networkTarget ?? ''
    const template = provider.networkKind === 'cli'
      ? t('settings.usageNetworkConfirmCli', {
        defaultValue: '运行本地程序 {{target}}，由它自己向 Provider 查询额度。',
      })
      : t('settings.usageNetworkConfirmHttp', {
        defaultValue: '向 {{target}} 发出用量查询请求。',
      })
    return template.replace('{{target}}', target)
  }

  const shouldShowUsageAuthorize = (provider: UsageSnapshot) =>
    provider.canAuthorize
    && provider.authStatus !== 'authorized'
    && provider.state !== 'ok'

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
        label={t('settings.usageQueryEnabled', { defaultValue: '在灵动岛显示额度' })}
        description={t('settings.usageQueryEnabledDesc', { defaultValue: '只控制灵动岛顶部是否显示额度；联网查询需要在下方逐个 Provider 授权，默认全部关闭。' })}
      >
        <Toggle checked={config.usageQueryEnabled} onChange={setUsageQueryEnabled} />
      </SettingRow>
      {accountUsageProviders.length === 0 && (
        <div className="hook-empty">
          {t('settings.noAccountQuotaProviders', { defaultValue: '暂无可查询的官方账号配额。' })}
        </div>
      )}
      {accountUsageProviders.map((provider) => {
        const confirming = pendingAuthorization === provider.provider
        const busy = usageAction === provider.provider
        return (
          <div className="usage-provider-row" key={provider.provider} data-testid={`usage-provider-${provider.provider}`}>
            <div className="usage-provider-row__main">
              <div className="usage-provider-row__title">
                <span>{provider.label}</span>
                <strong>{usageStatusLabel(provider)}</strong>
                {usageLoading && provider.networkSupported && provider.networkAuthorized && (
                  <em className="usage-provider-row__querying" data-testid={`usage-provider-querying-${provider.provider}`}>
                    {t('settings.usageNetworkQuerying', { defaultValue: '正在查询…' })}
                  </em>
                )}
              </div>
              <div className="usage-provider-row__detail" title={provider.authPath || provider.detail}>
                {provider.source ? `${provider.source} · ${provider.detail}` : provider.detail}
              </div>
              {provider.authPath && (
                <div className="usage-provider-row__path">{provider.authPath}</div>
              )}
              {provider.networkSupported ? (
                <div className="usage-provider-row__network" data-testid={`usage-network-${provider.provider}`}>
                  <span className="usage-provider-row__network-state">
                    {provider.networkAuthorized
                      ? t('settings.usageNetworkAuthorized', { defaultValue: '已允许联网查询' })
                      : t('settings.usageNetworkNotAuthorized', { defaultValue: '未允许联网查询（默认关闭）' })}
                  </span>
                  {confirming && (
                    <div className="usage-provider-row__confirm" data-testid={`usage-network-confirm-${provider.provider}`}>
                      <p className="usage-provider-row__confirm-intro">
                        {t('settings.usageNetworkConfirmIntro', { defaultValue: '开启后 Vibe Board 会：' })}
                      </p>
                      <dl className="usage-provider-row__confirm-list">
                        <dt>{t('settings.usageNetworkRequest', { defaultValue: '发出的请求' })}</dt>
                        <dd>{networkRequestSummary(provider)}</dd>
                        <dt>{t('settings.usageNetworkCredential', { defaultValue: '使用的本地凭据' })}</dt>
                        <dd className="usage-provider-row__path">
                          {provider.networkCredential
                            ?? t('settings.usageNetworkCredentialManaged', { defaultValue: '由该本地程序自己管理，Vibe Board 不读取' })}
                        </dd>
                      </dl>
                      <p className="usage-provider-row__confirm-note">
                        {t('settings.usageNetworkConfirmNote', { defaultValue: '只读取凭据用于本次请求，不显示也不记录凭据内容；可随时撤销。' })}
                      </p>
                      <div className="usage-provider-row__confirm-actions">
                        <GlassButton
                          variant="primary"
                          onClick={() => void applyNetworkAuthorization(provider.provider, true)}
                          disabled={busy}
                        >
                          {busy
                            ? t('settings.detecting', { defaultValue: '检测中...' })
                            : t('settings.usageNetworkConfirmEnable', { defaultValue: '确认开启' })}
                        </GlassButton>
                        <GlassButton variant="ghost" onClick={() => setPendingAuthorization(null)} disabled={busy}>
                          {t('settings.usageNetworkCancel', { defaultValue: '取消' })}
                        </GlassButton>
                      </div>
                    </div>
                  )}
                </div>
              ) : provider.networkUnsupportedReason === 'unverified' ? (
                <div className="usage-provider-row__path" data-testid={`usage-network-unsupported-${provider.provider}`}>
                  {t('settings.usageNetworkUnsupported', { defaultValue: '暂不支持联网查询' })}
                </div>
              ) : null}
            </div>
            <div className="usage-provider-row__actions">
              {provider.authPath && (
                <GlassButton variant="ghost" onClick={() => openSystemPath(provider.authPath!)}>
                  {t('settings.openCredential', { defaultValue: '打开凭据' })}
                </GlassButton>
              )}
              {provider.networkSupported && (
                <Toggle
                  checked={provider.networkAuthorized}
                  disabled={busy}
                  onChange={(next) => {
                    setError(null); setNotice(null)
                    if (next) {
                      setPendingAuthorization(provider.provider)
                    } else {
                      setPendingAuthorization(null)
                      void applyNetworkAuthorization(provider.provider, false)
                    }
                  }}
                />
              )}
              {shouldShowUsageAuthorize(provider) && (
                <GlassButton
                  variant="secondary"
                  onClick={() => authorizeProvider(provider.provider)}
                  disabled={busy}
                >
                  {busy
                    ? t('settings.authorizing', { defaultValue: '授权中...' })
                    : t('settings.authorizeUsage', { defaultValue: '打开官方登录' })}
                </GlassButton>
              )}
            </div>
          </div>
        )
      })}
    </SettingGroup>
  )
}
