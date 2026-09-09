/* Collapsed Bar — Pill-shaped header with pixel art, info, and controls */
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { PanelState, RateLimitInfo, SessionState } from '../../types/agent'
import { computePriority, PRIORITY } from '../../types/priority'
import { MascotRouter } from './mascots'
import { TipDisplay } from './TipDisplay'
import { useTick } from '../../hooks/useTick'
import { openSettingsWindow, quitApp } from '../../services/tauriApi'
import { useConfigStore } from '../../stores/configStore'
import { useUpdateStore } from '../../stores/updateStore'
import { isDarkColorTheme, useThemeStore } from '../../stores/themeStore'
import { sessionNeedsAttention } from '../../utils/islandInteraction'
import { getStringField, parseToolInput } from '../../utils/permissionPreview'
import { getToolActivityLabel } from '../../utils/toolLabels'
import { statusFromSession } from '../../utils/agentRunState'
import { getSessionTitle } from '../../utils/sessionDisplay'
import { RateLimitBar } from './RateLimitBar'
import { SpriteCanvas } from './SpriteCanvas'
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

const PATH_TARGET_TOOLS = new Set([
  'Read',
  'ReadFile',
  'Edit',
  'EditFile',
  'Write',
  'WriteFile',
  'Glob',
  'GlobSearch',
  'Grep',
  'GrepGrep',
  'GrepGlob',
  'NotebookEdit',
])

function basename(value: string): string {
  const normalized = value.trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  return parts.at(-1) || normalized
}

function getCompactToolTarget(toolName: string, target: string): string {
  if (PATH_TARGET_TOOLS.has(toolName) || target.includes('/') || target.includes('\\')) {
    return basename(target)
  }
  return target
}

type WaitingSummary = {
  label: string
  project: string
  target?: string
  toolName?: string
}

function getWaitingSummary(session: SessionState, t: (key: string, options?: Record<string, unknown>) => string): WaitingSummary | null {
  const project = session.project || 'Session'
  const status = runStatus(session)

  if (session.pendingPermission || status === 'waiting_permission' || session.phase === 'waiting_approval') {
    const toolName = session.pendingPermission?.toolName || session.runState?.currentAction
    const parsedInput = parseToolInput(session.pendingPermission?.toolInput)
    const target = session.pendingPermission?.diff?.filePath
      || getStringField(parsedInput, ['file_path', 'filePath', 'path', 'url', 'command', 'query', 'pattern', 'raw'])
    const approvalLabel = t('notch.needsApproval', { defaultValue: 'Needs approval' })
    return {
      project,
      label: toolName ? `${approvalLabel}: ${getToolActivityLabel(t, toolName)}` : approvalLabel,
      target,
      toolName,
    }
  }

  if (session.pendingQuestion || status === 'waiting_input' || session.phase === 'waiting_input') {
    return {
      project,
      label: t('notch.waitingInput', { defaultValue: 'Waiting for input' }),
      target: session.pendingQuestion?.question,
    }
  }

  return null
}

function CollapsedWaitingStatus({ summary }: { summary: WaitingSummary }) {
  const compactTarget = summary.target
    ? summary.toolName
      ? getCompactToolTarget(summary.toolName, summary.target)
      : summary.target
    : undefined

  return (
    <span className="collapsed-bar__waiting-inline" title={summary.target ? `${summary.project} · ${summary.label}: ${summary.target}` : `${summary.project} · ${summary.label}`}>
      <span className="collapsed-bar__waiting-project">{summary.project}</span>
      <span className="collapsed-bar__waiting-dot" />
      <span className="collapsed-bar__waiting-label">{summary.label}</span>
      {compactTarget && <span className="collapsed-bar__waiting-target">{compactTarget}</span>}
    </span>
  )
}

function getUnattendedLevel(unattendedSince: number | undefined): 'none' | 'amber' | 'red' {
  if (!unattendedSince) return 'none'
  const elapsed = Date.now() - unattendedSince
  if (elapsed >= 60000) return 'red'
  if (elapsed >= 30000) return 'amber'
  return 'none'
}

function formatElapsed(unattendedSince: number | undefined): string {
  if (!unattendedSince) return ''
  const secs = Math.floor((Date.now() - unattendedSince) / 1000)
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return s > 0 ? `${m}m${s}s` : `${m}m`
}

export function CollapsedBar({ sessions, panelState, rateLimits, usageSnapshots, onCollapse, isMicro, focusFilteredEmpty = false }: CollapsedBarProps) {
  const { t } = useTranslation()
  const showUsageQuota = useConfigStore((s) => s.showUsageQuota)
  const usageQueryEnabled = useConfigStore((s) => s.usageQueryEnabled)
  const tipsEnabled = useConfigStore((s) => s.tipsEnabled)
  const activeTheme = useThemeStore((s) => s.activeTheme)
  const colorTheme = useThemeStore((s) => s.colorTheme)
  const brandLogoSrc = isDarkColorTheme(colorTheme) ? '/vibe-board-logo-dark.png' : '/vibe-board-logo.png'

  const lead = getLeadSession(sessions)
  useTick(1000, Boolean(lead?.unattendedSince))
  const currentTitle = lead ? getSessionTitle(lead) : ''
  const waitingSummary = lead ? getWaitingSummary(lead, t) : null

  const count = sessions.length
  const isExpanded = panelState !== 'collapsed'
  const updateAvailable = useUpdateStore((s) => s.availableVersion)
  const alertCount = sessions.filter(s => computePriority(s) >= PRIORITY.attention).length
  const workingCount = sessions.filter(s => runStatus(s) === 'running').length
  const waitingCount = sessions.filter(sessionNeedsAttention).length
  const allIdle = sessions.length > 0 && sessions.every(s => computePriority(s) <= PRIORITY.idle)
  const showTips = tipsEnabled && (sessions.length === 0 || allIdle)
  const emptyText = focusFilteredEmpty ? t('notch.noSessionInFocus') : t('notch.waitingForSessions')
  const showBrandEmpty = sessions.length === 0 && !focusFilteredEmpty && !showTips
  const isYolo = lead?.isYoloMode
  const hasError = lead ? runStatus(lead) === 'error' : false
  const effectiveRateLimits = selectEffectiveRateLimits(sessions, lead, rateLimits, usageSnapshots)
  const shouldShowUsageQuota = usageQueryEnabled && showUsageQuota && Boolean(effectiveRateLimits)
  const ratePct = shouldShowUsageQuota ? effectiveRateLimits?.fiveHourUsage : undefined
  const rateColor = ratePct != null
    ? ratePct > 80 ? 'var(--island-danger-text)' : ratePct > 50 ? 'var(--island-warning-text)' : 'var(--island-success-text)'
    : undefined

  const unattendedLevel = getUnattendedLevel(lead?.unattendedSince)
  const elapsedText = unattendedLevel !== 'none' ? formatElapsed(lead?.unattendedSince) : ''
  const renderMascot = (session: SessionState | undefined, size: number) => {
    if (!session || !session.agentType) {
      return (
        <span className="collapsed-bar__idle-logo-wrap" style={{ width: size, height: size }} aria-hidden="true">
          <img className="collapsed-bar__idle-logo" src="/vibe-board-app-icon.png" alt="" />
        </span>
      )
    }

    if (activeTheme.character) {
      return (
        <span className="collapsed-bar__theme-avatar" style={{ width: size, height: size }}>
          <SpriteCanvas
            priority={computePriority(session)}
            size={size}
            theme={activeTheme}
          />
        </span>
      )
    }

    return <MascotRouter toolType={session.agentType} phase={session.phase || 'idle'} size={size} />
  }

  const settingsButtonRef = useRef<HTMLButtonElement>(null)
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
          {workingCount > 0 && lead
            ? renderMascot(lead, 22)
            : renderMascot(undefined, 22)}
          <span className="collapsed-bar__micro-count">{count}</span>
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
            {workingCount > 0 && lead
              ? renderMascot(lead, 20)
              : renderMascot(undefined, 20)}
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
              title={t('notch.settings')}
              onClick={openSettings}
            >
              <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
                <path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" fill="currentColor"/>
                <path fillRule="evenodd" clipRule="evenodd" d="M8.5 1.5A1.5 1.5 0 007 3v.34a1.1 1.1 0 01-.65.99l-.12.05a1.1 1.1 0 01-1.18-.16l-.24-.2a1.5 1.5 0 00-2.12.13l-.7.77a1.5 1.5 0 00.12 2.12l.2.18c.37.34.5.86.34 1.34l-.04.12a1.1 1.1 0 01-1.04.72H1.5A1.5 1.5 0 000 10.5v1A1.5 1.5 0 001.5 13h.07a1.1 1.1 0 011.04.72l.04.12c.16.48.03 1-.34 1.34l-.2.18a1.5 1.5 0 00-.12 2.12l.7.77a1.5 1.5 0 002.12.13l.24-.2a1.1 1.1 0 011.18-.16l.12.05c.39.18.65.57.65.99V19.5A1.5 1.5 0 008.5 21h1a1.5 1.5 0 001.5-1.5v-.34a1.1 1.1 0 01.65-.99l.12-.05a1.1 1.1 0 011.18.16l.24.2a1.5 1.5 0 002.12-.13l.7-.77a1.5 1.5 0 00-.12-2.12l-.2-.18a1.1 1.1 0 01-.34-1.34l.04-.12a1.1 1.1 0 011.04-.72h.07A1.5 1.5 0 0020 11.5v-1a1.5 1.5 0 00-1.5-1.5h-.07a1.1 1.1 0 01-1.04-.72l-.04-.12a1.1 1.1 0 01.34-1.34l.2-.18a1.5 1.5 0 00.12-2.12l-.7-.77a1.5 1.5 0 00-2.12-.13l-.24.2a1.1 1.1 0 01-1.18.16l-.12-.05A1.1 1.1 0 0111 3.34V3a1.5 1.5 0 00-1.5-1.5h-1zM10 14a4 4 0 100-8 4 4 0 000 8z" fill="currentColor"/>
              </svg>
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

      {/* Main row: mascot + carousel info + unattended + count */}
      {!isExpanded && (
      <div className="collapsed-bar__main">
        <div className="collapsed-bar__left">
          {lead ? (
            <>
              {workingCount > 0 && lead
                ? renderMascot(lead, 22)
                : renderMascot(undefined, 22)}
              <div className="collapsed-bar__carousel">
                {waitingSummary ? (
                  <CollapsedWaitingStatus summary={waitingSummary} />
                ) : showTips ? (
                  <TipDisplay show />
                ) : (
                  <span className="collapsed-bar__info">{currentTitle}</span>
                )}
              </div>
            </>
          ) : (
            <>
              {showBrandEmpty ? (
                <div className="collapsed-bar__brand-empty" aria-label={`Vibe Board, ${t('notch.slogan')}`}>
                  <img className="collapsed-bar__brand-logo" src={brandLogoSrc} alt="" aria-hidden="true" />
                  <span className="collapsed-bar__brand-name">Vibe Board</span>
                  <span className="collapsed-bar__brand-slogan">{t('notch.slogan')}</span>
                </div>
              ) : (
                <>
                  {renderMascot(undefined, 22)}
                  {showTips && !focusFilteredEmpty ? (
                    <div className="collapsed-bar__carousel">
                      <TipDisplay show />
                    </div>
                  ) : (
                    <span className="collapsed-bar__info collapsed-bar__info--empty">
                      {emptyText}
                    </span>
                  )}
                </>
              )}
            </>
          )}
        </div>

        <div className="collapsed-bar__right">
          {/* Rate limit percentage */}
          {ratePct != null && !isExpanded && (
            <span className="collapsed-bar__rate-pct" style={{ color: rateColor }}>
              {ratePct}%
            </span>
          )}
          {/* Error warning badge */}
          {hasError && (
            <span className="collapsed-bar__error-badge">!</span>
          )}
          {/* YOLO mode badge */}
          {isYolo && (
            <span className="collapsed-bar__yolo-badge">YOLO</span>
          )}
          {/* Unattended timer badge */}
          {unattendedLevel !== 'none' && (
            <span className={`collapsed-bar__unattended collapsed-bar__unattended--${unattendedLevel}`}>
              {elapsedText}
            </span>
          )}
          {alertCount > 0 && (
            <span className="collapsed-bar__alert-badge">{alertCount}</span>
          )}
          {count > 0 && (
            <span className="collapsed-bar__count">{count}</span>
          )}
          {/* Settings gear only in collapsed state */}
          {!isExpanded && (
            <button
              ref={settingsButtonRef}
              className="collapsed-bar__icon-btn"
              title={updateAvailable ? t('notch.updateAvailable', { version: updateAvailable }) : t('notch.settings')}
              onClick={openSettings}
            >
              <svg width="12" height="12" viewBox="0 0 20 20" fill="none">
                <path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" fill="currentColor"/>
                <path fillRule="evenodd" clipRule="evenodd" d="M8.5 1.5A1.5 1.5 0 007 3v.34a1.1 1.1 0 01-.65.99l-.12.05a1.1 1.1 0 01-1.18-.16l-.24-.2a1.5 1.5 0 00-2.12.13l-.7.77a1.5 1.5 0 00.12 2.12l.2.18c.37.34.5.86.34 1.34l-.04.12a1.1 1.1 0 01-1.04.72H1.5A1.5 1.5 0 000 10.5v1A1.5 1.5 0 001.5 13h.07a1.1 1.1 0 011.04.72l.04.12c.16.48.03 1-.34 1.34l-.2.18a1.5 1.5 0 00-.12 2.12l.7.77a1.5 1.5 0 002.12.13l.24-.2a1.1 1.1 0 011.18-.16l.12.05c.39.18.65.57.65.99V19.5A1.5 1.5 0 008.5 21h1a1.5 1.5 0 001.5-1.5v-.34a1.1 1.1 0 01.65-.99l.12-.05a1.1 1.1 0 011.18.16l.24.2a1.5 1.5 0 002.12-.13l.7-.77a1.5 1.5 0 00-.12-2.12l-.2-.18a1.1 1.1 0 01-.34-1.34l.04-.12a1.1 1.1 0 011.04-.72h.07A1.5 1.5 0 0020 11.5v-1a1.5 1.5 0 00-1.5-1.5h-.07a1.1 1.1 0 01-1.04-.72l-.04-.12a1.1 1.1 0 01.34-1.34l.2-.18a1.5 1.5 0 00.12-2.12l-.7-.77a1.5 1.5 0 00-2.12-.13l-.24.2a1.1 1.1 0 01-1.18.16l-.12-.05A1.1 1.1 0 0111 3.34V3a1.5 1.5 0 00-1.5-1.5h-1zM10 14a4 4 0 100-8 4 4 0 000 8z" fill="currentColor"/>
              </svg>
              {updateAvailable && <span className="collapsed-bar__update-dot" aria-hidden="true" />}
            </button>
          )}
        </div>
      </div>
      )}
    </div>
  )
}
