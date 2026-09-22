import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  isTauri,
  reinstallAllHooks,
  runHookDoctor,
  type HookDoctorCheck,
  type HookDoctorReport,
} from '../../services/tauriApi'
import { SettingDetails } from '../settings/SettingDetails'
import './HookHealthIndicator.css'

function readableError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message)
  }
  return String(error)
}

function isFailingCheck(check: HookDoctorCheck): boolean {
  return check.status === 'warn' || check.status === 'error'
}

type Translate = (key: string, options?: { defaultValue?: string; count?: number; name?: string }) => string

/**
 * Check labels and details come from the backend in English and can contain
 * paths and versions. The panel shows this friendly layer by default; the raw
 * text stays available behind the details fold.
 */
function checkTitle(t: Translate, check: HookDoctorCheck): string {
  switch (check.id) {
    case 'installed-hooks': return t('settings.hookHealth.checkInstalledHooks', { defaultValue: 'Agent 的事件通知' })
    case 'bridge-binary': return t('settings.hookHealth.checkBridgeBinary', { defaultValue: '通知组件文件' })
    case 'bridge-current': return t('settings.hookHealth.checkBridgeCurrent', { defaultValue: '通知组件版本' })
    case 'hook-server':
    case 'hook-server-tcp': return t('settings.hookHealth.checkServer', { defaultValue: '通知接收服务' })
    case 'bridge-invocations': return t('settings.hookHealth.checkInvocations', { defaultValue: '最近收到的通知' })
    case 'hook-profile-health': return t('settings.hookHealth.checkCoverage', { defaultValue: '事件覆盖范围' })
    case 'automation-permission': return t('settings.hookHealth.checkAutomation', { defaultValue: 'macOS 自动化权限' })
    case 'platform-integration': return t('settings.hookHealth.checkPlatform', { defaultValue: '系统通知通道' })
    case 'claude-bare-mode': return t('settings.hookHealth.checkBareMode', { defaultValue: 'Claude Code 运行模式' })
    case 'optional-terminals': return t('settings.hookHealth.checkOptionalTerminals', { defaultValue: '可选的终端工具' })
    default:
      if (check.id.startsWith('hook-profile-')) return t('settings.hookHealth.checkProfile', { defaultValue: '某个 Agent 的事件通知' })
      if (check.id.startsWith('codex-')) return t('settings.hookHealth.checkCodex', { defaultValue: 'Codex 实时同步' })
      if (check.id.startsWith('binary-')) {
        return t('settings.hookHealth.checkBinary', { defaultValue: '{{name}} 程序', name: check.id.slice('binary-'.length) })
      }
      return t('settings.hookHealth.checkOther', { defaultValue: '其它检查项' })
  }
}

function statusWord(t: Translate, status: HookDoctorCheck['status']): string {
  switch (status) {
    case 'ok': return t('settings.hookHealth.statusOk', { defaultValue: '正常' })
    case 'warn': return t('settings.hookHealth.statusWarn', { defaultValue: '需要处理' })
    case 'error': return t('settings.hookHealth.statusError', { defaultValue: '异常' })
    default: return t('settings.hookHealth.statusInfo', { defaultValue: '提示' })
  }
}

function checkSummary(t: Translate, check: HookDoctorCheck): string {
  if (!isFailingCheck(check)) return t('settings.hookHealth.summaryOk', { defaultValue: '这项没有问题。' })
  switch (check.id) {
    case 'installed-hooks':
      return t('settings.hookHealth.summaryInstalledHooks', { defaultValue: '有 Agent 的事件通知需要重新安装。' })
    case 'bridge-binary':
      return t('settings.hookHealth.summaryBridgeBinary', { defaultValue: '通知组件文件缺失，点「重新连接」可以修复。' })
    case 'bridge-current':
      return t('settings.hookHealth.summaryBridgeCurrent', { defaultValue: '通知组件是旧版本，点「重新连接」可以更新。' })
    case 'hook-server':
    case 'hook-server-tcp':
      return t('settings.hookHealth.summaryServer', { defaultValue: '通知接收服务没有响应，重启 Vibe Board 后会自动恢复。' })
    case 'hook-profile-health':
      return t('settings.hookHealth.summaryCoverage', { defaultValue: '有 Agent 的事件通知需要重新安装。' })
    case 'automation-permission':
      return t('settings.hookHealth.summaryAutomation', { defaultValue: '缺少 macOS 自动化权限，点任务可能无法唤回终端窗口。' })
    default:
      if (check.id.startsWith('hook-profile-')) {
        return t('settings.hookHealth.summaryProfile', { defaultValue: '这个 Agent 的事件通知需要重新安装。' })
      }
      return t('settings.hookHealth.summaryOther', { defaultValue: '这一项需要处理，展开详情可以看到具体原因。' })
  }
}

// The hook settings page is gone: the island only surfaces a health indicator
// when the self-check reports a problem, and the panel exposes the same
// diagnostics plus the one-click reinstall.
export function HookHealthIndicator() {
  const { t } = useTranslation()
  const [report, setReport] = useState<HookDoctorReport | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [noticeDetails, setNoticeDetails] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!isTauri()) return
    try {
      setReport(await runHookDoctor())
    } catch (error) {
      setReport({
        generatedAt: Math.floor(Date.now() / 1000),
        checks: [{ id: 'doctor-error', label: 'Hook Doctor', status: 'error', detail: readableError(error) }],
      })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const failures = report?.checks.filter(isFailingCheck) ?? []
  // Stay mounted while the panel is open so a successful repair can report back
  // before the indicator disappears again.
  if (!report || (failures.length === 0 && !open)) return null

  const toggleOpen = () => {
    const next = !open
    setOpen(next)
    if (next) void refresh()
  }

  const repair = async () => {
    setBusy(true)
    setNotice(null)
    setNoticeDetails(null)
    try {
      const errors = await reinstallAllHooks()
      setNotice(errors.length > 0
        ? t('settings.hookHealth.repairFailed', {
          defaultValue: '有几项没能自动修复，请在详情里查看原因，或重启对应的 Agent。',
        })
        : t('settings.hookHealth.repairDone', { defaultValue: '已重新连接，请重启对应的 Agent 会话。' }))
      if (errors.length > 0) setNoticeDetails(errors.join('\n'))
      await refresh()
    } catch (error) {
      setNotice(t('settings.hookHealth.repairFailed', {
        defaultValue: '有几项没能自动修复，请在详情里查看原因，或重启对应的 Agent。',
      }))
      setNoticeDetails(readableError(error))
    } finally {
      setBusy(false)
    }
  }

  const triggerLabel = failures.length > 0
    ? t('settings.hookHealth.trigger', {
      defaultValue: '{{count}} 项通知检查未通过',
      count: failures.length,
    })
    : t('settings.hookHealth.title', { defaultValue: '事件通知检查' })

  return (
    <div className="hook-health" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        className="hook-health__trigger"
        aria-label={triggerLabel}
        aria-expanded={open}
        title={triggerLabel}
        onClick={toggleOpen}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 4 2.5 20h19L12 4Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M12 10v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="12" cy="17" r="1" fill="currentColor" />
        </svg>
        {failures.length > 0 && <span className="hook-health__count">{failures.length}</span>}
      </button>

      {open && (
        <div className="hook-health__panel" role="dialog" aria-label={t('settings.hookHealth.title', { defaultValue: '事件通知检查' })}>
          <div className="hook-health__head">
            <strong>{t('settings.hookHealth.title', { defaultValue: '事件通知检查' })}</strong>
            <button type="button" className="hook-health__close" aria-label={t('settings.close', { defaultValue: '关闭' })} onClick={toggleOpen}>×</button>
          </div>
          <p className="hook-health__intro">
            {t('settings.hookHealth.intro', { defaultValue: '检查 Agent 的任务状态能不能送到看板。展开详情可以看到排查用的原始信息。' })}
          </p>
          <div className="hook-health__checks">
            {report.checks.map((check) => (
              <div
                className={`hook-health__check hook-health__check--${check.status}`}
                key={check.id}
                data-testid={`hook-health-check-${check.id}`}
              >
                <span className="hook-health__status">{statusWord(t, check.status)}</span>
                <div className="hook-health__check-body">
                  <strong>{checkTitle(t, check)}</strong>
                  <span>{checkSummary(t, check)}</span>
                </div>
              </div>
            ))}
          </div>
          <SettingDetails testId="hook-health-raw-details" label={t('settings.hookHealth.rawDetails', { defaultValue: '详情（排查用）' })}>
            <ul className="hook-health__raw-list">
              {report.checks.map((check) => (
                <li key={check.id}>
                  <strong>{check.label}</strong>
                  <code>{check.detail}</code>
                </li>
              ))}
            </ul>
          </SettingDetails>
          {notice && <div className="hook-health__notice" role="status">{notice}</div>}
          {noticeDetails && (
            <SettingDetails testId="hook-health-repair-details">{noticeDetails}</SettingDetails>
          )}
          <div className="hook-health__actions">
            <button type="button" className="hook-health__action" onClick={() => void refresh()} disabled={busy}>
              {t('settings.hookHealth.refresh', { defaultValue: '重新检查' })}
            </button>
            <button type="button" className="hook-health__action hook-health__action--primary" onClick={() => void repair()} disabled={busy}>
              {busy
                ? t('settings.hookHealth.repairing', { defaultValue: '正在重新连接…' })
                : t('settings.hookHealth.repair', { defaultValue: '重新连接' })}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
