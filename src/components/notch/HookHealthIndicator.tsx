import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  isTauri,
  reinstallAllHooks,
  runHookDoctor,
  type HookDoctorCheck,
  type HookDoctorReport,
} from '../../services/tauriApi'
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

// The hook settings page is gone: the island only surfaces a health indicator
// when the self-check reports a problem, and the panel exposes the same
// diagnostics plus the one-click reinstall.
export function HookHealthIndicator() {
  const { t } = useTranslation()
  const [report, setReport] = useState<HookDoctorReport | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

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
    try {
      const errors = await reinstallAllHooks()
      setNotice(errors.length > 0
        ? t('settings.hookHealth.repairFailed', {
          defaultValue: '部分 Hook 重新安装失败：{{errors}}',
          errors: errors.join('；'),
        })
        : t('settings.hookHealth.repairDone', { defaultValue: '已重新安装 Hook，请重启对应 CLI 会话。' }))
      await refresh()
    } catch (error) {
      setNotice(readableError(error))
    } finally {
      setBusy(false)
    }
  }

  const triggerLabel = failures.length > 0
    ? t('settings.hookHealth.trigger', {
      defaultValue: '{{count}} 项 Hook 自检未通过',
      count: failures.length,
    })
    : t('settings.hookHealth.title', { defaultValue: 'Hook 自检' })

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
        <div className="hook-health__panel" role="dialog" aria-label={t('settings.hookHealth.title', { defaultValue: 'Hook 自检' })}>
          <div className="hook-health__head">
            <strong>{t('settings.hookHealth.title', { defaultValue: 'Hook 自检' })}</strong>
            <button type="button" className="hook-health__close" aria-label={t('settings.close', { defaultValue: 'Close' })} onClick={toggleOpen}>×</button>
          </div>
          <div className="hook-health__checks">
            {report.checks.map((check) => (
              <div
                className={`hook-health__check hook-health__check--${check.status}`}
                key={check.id}
                data-testid={`hook-health-check-${check.id}`}
              >
                <span className="hook-health__status">{check.status.toUpperCase()}</span>
                <div className="hook-health__check-body">
                  <strong>{check.label}</strong>
                  <span>{check.detail}</span>
                </div>
              </div>
            ))}
          </div>
          {notice && <div className="hook-health__notice" role="status">{notice}</div>}
          <div className="hook-health__actions">
            <button type="button" className="hook-health__action" onClick={() => void refresh()} disabled={busy}>
              {t('settings.hookHealth.refresh', { defaultValue: '重新检测' })}
            </button>
            <button type="button" className="hook-health__action hook-health__action--primary" onClick={() => void repair()} disabled={busy}>
              {busy
                ? t('settings.hookHealth.repairing', { defaultValue: '正在重新安装…' })
                : t('settings.hookHealth.repair', { defaultValue: '一键修复（重新安装）' })}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
