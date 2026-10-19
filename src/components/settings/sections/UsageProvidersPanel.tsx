import { useCallback, useEffect, useState } from 'react'
import { isListedUsageProvider, useSettingsLive } from '../../../stores/settingsLiveStore'
import { useTranslation } from 'react-i18next'
import { useConfigStore } from '../../../stores/configStore'
import {
  authorizeUsageProvider,
  getConfig,
  isTauri,
  openSystemPath,
  setUsageNetworkAuthorization,
  updateConfig as updateBackendConfig,
} from '../../../services/tauriApi'
import type { UsageSnapshot } from '../../../services/tauriApi'
import { SettingGroup } from '../SettingGroup'
import { SettingRow } from '../SettingRow'
import { SettingDetails } from '../SettingDetails'
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

const LOGIN_REMINDER_MS = 3 * 24 * 60 * 60 * 1000

export function UsageProvidersPanel() {
  const { t } = useTranslation()
  const config = useConfigStore()
  // 各工具的查询状态由设置窗口在后台持续刷新（settingsLiveStore）。
  const usageProviders = useSettingsLive((state) => state.usageProviders)
  const usageLoading = useSettingsLive((state) => state.providersLoading)
  const refreshProviders = useSettingsLive((state) => state.refreshProviders)
  const [usageAction, setUsageAction] = useState<string | null>(null)
  const [pendingAuthorization, setPendingAuthorization] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const fetchUsageProviders = useCallback(async (options: { live?: boolean; showLoading?: boolean } = {}) => {
    const { live = true, showLoading = true } = options
    try {
      await refreshProviders({
        live,
        showLoading,
        timeoutMs: USAGE_PROVIDER_REFRESH_TIMEOUT_MS,
        timeoutMessage: t('settings.usageRefreshTimeout', { defaultValue: '用量查询超时，请稍后刷新。' }),
      })
    } catch (e) {
      if (showLoading) setError(readableError(e))
    }
  }, [refreshProviders, t])

  useEffect(() => {
    // 先显示已有结果，同时补一次刷新。
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
      setNotice(t('settings.desktopOnlyUsage', { defaultValue: '联网查询只在桌面应用里可用。' }))
      return
    }
    setUsageAction(provider)
    try {
      await setUsageNetworkAuthorization(provider, authorized)
      setPendingAuthorization(null)
      setNotice(authorized
        ? t('settings.usageNetworkEnabledNotice', { defaultValue: '已允许联网查询，正在刷新额度。' })
        : t('settings.usageNetworkDisabledNotice', { defaultValue: '已停止联网查询，不会再向这个工具发出请求。' }))
      await fetchUsageProviders({ live: authorized, showLoading: true })
      if (authorized) {
        // 打开后第一次就没查到：自动关回去，说明原因，让用户处理后再试。
        const result = useSettingsLive.getState().usageProviders.find((item) => item.provider === provider)
        if (result?.state === 'failed') {
          await setUsageNetworkAuthorization(provider, false)
          await fetchUsageProviders({ live: false, showLoading: false })
          setNotice(null)
          setError(t('settings.usageNetworkEnableFailed', {
            name: result.label,
            defaultValue: '没能查到 {{name}} 的额度，已自动关闭查询。',
          }) + usageFailureReason(result.detail))
        }
      }
    } catch (e) {
      setError(readableError(e))
    } finally {
      setUsageAction(null)
    }
  }

  // 登录本身快到期时提前提醒：自动续期只能续访问令牌，续期令牌到期后必须重新登录。
  const loginReminder = (provider: UsageSnapshot) => {
    if (!provider.loginExpiresAt) return null
    const remainingMs = provider.loginExpiresAt - Date.now()
    if (remainingMs > LOGIN_REMINDER_MS) return null
    if (remainingMs <= 0) {
      return t('settings.usageLoginExpired', {
        name: provider.label,
        defaultValue: '{{name}} 的登录已到期，点「登录」重新登录后才能继续查询额度。',
      })
    }
    const date = new Date(provider.loginExpiresAt).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    return t('settings.usageLoginExpiring', {
      name: provider.label,
      date,
      defaultValue: '{{name}} 的登录将在 {{date}} 到期，到期前点「登录」重新登录一次即可。',
    })
  }

  const usageFailureReason = (detail: string) => {
    if (/\b401\b|\b403\b|expired|not logged in/i.test(detail)) {
      return t('settings.usageFailureAuth', { defaultValue: '登录信息无效或已过期，请先在这个工具里重新登录。' })
    }
    if (/timed? ?out|timeout/i.test(detail)) {
      return t('settings.usageFailureTimeout', { defaultValue: '查询超时，请稍后再试。' })
    }
    return t('settings.usageFailureOther', { defaultValue: '请稍后再试，原因见「详情」。' })
  }

  const authorizeProvider = async (provider: string) => {
    setError(null); setNotice(null)
    if (!isTauri()) {
      setNotice(t('settings.desktopOnlyUsage', { defaultValue: '联网查询只在桌面应用里可用。' }))
      return
    }
    setUsageAction(provider)
    try {
      await authorizeUsageProvider(provider)
      setNotice(t('settings.usageAuthStarted', { defaultValue: '已打开登录窗口；登录完成后点「刷新」查看额度。' }))
    } catch (e) {
      setError(readableError(e))
    } finally {
      setUsageAction(null)
    }
  }

  // 只列出本机检测到、且 Vibe Board 真能读到额度的工具。
  const accountUsageProviders = usageProviders
    .filter((provider) => provider.settingsOrder != null && isListedUsageProvider(provider))
    .sort((a, b) => (a.settingsOrder ?? 0) - (b.settingsOrder ?? 0))

  const usageStatusLabel = (provider: UsageSnapshot) => {
    if (!provider.enabled) return t('settings.usagePage.stateOff', { defaultValue: '已关闭查询' })
    if (provider.state === 'ok') return t('settings.usagePage.stateOk', { defaultValue: '已获取' })
    if (provider.networkSupported && !provider.networkAuthorized) {
      return t('settings.usagePage.stateNotAuthorized', { defaultValue: '未开启联网查询' })
    }
    if (provider.authStatus === 'authorized') return t('settings.usagePage.stateWaiting', { defaultValue: '正在查询' })
    if (provider.authStatus === 'missing') return t('settings.usagePage.stateNeedsLogin', { defaultValue: '需要先登录' })
    if (provider.implementationStatus === 'available') return t('settings.usagePage.stateAvailable', { defaultValue: '可以查询' })
    if (provider.implementationStatus === 'unsupported') return t('settings.usagePage.stateUnsupported', { defaultValue: '暂不支持查询' })
    return t('settings.usagePage.stateNeedsLogin', { defaultValue: '需要先登录' })
  }

  const networkRequestSummary = (provider: UsageSnapshot) => {
    const target = provider.networkTarget ?? ''
    const template = provider.networkKind === 'cli'
      ? t('settings.usageNetworkConfirmCli', {
        defaultValue: '让本机上的 {{target}} 自己去查一次额度。',
      })
      : t('settings.usageNetworkConfirmHttp', {
        defaultValue: '向 {{target}} 发出一次只读的额度查询。',
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
          {usageLoading ? t('settings.detecting', { defaultValue: '正在检查…' }) : t('settings.recheck', { defaultValue: '重新检查' })}
        </button>
      )}
      label={t('settings.accountQuota', { defaultValue: '各工具的额度查询' })}
    >
      {error && <div className="hook-error-card">{error}</div>}
      {notice && <div className="hook-notice-card">{notice}</div>}
      <SettingRow
        label={t('settings.usageQueryEnabled', { defaultValue: '在灵动岛显示额度' })}
        description={t('settings.usageQueryEnabledDesc', { defaultValue: '打开后，灵动岛顶部会显示剩余额度。下面每个工具的联网查询默认关闭，需要你逐个允许。' })}
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
              {loginReminder(provider) && (
                <div className="usage-provider-row__login-reminder" data-testid={`usage-login-reminder-${provider.provider}`}>
                  {loginReminder(provider)}
                </div>
              )}
              {provider.networkSupported ? (
                <div className="usage-provider-row__network" data-testid={`usage-network-${provider.provider}`}>
                  <span className="usage-provider-row__network-state">
                    {provider.networkAuthorized
                      ? t('settings.usageNetworkAuthorized', { defaultValue: '已开启联网查询' })
                      : t('settings.usageNetworkNotAuthorized', { defaultValue: '未开启联网查询（默认关闭）' })}
                  </span>
                </div>
              ) : provider.networkUnsupportedReason === 'unverified' ? (
                <div className="usage-provider-row__path" data-testid={`usage-network-unsupported-${provider.provider}`}>
                  {t('settings.usageNetworkUnsupported', { defaultValue: '这个工具暂不支持联网查询' })}
                </div>
              ) : null}
              <SettingDetails testId={`usage-provider-source-${provider.provider}`}>
                <div className="setting-details__row">
                  <span>{t('settings.usagePage.source', { defaultValue: '数据来源' })}</span>
                  <code>{provider.source ?? t('settings.usagePage.unknown', { defaultValue: '未知' })}</code>
                </div>
                {provider.detail && (
                  <div className="setting-details__row">
                    <span>{t('settings.usagePage.rawDetail', { defaultValue: '原始说明' })}</span>
                    <code>{provider.detail}</code>
                  </div>
                )}
                {provider.authPath && (
                  <div className="setting-details__row">
                    <span>{t('settings.usageNetworkCredential', { defaultValue: '会用到的登录信息' })}</span>
                    <code>{provider.authPath}</code>
                  </div>
                )}
              </SettingDetails>
            </div>
            <div className="usage-provider-row__actions">
              {provider.authPath && (
                <GlassButton variant="ghost" onClick={() => openSystemPath(provider.authPath!)}>
                  {t('settings.openCredential', { defaultValue: '打开登录信息文件' })}
                </GlassButton>
              )}
              {provider.networkSupported && (
                <Toggle
                  checked={provider.networkAuthorized}
                  disabled={busy}
                  ariaLabel={t('settings.usageNetworkToggle', {
                    name: provider.label,
                    defaultValue: '允许查询 {{name}} 的剩余额度',
                  })}
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
                    ? t('settings.authorizing', { defaultValue: '正在打开登录…' })
                    : t('settings.authorizeUsage', { name: provider.label, defaultValue: '登录 {{name}} 账号' })}
                </GlassButton>
              )}
            </div>
            {confirming && (
              <div className="usage-provider-row__confirm" data-testid={`usage-network-confirm-${provider.provider}`}>
                <p className="usage-provider-row__confirm-intro">
                  {t('settings.usageNetworkConfirmIntro', { defaultValue: '开启后，Vibe Board 会：' })}
                </p>
                <dl className="usage-provider-row__confirm-list">
                  <dt>{t('settings.usageNetworkRequest', { defaultValue: '会做什么' })}</dt>
                  <dd>{networkRequestSummary(provider)}</dd>
                  <dt>{t('settings.usageNetworkCredential', { defaultValue: '会用到的登录信息' })}</dt>
                  <dd className="usage-provider-row__path">
                    {provider.networkCredential
                      ?? t('settings.usageNetworkCredentialManaged', { defaultValue: '由这个工具自己保管，Vibe Board 不读取' })}
                  </dd>
                </dl>
                <p className="usage-provider-row__confirm-note">
                  {t('settings.usageNetworkConfirmNote', { defaultValue: '登录信息只用于这一次查询，不显示也不记录；你随时可以关掉。' })}
                </p>
                <div className="usage-provider-row__confirm-actions">
                  <GlassButton
                    variant="primary"
                    onClick={() => void applyNetworkAuthorization(provider.provider, true)}
                    disabled={busy}
                  >
                    {busy
                      ? t('settings.detecting', { defaultValue: '正在检查…' })
                      : t('settings.usageNetworkConfirmEnable', { defaultValue: '允许查询' })}
                  </GlassButton>
                  <GlassButton variant="ghost" onClick={() => setPendingAuthorization(null)} disabled={busy}>
                    {t('settings.usageNetworkCancel', { defaultValue: '取消' })}
                  </GlassButton>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </SettingGroup>
  )
}
