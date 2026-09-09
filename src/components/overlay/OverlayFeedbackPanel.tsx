import { useCallback, useEffect, useRef, useState, type CompositionEvent, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { SessionState } from '../../types/agent'
import { useSessionStore } from '../../stores/sessionStore'
import { sendMessage, setNotchFocusable } from '../../services/tauriApi'
import { getAgentDisplayName, getSessionAppLabel, getSessionTaskDurationSeconds, getSessionTerminalLabel, getSessionTitle } from '../../utils/sessionDisplay'
import { getComposerCapability, type ComposerLockReason } from '../../utils/sessionCapabilities'
import { formatDurationShort } from '../../utils/time'
import { MascotRouter } from '../notch/mascots/MascotRouter'
import './OverlayFeedbackPanel.css'

interface OverlayFeedbackPanelProps {
  session: SessionState
  userMessage?: string
  text: string
  kind?: 'completion' | 'response'
  maxHeight?: number
  statusLabel: string
  onJumpToTerminal: () => void
  onShowSessions?: () => void
  onDismiss: () => void
  onDraftStateChange?: (hasDraft: boolean) => void
  sessionCount?: number
}

function shouldIgnorePanelJump(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(
    target.closest('button, input, textarea, select, a, [role="button"]'),
  )
}

export function OverlayFeedbackPanel({
  session,
  userMessage,
  text,
  kind = 'response',
  maxHeight,
  statusLabel,
  onJumpToTerminal,
  onShowSessions,
  onDismiss,
  onDraftStateChange,
  sessionCount,
}: OverlayFeedbackPanelProps) {
  const { t } = useTranslation()
  const [inputValue, setInputValue] = useState('')
  const [sending, setSending] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const onDismissRef = useRef(onDismiss)
  const inputFocusedRef = useRef(false)
  const inputComposingRef = useRef(false)
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refocusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hasInputDraft = inputValue.trim().length > 0

  const shownUserMessage = userMessage || session.lastUserMessage
  const appLabel = getSessionAppLabel(session)
  const terminalLabel = getSessionTerminalLabel(session)
  const agentName = getAgentDisplayName(session)
  const codexAppServerLive = useSessionStore((state) => state.codexAppServerLive)
  const capability = getComposerCapability(session, {
    codexAppServerLive,
    codexDesktopRepliesSupported: true,
  })

  useEffect(() => {
    onDismissRef.current = onDismiss
  }, [onDismiss])

  useEffect(() => {
    onDraftStateChange?.(hasInputDraft)
  }, [hasInputDraft, onDraftStateChange])

  useEffect(() => () => onDraftStateChange?.(false), [onDraftStateChange])

  useEffect(() => () => {
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current)
    if (refocusTimerRef.current) clearTimeout(refocusTimerRef.current)
  }, [])

  const focusInput = useCallback(() => {
    inputFocusedRef.current = true
    if (blurTimerRef.current) {
      clearTimeout(blurTimerRef.current)
      blurTimerRef.current = null
    }
    if (refocusTimerRef.current) {
      clearTimeout(refocusTimerRef.current)
      refocusTimerRef.current = null
    }
    setNotchFocusable(true)
      .then(() => {
        window.requestAnimationFrame(() => inputRef.current?.focus())
        refocusTimerRef.current = setTimeout(() => {
          refocusTimerRef.current = null
          if (inputFocusedRef.current) inputRef.current?.focus()
        }, 80)
      })
      .catch(() => {
        inputRef.current?.focus()
      })
  }, [])

  const releaseInputFocus = useCallback(() => {
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current)
    if (refocusTimerRef.current) {
      clearTimeout(refocusTimerRef.current)
      refocusTimerRef.current = null
    }
    blurTimerRef.current = setTimeout(() => {
      blurTimerRef.current = null
      inputFocusedRef.current = false
      setNotchFocusable(false).catch(() => {})
    }, 200)
  }, [])

  const handleSend = useCallback(async () => {
    const value = inputValue.trim()
    if (!value || sending) return
    setSending(true)
    try {
      await sendMessage(session.id, value)
      useSessionStore.getState().updateSession({
        type: 'user_message',
        sessionId: session.id,
        content: value,
      })
      setInputValue('')
      inputFocusedRef.current = false
    } catch (error) {
      console.warn('[OverlayFeedbackPanel] sendMessage:', error)
    } finally {
      setSending(false)
    }
  }, [inputValue, sending, session.id])

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation()
    if (event.nativeEvent.isComposing || inputComposingRef.current) return
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void handleSend()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      if (inputValue) setInputValue('')
      else onDismissRef.current()
    }
  }, [handleSend, inputValue])

  const handleCompositionStart = useCallback(() => {
    inputComposingRef.current = true
  }, [])

  const handleCompositionEnd = useCallback((event: CompositionEvent<HTMLInputElement>) => {
    inputComposingRef.current = false
    setInputValue(event.currentTarget.value)
  }, [])

  const handleJump = useCallback(() => {
    onJumpToTerminal()
    onDismissRef.current()
  }, [onJumpToTerminal])

  const handlePanelMouseDown = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || shouldIgnorePanelJump(event.target)) return
    event.preventDefault()
    handleJump()
  }, [handleJump])

  return (
    <div
      className={`overlay-feedback overlay-feedback--${kind}`}
      style={maxHeight ? ({ '--overlay-feedback-reader-height': `${maxHeight}px` } as CSSProperties) : undefined}
      onMouseDown={handlePanelMouseDown}
    >
      <div className="overlay-feedback__session" data-no-drag>
        <div className="overlay-feedback__avatar">
          <MascotRouter toolType={session.agentType} phase={session.phase} size={28} />
        </div>
        <div className="overlay-feedback__session-copy">
          <div className="overlay-feedback__session-row">
            <span className="overlay-feedback__title">{getSessionTitle(session)}</span>
            {appLabel && <span className="overlay-feedback__badge overlay-feedback__badge--source">{appLabel}</span>}
            <span className="overlay-feedback__badge overlay-feedback__badge--status">
              <span className="overlay-feedback__status-dot" />
              {statusLabel}
            </span>
            <span className="overlay-feedback__badge">{agentName}</span>
            {terminalLabel && <span className="overlay-feedback__badge">{terminalLabel}</span>}
            <span className="overlay-feedback__duration">{formatDurationShort(getSessionTaskDurationSeconds(session))}</span>
            <div className="overlay-feedback__actions">
              <button
                type="button"
                className="overlay-feedback__icon-btn overlay-feedback__jump-icon"
                aria-label={t('notch.jumpToTerminal')}
                onMouseDown={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  handleJump()
                }}
              >
                ↗
              </button>
              <button
                type="button"
                className="overlay-feedback__icon-btn overlay-feedback__close"
                aria-label={t('notch.dismiss', { defaultValue: 'Dismiss' })}
                onMouseDown={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  onDismissRef.current()
                }}
              >
                ×
              </button>
            </div>
          </div>
          {shownUserMessage && (
            <div className="overlay-feedback__user-line">
              <span>{t('notch.you', '你')}：</span>
              <span>{shownUserMessage}</span>
            </div>
          )}
          <div className="overlay-feedback__preview">{text}</div>
        </div>
      </div>

      <button type="button" className="overlay-feedback__detail" onMouseDown={handleJump}>
        <div className="overlay-feedback__scroll">
          <div className="overlay-feedback__transcript">
            <div className="overlay-feedback__conversation">
              {shownUserMessage && (
                <div className="overlay-feedback__message overlay-feedback__message--user">
                  <span className="overlay-feedback__message-prefix">{t('notch.you', '你')}：</span>
                  <span className="overlay-feedback__message-text">{shownUserMessage}</span>
                </div>
              )}
              <div className="overlay-feedback__message overlay-feedback__message--assistant">
                <div className="overlay-feedback__markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {text}
                  </ReactMarkdown>
                </div>
              </div>
            </div>
          </div>
        </div>
      </button>

      {capability.kind === 'locked' ? (
        <OverlayComposerHint
          reason={capability.reason}
          onJumpToHostApp={handleJump}
        />
      ) : (
        <div className="overlay-feedback__reply" data-no-drag>
          <input
            ref={inputRef}
            className="overlay-feedback__input"
            data-has-draft={hasInputDraft ? 'true' : 'false'}
            value={inputValue}
            placeholder={t('notch.typeMessage', { defaultValue: 'Send a message...' })}
            disabled={sending}
            onChange={(event) => setInputValue(event.target.value)}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            onKeyDown={handleKeyDown}
            onMouseDown={(event) => {
              event.stopPropagation()
              focusInput()
            }}
            onClick={(event) => event.stopPropagation()}
            onFocus={focusInput}
            onBlur={releaseInputFocus}
          />
          <button
            type="button"
            className="overlay-feedback__send"
            disabled={!inputValue.trim() || sending}
            onMouseDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
              if (blurTimerRef.current) {
                clearTimeout(blurTimerRef.current)
                blurTimerRef.current = null
              }
              void handleSend()
            }}
          >
            {sending ? '...' : t('notch.send', { defaultValue: 'Send' })}
          </button>
        </div>
      )}

      <div className="overlay-card__secondary" data-no-drag>
        {onShowSessions && sessionCount != null ? (
          <button
            type="button"
            className="overlay-card__show-sessions"
            onMouseDown={(event) => {
              event.preventDefault()
              onShowSessions()
            }}
          >
            <span className="overlay-card__brand-logo-stack" aria-hidden="true">
              <img className="overlay-card__brand-logo overlay-card__brand-logo--light" src="/vibe-board-logo.png" alt="" />
              <img className="overlay-card__brand-logo overlay-card__brand-logo--dark" src="/vibe-board-logo-dark.png" alt="" />
            </span>
            <span>{t('notch.slogan', { defaultValue: 'Vibe Coding看板' })}</span>
          </button>
        ) : (
          <div className="overlay-card__show-sessions overlay-card__show-sessions--static">
            <span className="overlay-card__brand-logo-stack" aria-hidden="true">
              <img className="overlay-card__brand-logo overlay-card__brand-logo--light" src="/vibe-board-logo.png" alt="" />
              <img className="overlay-card__brand-logo overlay-card__brand-logo--dark" src="/vibe-board-logo-dark.png" alt="" />
            </span>
            <span>{t('notch.slogan', { defaultValue: 'Vibe Coding看板' })}</span>
          </div>
        )}
      </div>
    </div>
  )
}

function OverlayComposerHint({
  reason,
  onJumpToHostApp,
}: {
  reason: ComposerLockReason
  onJumpToHostApp: () => void
}) {
  const { t } = useTranslation()
  const messageKey = composerHintMessageKey(reason)
  const ctaKey = composerHintCtaKey(reason)

  return (
    <div className="overlay-feedback__reply overlay-feedback__reply--hint" data-no-drag role="note">
      <span className="overlay-feedback__hint-text">{t(messageKey)}</span>
      {ctaKey && (
        <button
          type="button"
          className="overlay-feedback__hint-cta"
          onMouseDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onJumpToHostApp()
          }}
        >
          {t(ctaKey)}
        </button>
      )}
    </div>
  )
}

function composerHintMessageKey(reason: ComposerLockReason): string {
  switch (reason) {
    case 'codex-app': return 'notch.composerHintCodexApp'
    case 'qoder-app': return 'notch.composerHintQoderApp'
    case 'remote': return 'notch.composerHintRemote'
    case 'no-terminal': return 'notch.composerHintNoTerminal'
  }
}

function composerHintCtaKey(reason: ComposerLockReason): string | null {
  switch (reason) {
    case 'codex-app':
    case 'qoder-app':
      return 'notch.openHostApp'
    case 'remote':
    case 'no-terminal':
      return null
  }
}
