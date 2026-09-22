import { useState, useEffect, useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useConfigStore } from '../../../stores/configStore'
import { formatShortcutKeyEvent, isRecordableShortcutEvent, shortcutDisplayParts } from '../../../utils/keyboardShortcuts'
import { registerGlobalShortcut } from '../../../services/tauriApi'
import { SettingSection } from '../SettingSection'
import { SettingGroup } from '../SettingGroup'
import { SettingRow } from '../SettingRow'
import { SettingDetails } from '../SettingDetails'
import { GlassInput } from '../../shared'

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

  return (
    <div className="shortcuts-row">
      <span className="shortcuts-row__action">{label}</span>
      <span className="shortcuts-row__meta">
        {recording ? (
          <span className="shortcuts-row__recording">
            {conflict ? <span className="shortcuts-row__conflict">{conflict}</span> : t('settings.pressKeys')}
          </span>
        ) : (
          <span className="shortcuts-row__keys">
            {keys.trim()
              ? shortcutDisplayParts(keys).map((k, i) => (<kbd key={i}>{k}</kbd>))
              : <span className="shortcuts-row__off">{t('settings.shortcutOff', { defaultValue: 'Off' })}</span>}
          </span>
        )}
        <span className="shortcuts-row__actions">
          {!recording && keys.trim() && (
            <button className="shortcuts-row__edit shortcuts-row__clear" onClick={() => updateShortcut(action, '')}>
              {t('settings.shortcutClear', { defaultValue: 'Clear' })}
            </button>
          )}
          <button className="shortcuts-row__edit" onClick={() => setRecording(!recording)}>
            {recording ? t('settings.cancel') : t('settings.edit')}
          </button>
        </span>
      </span>
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
    <SettingSection
      title={t('settings.shortcutsTitle', { defaultValue: '快捷键' })}
      description={t('settings.shortcutsDesc', { defaultValue: '给常用操作配上键盘组合键，不用鼠标也能操作灵动岛。' })}
    >
      <SettingGroup label={t('settings.globalShortcuts', { defaultValue: '全局快捷键（在任何窗口都生效）' })}>
        <SettingRow
          label={t('settings.globalShortcut', { defaultValue: '显示或隐藏灵动岛' })}
          description={t('settings.globalShortcutDesc', { defaultValue: '在任意窗口按下这个组合键，就能让灵动岛出现或收起。' })}
        >
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
        </SettingRow>
        {shortcutError && (
          <div className="shortcut-status shortcut-status--error" role="alert">
            <div>{t('settings.shortcutApplyFailed', { defaultValue: '这个组合键没能生效，可能已被系统或其它软件占用。' })}</div>
            <SettingDetails testId="shortcut-error-details">{shortcutError}</SettingDetails>
          </div>
        )}
      </SettingGroup>
      <SettingGroup label={t('settings.inWindowShortcuts', { defaultValue: '面板内快捷键' })}>
        <div className="shortcuts-table">
          {primaryShortcuts.map((s) => (
            <ShortcutRow
              key={s.action}
              action={s.action}
              label={t(`settings.shortcutActions.${s.action}`, { defaultValue: s.label })}
              keys={s.keys}
            />
          ))}
        </div>
        <div className="shortcuts-advanced">
          <button
            className="shortcuts-advanced__toggle"
            onClick={() => setShowAdvancedShortcuts((value) => !value)}
            type="button"
          >
            <span>{showAdvancedShortcuts
              ? t('settings.hideAdvancedShortcuts', { defaultValue: 'Hide advanced shortcuts' })
              : t('settings.showAdvancedShortcuts', { defaultValue: 'Show advanced shortcuts' })}</span>
            <span className="shortcuts-advanced__count">
              {t('settings.enabledAdvancedShortcuts', {
                defaultValue: '{{count}} enabled',
                count: enabledAdvancedShortcutCount,
              })}
            </span>
          </button>
          {showAdvancedShortcuts && (
            <div className="shortcuts-table shortcuts-table--advanced">
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
      </SettingGroup>
    </SettingSection>
  )
}
