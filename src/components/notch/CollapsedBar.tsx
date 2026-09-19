/* Collapsed Bar — Pill-shaped header with pixel art, info, and controls */
import { useTranslation } from 'react-i18next'
import type { PanelState, RateLimitInfo, SessionState } from '../../types/agent'
import { computePriority, PRIORITY } from '../../types/priority'
import { MascotRouter } from './mascots'
import { TipDisplay } from './TipDisplay'
import { openSettingsWindow, quitApp } from '../../services/tauriApi'
import { useConfigStore } from '../../stores/configStore'
import { useUpdateStore } from '../../stores/updateStore'
import { sessionNeedsAttention } from '../../utils/islandInteraction'
import { statusFromSession } from '../../utils/agentRunState'
import { getAgentDisplayName } from '../../utils/sessionDisplay'
import { RateLimitBar } from './RateLimitBar'
import './CollapsedBar.css'

interface CollapsedBarProps {
  sessions: SessionState[]
  panelState: PanelState
  rateLimits?: RateLimitInfo
  usageSnapshots?: Record<string, RateLimitInfo>
  onCollapse: () => void
  isMicro?: boolean
  focusFilteredEmpty?: boolean
}

function getLeadSession(sessions: SessionState[]): SessionState | undefined {
  return [...sessions].sort((a, b) => computePriority(b) - computePriority(a))[0]
}

function usageProviderKey(agentType: SessionState['agentType'] | undefined): string | undefined {
  if (!agentType) return undefined
  if (agentType === 'claude-code') return 'claude-code'
  return agentType
}

function rateLimitsForSession(
  session: SessionState | undefined,
  usageSnapshots: Record<string, RateLimitInfo> | undefined,
): RateLimitInfo | undefined {
  const providerKey = usageProviderKey(session?.agentType)
  return (providerKey ? usageSnapshots?.[providerKey] : undefined) ?? session?.rateLimits
}

function selectEffectiveRateLimits(
  sessions: SessionState[],
  lead: SessionState | undefined,
  rateLimits: RateLimitInfo | undefined,
  usageSnapshots: Record<string, RateLimitInfo> | undefined,
): RateLimitInfo | undefined {
  const leadProviderKey = usageProviderKey(lead?.agentType)
  const providerMatchedGlobalRateLimits = !leadProviderKey || !rateLimits?.provider || rateLimits.provider === leadProviderKey
    ? rateLimits
    : undefined

  const leadRateLimits = rateLimitsForSession(lead, usageSnapshots)
    ?? providerMatchedGlobalRateLimits
  if (leadRateLimits) return leadRateLimits

  const fallbackSession = [...sessions]
    .filter((session) => usageProviderKey(session.agentType) !== leadProviderKey)
    .sort((a, b) => computePriority(b) - computePriority(a))
    .find((session) => rateLimitsForSession(session, usageSnapshots))

  return rateLimitsForSession(fallbackSession, usageSnapshots)
}

function runStatus(session: SessionState): NonNullable<SessionState['runState']>['status'] {
  return session.runState?.status ?? statusFromSession(session)
}

function isSessionExecuting(session: SessionState): boolean {
  const status = runStatus(session)
  return status === 'running' || status === 'starting' || session.phase === 'processing' || session.phase === 'compacting'
}

function getExecutingSession(sessions: SessionState[]): SessionState | undefined {
  const executingSessions = sessions.filter(isSessionExecuting)
  if (executingSessions.length === 0) return undefined
  return [...executingSessions].sort((a, b) => computePriority(b) - computePriority(a))[0]
}

export function CollapsedBar({ sessions, panelState, rateLimits, usageSnapshots, onCollapse, isMicro, focusFilteredEmpty = false }: CollapsedBarProps) {
  const { t } = useTranslation()
  const showUsageQuota = useConfigStore((s) => s.showUsageQuota)
  const usageQueryEnabled = useConfigStore((s) => s.usageQueryEnabled)
  const tipsEnabled = useConfigStore((s) => s.tipsEnabled)

  const lead = getLeadSession(sessions)
  const executingSession = getExecutingSession(sessions)

  const count = sessions.length
  const isExpanded = panelState !== 'collapsed'
  const updateAvailable = useUpdateStore((s) => s.availableVersion)
  const workingCount = sessions.filter(isSessionExecuting).length
  const waitingCount = sessions.filter(sessionNeedsAttention).length
  const allIdle = sessions.length > 0 && sessions.every(s => computePriority(s) <= PRIORITY.idle)
  const showTips = tipsEnabled && (sessions.length === 0 || allIdle)

  const effectiveRateLimits = selectEffectiveRateLimits(sessions, lead, rateLimits, usageSnapshots)
  const shouldShowUsageQuota = usageQueryEnabled && showUsageQuota && Boolean(effectiveRateLimits)

  const renderMascot = (session: SessionState | undefined, size: number) => {
    if (!session || !session.agentType) {
      return (
        <span className="collapsed-bar__idle-logo-wrap" style={{ width: size, height: size }} aria-label="Vibe Board">
          <img className="collapsed-bar__idle-logo" src="/vibe-board-app-icon.png" alt="Vibe Board" />
        </span>
      )
    }

    const agentName = getAgentDisplayName(session)

    return (
      <span className="collapsed-bar__agent-wrap" title={agentName} aria-label={agentName} data-agent={session.agentType}>
        <MascotRouter
          toolType={session.agentType}
          phase={session.phase === 'processing' || runStatus(session) === 'running' ? 'processing' : (session.phase || 'idle')}
          size={size}
        />
      </span>
    )
  }

  async function openSettings(e: React.MouseEvent) {
    e.stopPropagation()
    onCollapse()
    try {
      await openSettingsWindow()
    } catch (err) {
      console.error('[settings] Failed to open settings window:', err)
    }
  }

  if (isMicro) {
    return (
      <div className="collapsed-bar collapsed-bar--micro">
        <div className="collapsed-bar__micro-main">
          {renderMascot(executingSession, 22)}
        </div>
      </div>
    )
  }

  return (
    <div className={`collapsed-bar ${isExpanded ? 'collapsed-bar--expanded' : ''}`} onClick={panelState === 'expanded' ? onCollapse : undefined}>
      {/* Top row: rate limits (left) + icons (right) — only in expanded */}
      {isExpanded && (
        <div className="collapsed-bar__status-row">
          <div className="collapsed-bar__left" style={{ gap: 8 }}>
            {renderMascot(executingSession, 20)}
            {shouldShowUsageQuota && effectiveRateLimits && panelState !== 'hover' ? (
              <RateLimitBar rateLimits={effectiveRateLimits} />
            ) : (
              <div className="collapsed-bar__counter-pills">
                <span className={`collapsed-bar__counter-pill${count > 0 ? ' collapsed-bar__counter-pill--active' : ''}`}>
                  <span>ALL</span><span className="collapsed-bar__counter-pill-val">{count}</span>
                </span>
                <span className={`collapsed-bar__counter-pill${workingCount > 0 ? ' collapsed-bar__counter-pill--active collapsed-bar__counter-pill--act' : ''}`}>
                  <span>ACT</span><span className="collapsed-bar__counter-pill-val">{workingCount}</span>
                </span>
                <span className={`collapsed-bar__counter-pill${waitingCount > 0 ? ' collapsed-bar__counter-pill--active collapsed-bar__counter-pill--wait' : ''}`}>
                  <span>WAIT</span><span className="collapsed-bar__counter-pill-val">{waitingCount}</span>
                </span>
              </div>
            )}
          </div>
          {showTips && !focusFilteredEmpty && (
            <div className="collapsed-bar__header-tip">
              <TipDisplay show />
            </div>
          )}
          <div className="collapsed-bar__icons">
            <span className="collapsed-bar__esc-hint">ESC</span>
            <button
              className="collapsed-bar__icon-btn"
              title={updateAvailable ? t('notch.updateAvailable', { version: updateAvailable }) : t('notch.settings')}
              onClick={openSettings}
            >
              <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
                <path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" fill="currentColor"/>
                <path fillRule="evenodd" clipRule="evenodd" d="M8.5 1.5A1.5 1.5 0 007 3v.34a1.1 1.1 0 01-.65.99l-.12.05a1.1 1.1 0 01-1.18-.16l-.24-.2a1.5 1.5 0 00-2.12.13l-.7.77a1.5 1.5 0 00.12 2.12l.2.18c.37.34.5.86.34 1.34l-.04.12a1.1 1.1 0 01-1.04.72H1.5A1.5 1.5 0 000 10.5v1A1.5 1.5 0 001.5 13h.07a1.1 1.1 0 011.04.72l.04.12c.16.48.03 1-.34 1.34l-.2.18a1.5 1.5 0 00-.12 2.12l.7.77a1.5 1.5 0 002.12.13l.24-.2a1.1 1.1 0 011.18-.16l.12.05c.39.18.65.57.65.99V19.5A1.5 1.5 0 008.5 21h1a1.5 1.5 0 001.5-1.5v-.34a1.1 1.1 0 01.65-.99l.12-.05a1.1 1.1 0 011.18-.16l.24.2a1.5 1.5 0 002.12-.13l.7-.77a1.5 1.5 0 00-.12-2.12l-.2-.18a1.1 1.1 0 01-.34-1.34l.04-.12a1.1 1.1 0 011.04-.72h.07A1.5 1.5 0 0020 11.5v-1a1.5 1.5 0 00-1.5-1.5h-.07a1.1 1.1 0 01-1.04-.72l-.04-.12a1.1 1.1 0 01.34-1.34l.2-.18a1.5 1.5 0 00.12-2.12l-.7-.77a1.5 1.5 0 00-2.12-.13l-.24.2a1.1 1.1 0 01-1.18.16l-.12-.05A1.1 1.1 0 0111 3.34V3a1.5 1.5 0 00-1.5-1.5h-1zM10 14a4 4 0 100-8 4 4 0 000 8z" fill="currentColor"/>
              </svg>
              {updateAvailable && <span className="collapsed-bar__update-dot" aria-hidden="true" />}
            </button>
            <button
              className="collapsed-bar__icon-btn collapsed-bar__icon-btn--quit"
              title={t('notch.quit')}
              onClick={(e) => {
                e.stopPropagation()
                quitApp()
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path d="M9 4H6a2 2 0 00-2 2v12a2 2 0 002 2h3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M16 17l5-5-5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M21 12H9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Main row: only in collapsed state — show only the Vibe Board icon when no task is in progress, or the executing Agent name */}
      {!isExpanded && (
        <div className="collapsed-bar__main collapsed-bar__main--closed">
          {renderMascot(executingSession, 22)}
          {executingSession && (
            <span className="collapsed-bar__agent-name" title={getAgentDisplayName(executingSession)}>
              {getAgentDisplayName(executingSession)}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
