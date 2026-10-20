import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NotchPanel } from '../components/notch/NotchPanel'
import { useConfigStore } from '../stores/configStore'
import { useSessionStore } from '../stores/sessionStore'
import type { OverlayItem, SessionState } from '../types/agent'

const tauriMocks = vi.hoisted(() => ({
  getChatHistory: vi.fn(() => Promise.resolve([])),
  getChatHistoryTail: vi.fn(() => Promise.resolve({ messages: [], hasMore: false, firstMessageId: null, totalCount: 0, transcriptPath: null })),
  isTerminalFocused: vi.fn((sessionId?: string) => Promise.resolve(Boolean(sessionId && false))),
  jumpToTerminal: vi.fn(() => Promise.resolve()),
  setNotchFocusable: vi.fn(() => Promise.resolve()),
  setNotchIgnoreCursorEvents: vi.fn((ignore: boolean) => {
    void ignore
    return Promise.resolve()
  }),
  isCursorOverNotch: vi.fn(() => Promise.resolve(false)),
  isTauri: vi.fn(() => false),
  resizeNotch: vi.fn(() => Promise.resolve({ anchorOffsetX: 0 })),
  startNotchDrag: vi.fn(() => Promise.resolve(true)),
  endNotchDrag: vi.fn(() => Promise.resolve(null)),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}))

vi.mock('../services/tauriApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tauriApi')>()
  return {
    ...actual,
    getChatHistory: tauriMocks.getChatHistory,
    getChatHistoryTail: tauriMocks.getChatHistoryTail,
    isTerminalFocused: tauriMocks.isTerminalFocused,
    jumpToTerminal: tauriMocks.jumpToTerminal,
    setNotchFocusable: tauriMocks.setNotchFocusable,
    setNotchIgnoreCursorEvents: tauriMocks.setNotchIgnoreCursorEvents,
    isCursorOverNotch: tauriMocks.isCursorOverNotch,
    isTauri: tauriMocks.isTauri,
    resizeNotch: tauriMocks.resizeNotch,
    startNotchDrag: tauriMocks.startNotchDrag,
    endNotchDrag: tauriMocks.endNotchDrag,
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | { defaultValue?: string }) => {
      if (typeof fallback === 'string') return fallback
      return fallback?.defaultValue ?? key
    },
  }),
}))

function session(overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: 's1',
    agentType: 'claude-code',
    project: 'agentbro',
    terminal: 'iTerm',
    phase: 'processing',
    startedAt: Date.now() - 10_000,
    duration: 10_000,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    chatHistory: [],
    subagents: [],
    activeTools: [],
    sessionTitle: 'Port dynamic island',
    description: 'Running parity checks',
    pid: 1234,
    ...overrides,
  }
}

function mountIsland(activeOverlay: OverlayItem | null = null, sessionOverrides: Partial<SessionState> = {}) {
  const currentSession = session(sessionOverrides)
  useSessionStore.setState({
    sessions: { [currentSession.id]: currentSession },
    sessionList: [currentSession],
    activeSessionId: currentSession.id,
    panelState: 'hover',
    activeOverlay,
    overlayQueue: activeOverlay ? [activeOverlay] : [],
    rateLimits: undefined,
    hookNotification: null,
    wakeSilencedUntil: 0,
    focusedTerminal: null,
  })

  render(<NotchPanel />)
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('NotchPanel island shell', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tauriMocks.getChatHistory.mockResolvedValue([])
    tauriMocks.isTerminalFocused.mockResolvedValue(false)
    tauriMocks.jumpToTerminal.mockResolvedValue(undefined)
    tauriMocks.setNotchFocusable.mockResolvedValue(undefined)
    tauriMocks.setNotchIgnoreCursorEvents.mockResolvedValue(undefined)
    tauriMocks.isCursorOverNotch.mockResolvedValue(false)
    tauriMocks.isTauri.mockReturnValue(false)
    tauriMocks.resizeNotch.mockResolvedValue({ anchorOffsetX: 0 })
    tauriMocks.startNotchDrag.mockResolvedValue(true)
    tauriMocks.endNotchDrag.mockResolvedValue(null)
    useConfigStore.setState({
      allowHorizontalDrag: false,
      autoCollapse: false,
      autoHideNoSessions: false,
      clickToDetail: true,
      completionCardHeight: 120,
      detailPanelMaxHeight: 500,
      confettiEnabled: false,
      followFocus: false,
      hoverExpandDelay: 0,
      microHoverExpandDelay: 0,
      interactionMode: 'persistent',
      islandAnimationScale: 1,
      maxPanelHeight: 600,
      microPillWidth: 112,
      notchStyle: 'compact',
      notchPositionMode: 'top',
      notchVerticalOffset: 0,
      panelMaxWidth: 630,
      panelHorizontalOffset: 0,
      sideIslandSize: 'narrow',
      pixelCursorEnabled: false,
      showCacheTTL: false,
      taskCompleteDwellSeconds: 3,
      tipsEnabled: false,
    })
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it('forces native cursor events back on while the hover list is interactive', async () => {
    tauriMocks.isTauri.mockReturnValue(true)
    mountIsland(null, { phase: 'idle' })

    await waitFor(() => {
      expect(tauriMocks.setNotchIgnoreCursorEvents).toHaveBeenCalledWith(false)
    })
    expect(screen.getByTestId('notch-hover-content')).toBeInTheDocument()
  })

  it('serializes native cursor passthrough so a stale hidden request cannot disable hover', async () => {
    tauriMocks.isTauri.mockReturnValue(true)
    const pendingCollapsedPassthrough = deferred()
    tauriMocks.setNotchIgnoreCursorEvents
      .mockImplementationOnce(() => pendingCollapsedPassthrough.promise)
      .mockResolvedValue(undefined)

    useConfigStore.setState({ interactionMode: 'minimal' })
    const currentSession = session({ phase: 'processing' })
    useSessionStore.setState({
      sessions: { [currentSession.id]: currentSession },
      sessionList: [currentSession],
      activeSessionId: currentSession.id,
      panelState: 'collapsed',
      activeOverlay: null,
      overlayQueue: [],
      rateLimits: undefined,
      hookNotification: null,
      wakeSilencedUntil: 0,
      focusedTerminal: null,
    })

    render(<NotchPanel />)

    await waitFor(() => {
      expect(tauriMocks.setNotchIgnoreCursorEvents).toHaveBeenCalledWith(true)
    })

    act(() => {
      useSessionStore.getState().setPanelState('hover')
    })

    expect(tauriMocks.setNotchIgnoreCursorEvents).toHaveBeenCalledTimes(1)

    await act(async () => {
      pendingCollapsedPassthrough.resolve()
      await pendingCollapsedPassthrough.promise
    })

    await waitFor(() => {
      expect(tauriMocks.setNotchIgnoreCursorEvents).toHaveBeenCalledWith(false)
    })
    expect(tauriMocks.setNotchIgnoreCursorEvents.mock.calls.map(([ignore]) => ignore)).toEqual([true, false])
  })

  it('cancels delayed collapsed cursor passthrough when the hover list opens first', async () => {
    tauriMocks.isTauri.mockReturnValue(true)
    const currentSession = session({ phase: 'idle' })
    useSessionStore.setState({
      sessions: { [currentSession.id]: currentSession },
      sessionList: [currentSession],
      activeSessionId: currentSession.id,
      panelState: 'collapsed',
      activeOverlay: null,
      overlayQueue: [],
      rateLimits: undefined,
      hookNotification: null,
      wakeSilencedUntil: 0,
      focusedTerminal: null,
    })

    render(<NotchPanel />)

    await waitFor(() => {
      expect(tauriMocks.isCursorOverNotch).toHaveBeenCalled()
    })
    expect(tauriMocks.setNotchIgnoreCursorEvents).not.toHaveBeenCalledWith(true)

    act(() => {
      useSessionStore.getState().setPanelState('hover')
    })

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150))
    })

    expect(tauriMocks.setNotchIgnoreCursorEvents).not.toHaveBeenCalledWith(true)
    expect(tauriMocks.setNotchIgnoreCursorEvents).toHaveBeenCalledWith(false)
  })

  it('uses Vibe Board-style progressive Escape: collapse first, then hide from compact', async () => {
    mountIsland()

    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(useSessionStore.getState().panelState).toBe('collapsed')
    expect(useSessionStore.getState().wakeSilencedUntil).toBe(0)
    expect(tauriMocks.setNotchFocusable).toHaveBeenCalledWith(false)

    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(useSessionStore.getState().wakeSilencedUntil).toBeGreaterThan(Date.now())
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Vibe Board' }).parentElement).toHaveAttribute(
        'data-island-hidden',
        'true',
      )
    })
  })


  it('routes configured panel and session navigation shortcuts', () => {
    useConfigStore.setState({
      shortcuts: [
        { action: 'toggle-panel', label: 'Toggle Panel', keys: '⌘+⇧+I' },
        { action: 'expand-panel', label: 'Expand Panel', keys: '⌘+⇧+E' },
        { action: 'next-session', label: 'Next Session', keys: '⌘+]' },
        { action: 'prev-session', label: 'Previous Session', keys: '⌘+[' },
      ],
    })
    const first = session({ id: 's1', sessionTitle: 'First session' })
    const second = session({ id: 's2', sessionTitle: 'Second session', startedAt: first.startedAt + 1 })
    useSessionStore.setState({
      sessions: { s1: first, s2: second },
      sessionList: [first, second],
      activeSessionId: 's1',
      panelState: 'collapsed',
      activeOverlay: null,
      overlayQueue: [],
      rateLimits: undefined,
      hookNotification: null,
      wakeSilencedUntil: 0,
      focusedTerminal: null,
    })

    render(<NotchPanel />)

    fireEvent.keyDown(window, { key: 'e', metaKey: true, shiftKey: true })
    expect(useSessionStore.getState().panelState).toBe('hover')

    fireEvent.keyDown(window, { key: ']', metaKey: true })
    expect(useSessionStore.getState().activeSessionId).toBe('s2')

    fireEvent.keyDown(window, { key: '[', metaKey: true })
    expect(useSessionStore.getState().activeSessionId).toBe('s1')

    fireEvent.keyDown(window, { key: 'i', metaKey: true, shiftKey: true })
    expect(useSessionStore.getState().panelState).toBe('collapsed')
  })

  it('keeps all Agent tasks in the board when follow focus is enabled', async () => {
    useConfigStore.setState({ followFocus: true })
    tauriMocks.isTerminalFocused.mockImplementation((sessionId?: string) => Promise.resolve(sessionId === 's2'))
    const focused = session({ id: 's2', sessionTitle: 'Focused terminal', project: 'focused', pid: 2222, terminal: 'iTerm' })
    const background = session({ id: 's1', sessionTitle: 'Background terminal', project: 'background', pid: 1111, terminal: 'Terminal' })
    useSessionStore.setState({
      sessions: { s1: background, s2: focused },
      sessionList: [background, focused],
      activeSessionId: 's2',
      panelState: 'hover',
      activeOverlay: null,
      overlayQueue: [],
      rateLimits: undefined,
      hookNotification: null,
      wakeSilencedUntil: 0,
      focusedTerminal: null,
    })

    render(<NotchPanel />)

    await waitFor(() => expect(tauriMocks.isTerminalFocused).toHaveBeenCalled())
    expect(screen.getByText('Background terminal')).toBeInTheDocument()
    expect(screen.getByText('Focused terminal')).toBeInTheDocument()
  })
})
