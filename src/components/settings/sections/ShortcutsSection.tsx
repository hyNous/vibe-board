import { useState, useEffect, useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useConfigStore } from '../../../stores/configStore'
import { formatShortcutKeyEvent, isRecordableShortcutEvent, shortcutDisplayParts } from '../../../utils/keyboardShortcuts'
import { registerGlobalShortcut } from '../../../services/tauriApi'
import { SettingDetails } from '../SettingDetails'
import { GlassInput } from '../../shared'
import './ShortcutsSection.css'

const PRIMARY_SHORTCUT_ACTIONS = new Set(['toggle-panel', 'collapse-panel', 'open-settings'])

function ShortcutRow({ action, label, keys }: { action: string; label: string; keys: string }) {
  const { t } = useTranslation()
  const [recording, setRecording] = useState(false)
  const [conflict, setConflict] = useState<string | null>(null)
  const updateShortcut = useConfigStore((s) => s.updateShortcut)
  const allShortcuts = useConfigStore((s) => s.shortcuts)

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!recording) return
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        setRecording(false)
        setConflict(null)
        return
      }
      if (!isRecordableShortcutEvent(e)) return
      const formatted = formatShortcutKeyEvent(e)
      if (formatted) {
        const duplicate = allShortcuts.find((s) => s.keys === formatted && s.action !== action)
        if (duplicate) {
          setConflict(t('settings.alreadyUsedBy', { label: duplicate.label }))
          return
        }
        setConflict(null)
        updateShortcut(action, formatted)
        setRecording(false)
      }
    },
    [recording, action, updateShortcut, allShortcuts, t],
  )

  useEffect(() => {
    if (recording) {
      window.addEventListener('keydown', handleKeyDown, true)
      return () => window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [recording, handleKeyDown])

  const hasKeys = Boolean(keys.trim())

  return (
    <div className="shortcut-row">
      <div className="shortcut-row__info">
        <div className="shortcut-row__label">{label}</div>
        {recording && conflict && (
          <div className="shortcut-row__conflict" role="status">{conflict}</div>
        )}
      </div>
      <div className="shortcut-row__meta">
        {recording ? (
          <span className="shortcut-row__rec">{t('settings.pressKeys')}</span>
        ) : (
          <span className="shortcut-row__keys">
            {hasKeys
              ? shortcutDisplayParts(keys).map((k, i) => (<kbd key={i}>{k}</kbd>))
              : <span className="shortcut-row__off">{t('settings.shortcutOff', { defaultValue: 'Not set' })}</span>}
          </span>
        )}
        <span className="shortcut-row__actions">
          <button type="button" className="vb-btn shortcut-row__edit" onClick={() => setRecording(!recording)}>
            {recording
              ? t('settings.cancel')
              : hasKeys
                ? t('settings.edit')
                : t('settings.shortcutSet', { defaultValue: 'Set' })}
          </button>
          {!recording && hasKeys && (
            <button type="button" className="vb-btn shortcut-row__clear" onClick={() => updateShortcut(action, '')}>
              {t('settings.shortcutClear', { defaultValue: 'Clear' })}
            </button>
          )}
        </span>
      </div>
    </div>
  )
}

export function ShortcutsSection() {
  const { t } = useTranslation()
  const shortcuts = useConfigStore((s) => s.shortcuts)
  const config = useConfigStore()
  const syncRequestRef = useRef(0)
  const [shortcutError, setShortcutError] = useState<string | null>(null)
  const [showAdvancedShortcuts, setShowAdvancedShortcuts] = useState(false)
  const primaryShortcuts = shortcuts.filter((shortcut) => PRIMARY_SHORTCUT_ACTIONS.has(shortcut.action))
  const advancedShortcuts = shortcuts.filter((shortcut) => !PRIMARY_SHORTCUT_ACTIONS.has(shortcut.action))
  const enabledAdvancedShortcutCount = advancedShortcuts.filter((shortcut) => shortcut.keys.trim()).length
  const latestShortcutDraft = config.globalShortcut
  const [shortcutDraftState, setShortcutDraftState] = useState(() => ({
    key: latestShortcutDraft,
    value: latestShortcutDraft,
  }))
  // Derive the draft during render so an external config change (or a failed
  // registration rollback) is reflected without a cascading effect.
  const shortcutDraft = shortcutDraftState.key === latestShortcutDraft
    ? shortcutDraftState.value
    : latestShortcutDraft
  const setShortcutDraft = (value: string) => setShortcutDraftState({ key: latestShortcutDraft, value })

  const formatShortcutError = (error: unknown) => {
    return error instanceof Error ? error.message : String(error)
  }

  const commitIslandShortcut = () => {
    const value = shortcutDraft.trim()
    if (value === config.globalShortcut) return
    const previous = config.globalShortcut
    config.updateConfig('globalShortcut', value)
    const requestId = ++syncRequestRef.current
    setShortcutError(null)
    registerGlobalShortcut(value).catch((error) => {
      if (requestId !== syncRequestRef.current) return
      config.updateConfig('globalShortcut', previous)
      setShortcutDraft(previous)
      setShortcutError(formatShortcutError(error))
    })
  }

  const commitOnEnter = (event: ReactKeyboardEvent<HTMLInputElement>, commit: () => void) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    commit()
  }

  return (
    <section className="shortcuts-page">
      <header className="shortcuts-page__head">
        <div>
          <h1>{t('settings.shortcutsTitle', { defaultValue: '快捷键' })}</h1>
          <p>{t('settings.shortcutsDesc', { defaultValue: '给常用操作配上键盘组合，不用鼠标也能操作灵动岛。' })}</p>
        </div>
      </header>

      <div className="shortcuts-page__group-title">
        {t('settings.globalShortcuts', { defaultValue: '全局快捷键（在任何窗口都生效）' })}
      </div>
      <div className="shortcuts-page__panel">
        <div className="shortcut-row">
          <div className="shortcut-row__info">
            <div className="shortcut-row__label">{t('settings.globalShortcut', { defaultValue: '显示或隐藏灵动岛' })}</div>
            <div className="shortcut-row__description">
              {t('settings.globalShortcutDesc', { defaultValue: '在任意窗口按下这个组合键，就能让灵动岛出现或收起。' })}
            </div>
          </div>
          <div className="shortcut-row__meta">
            <div className="shortcut-global-control">
              <GlassInput
                className="shortcut-global-control__input"
                value={shortcutDraft}
                onChange={(e) => setShortcutDraft(e.target.value)}
                onBlur={commitIslandShortcut}
                onKeyDown={(e) => commitOnEnter(e, commitIslandShortcut)}
                placeholder="CommandOrControl+Shift+I"
              />
            </div>
          </div>
        </div>
        {shortcutError && (
          <div className="shortcut-page__error" role="alert">
            <div>{t('settings.shortcutApplyFailed', { defaultValue: '这个组合键没能生效，可能已被系统或其它软件占用。' })}</div>
            <SettingDetails testId="shortcut-error-details">{shortcutError}</SettingDetails>
          </div>
        )}
      </div>

      <div className="shortcuts-page__group-title">
        {t('settings.inWindowShortcuts', { defaultValue: '面板内快捷键' })}
      </div>
      <div className="shortcuts-page__panel">
        {primaryShortcuts.map((s) => (
          <ShortcutRow
            key={s.action}
            action={s.action}
            label={t(`settings.shortcutActions.${s.action}`, { defaultValue: s.label })}
            keys={s.keys}
          />
        ))}
      </div>

      <div className="shortcuts-page__advanced">
        <button
          className="vb-btn"
          onClick={() => setShowAdvancedShortcuts((value) => !value)}
          type="button"
          aria-expanded={showAdvancedShortcuts}
        >
          <span>{showAdvancedShortcuts
            ? t('settings.hideAdvancedShortcuts', { defaultValue: 'Hide more shortcuts' })
            : t('settings.showAdvancedShortcuts', { defaultValue: 'Show more shortcuts' })}</span>
          <span className="shortcuts-page__advanced-count">
            {t('settings.enabledAdvancedShortcuts', {
              defaultValue: '{{count}} enabled',
              count: enabledAdvancedShortcutCount,
            })}
          </span>
        </button>
        {showAdvancedShortcuts && (
          <div className="shortcuts-page__panel shortcuts-page__panel--advanced">
            {advancedShortcuts.map((s) => (
              <ShortcutRow
                key={s.action}
                action={s.action}
                label={t(`settings.shortcutActions.${s.action}`, { defaultValue: s.label })}
                keys={s.keys}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
