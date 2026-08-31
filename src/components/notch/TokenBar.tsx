/* Token Bar — bottom bar with token counts and cache */
import { useTranslation } from 'react-i18next'
import type { TokenUsage } from '../../types/agent'
import { useConfigStore } from '../../stores/configStore'
import { formatTokens } from '../../utils/tokens'
import './TokenBar.css'

interface TokenBarProps {
  tokens: TokenUsage
}

export function TokenBar({ tokens }: TokenBarProps) {
  const { t } = useTranslation()
  const displayMode = useConfigStore((s) => s.tokenDisplayMode)

  const total = tokens.input + tokens.output
  if (total === 0 || displayMode === 'hidden') return null

  const cachePercent = tokens.input > 0
    ? Math.round((tokens.cacheRead / (tokens.input + tokens.cacheRead)) * 100)
    : 0

  return (
    <div className="token-bar">
      <span className="token-bar__counts">
        {formatTokens(tokens.input)} in · {formatTokens(tokens.output)} out
        {cachePercent > 0 && (
          <span className="token-bar__cache"> · {cachePercent}% {t('notch.cached')}</span>
        )}
      </span>
    </div>
  )
}
