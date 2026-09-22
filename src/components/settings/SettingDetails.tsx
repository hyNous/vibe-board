import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import './SettingDetails.css'

interface SettingDetailsProps {
  testId: string
  label?: string
  className?: string
  children: ReactNode
}

/**
 * Technical details (paths, versions, counts, raw error text) stay behind this
 * fold so the default view keeps only what a user needs to decide something.
 */
export function SettingDetails({ testId, label, className, children }: SettingDetailsProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  return (
    <div className={`setting-details${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        className="setting-details__toggle"
        data-testid={testId}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="setting-details__chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
        {label ?? t('settings.details', { defaultValue: '详情' })}
      </button>
      {open && (
        <div className="setting-details__body" data-testid={`${testId}-body`}>
          {children}
        </div>
      )}
    </div>
  )
}
