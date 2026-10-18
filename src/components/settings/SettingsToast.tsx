import { useSettingsToast } from '../../stores/settingsToastStore'

export function SettingsToast() {
  const text = useSettingsToast((s) => s.text)
  const visible = useSettingsToast((s) => s.visible)
  return (
    <div className={`settings-toast${visible ? ' settings-toast--visible' : ''}`} role="status" aria-live="polite">
      {text}
    </div>
  )
}
