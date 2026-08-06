import { useEffect, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useChatMeta, useConnection, useForkOpen, useOnBlankChat, useProviderAlert, useSettingsOpen, useStore, useStoreError } from '../../state/store'
import { cx } from '../../lib/utils'
import { EASE, SIDEBAR_TRANSITION_MS } from '../../lib/motion'
import { Icon } from '../chat/icons'
import ChatListSidebar from './ChatListSidebar'
import Composer from './Composer'
import LocalSources from './LocalSources'
import ThemeToggle from './ThemeToggle'
import TypewriterText from './TypewriterText'
import './Layout.css'

const SIDEBAR_COLLAPSED_KEY = 'rautml.sidebarCollapsed'
const SIDEBAR_TRANSITION_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'

/* Collapsing commits the grid in a single layout pass and lets the rendered
 * surfaces carry the motion (FLIP). Most surfaces only need translation. The
 * document frame is the exception: its responsive iframe must interpolate its
 * viewport width as it moves so the window-pinned right edge never flashes to
 * its final layout in a single frame. */
const SIDEBAR_FLIP_SURFACES = {
  document: ['.rml-docframe', '.rml-dock', '.rml-slot--ball'],
  chat: [
    '.rml-topbar__lead',
    '.rml-topbar__actions',
    '.rml-thread',
    /* the inner column, not the full-bleed wrapper around it: only the centred
     * box travels by half the track, which is the distance the eye follows */
    '.rml-welcome__inner',
    '.rml-composer',
    '.rml-slot--ball',
  ],
}

const SIDEBAR_RESIZE_SURFACES = new Set(['.rml-docframe'])

/* The document header pill spans the column: its right edge is pinned to the
 * window and only its left edge travels. Translating it would swing the right
 * cap — and its controls — off-screen, so its margin is what animates. */
const SIDEBAR_INSET_SURFACES = ['.rml-dochead__bar']

function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'
  } catch {
    return false
  }
}

export interface LayoutProps {
  /** Left column. Defaults to the chat list. */
  sidebar?: ReactNode
  /** Extra controls in the top bar, left of the theme toggle. */
  header?: ReactNode
  /** Main column, scrollable — the chat thread lives here. */
  children?: ReactNode
  /** Bottom dock of the main column. Defaults to the main-thread composer. */
  composer?: ReactNode
  /** Right column — the fork panel. Width animates with the store's `forkOpen`. */
  fork?: ReactNode
  /** Absolutely-positioned overlay inside the main column (the fork ball). */
  floating?: ReactNode
  /**
   * Document takeover: the main column is a generated page rather than a thread.
   * The topbar steps aside (the document's own glass header carries its controls), the
   * body loses its padding and scroll, and the composer floats over the page instead of
   * sitting in a dock.
   */
  documentMode?: boolean
  className?: string
}

export function Layout({
  sidebar,
  header,
  children,
  composer,
  fork,
  floating,
  documentMode = false,
  className,
}: LayoutProps) {
  const chat = useChatMeta()
  const forkOpen = useForkOpen()
  const connection = useConnection()
  const error = useStoreError()
  const dismissError = useStore((s) => s.dismissError)
  const providerAlert = useProviderAlert()
  const onBlankChat = useOnBlankChat()
  const newChat = useStore((s) => s.newChat)
  const dismissProviderAlert = useStore((s) => s.dismissProviderAlert)
  const reconnectProvider = useStore((s) => s.reconnectProvider)
  const openSettings = useStore((s) => s.openSettings)
  const settingsOpen = useSettingsOpen()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed)
  const [sidebarAnimating, setSidebarAnimating] = useState(false)
  const shellRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const sidebarTransitionActive = useRef(false)
  const sidebarAnimations = useRef<Animation[]>([])

  /* The settings takeover covers the shell but is a sibling of it, so the shell
   * has to be taken out of the tab order and the a11y tree by hand. `inert` is
   * set imperatively: React 18 does not recognise it as a prop. */
  useEffect(() => {
    const shell = shellRef.current
    if (!shell) return
    if (settingsOpen) shell.setAttribute('inert', '')
    else shell.removeAttribute('inert')
  }, [settingsOpen])

  const setDesktopSidebarCollapsed = (collapsed: boolean) => {
    if (collapsed === sidebarCollapsed || sidebarTransitionActive.current) return

    const persist = () => {
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed))
      } catch {
        /* private mode — the choice lasts for this session */
      }
    }

    const shell = shellRef.current
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const useFlip =
      document.documentElement.dataset.desktop === 'electron' &&
      !reduceMotion &&
      shell !== null &&
      typeof Element.prototype.animate === 'function'

    if (!useFlip) {
      setSidebarCollapsed(collapsed)
      persist()
      return
    }

    /* Animating the grid track itself re-laid out the entire main column on
     * every frame — and in document mode it made the generated page reflow
     * across its own breakpoints, a visible follow-then-snap. Instead the grid
     * commits its final geometry once and the surfaces below FLIP from the
     * bounds they just left. The column reflows exactly once, before paint. */
    const query = (selectors: string[]) =>
      selectors
        .map((selector) => shell.querySelector<HTMLElement>(selector))
        .filter((element): element is HTMLElement => element !== null)

    const translated = query(SIDEBAR_FLIP_SURFACES[documentMode ? 'document' : 'chat'])
    const inset = documentMode ? query(SIDEBAR_INSET_SURFACES) : []
    const measured = [...translated, ...inset]
    const before = new Map<HTMLElement, DOMRect>(
      measured.map((element) => [element, element.getBoundingClientRect()] as const),
    )

    sidebarTransitionActive.current = true
    flushSync(() => {
      setSidebarAnimating(true)
      setSidebarCollapsed(collapsed)
    })
    persist()

    /* Read every final box before writing a single animation — the inset pass
     * animates margin, which would invalidate any measurement taken after it. */
    const after = new Map<HTMLElement, DOMRect>(
      measured.map((element) => [element, element.getBoundingClientRect()] as const),
    )

    const timing: KeyframeAnimationOptions = {
      duration: SIDEBAR_TRANSITION_MS,
      easing: SIDEBAR_TRANSITION_EASE,
      fill: 'both',
    }
    const animations: Animation[] = []

    for (const element of translated) {
      const first = before.get(element)
      const last = after.get(element)
      if (!first || !last) continue
      const deltaX = Math.round(first.left - last.left)
      const deltaY = Math.round(first.top - last.top)
      const resizes = [...SIDEBAR_RESIZE_SURFACES].some((selector) => element.matches(selector))
      const widthChanged = Math.round(first.width) !== Math.round(last.width)
      if (deltaX === 0 && deltaY === 0 && (!resizes || !widthChanged)) continue

      const from: Keyframe = { transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` }
      const to: Keyframe = { transform: 'translate3d(0, 0, 0)' }
      if (resizes && widthChanged) {
        from.width = `${first.width}px`
        to.width = `${last.width}px`
      }
      animations.push(
        element.animate([from, to], timing),
      )
    }

    for (const element of inset) {
      const first = before.get(element)
      const last = after.get(element)
      if (!first || !last) continue
      const delta = Math.round(first.left - last.left)
      if (delta === 0) continue
      const marginLeft = Number.parseFloat(getComputedStyle(element).marginLeft) || 0
      animations.push(
        element.animate(
          [{ marginLeft: `${marginLeft + delta}px` }, { marginLeft: `${marginLeft}px` }],
          timing,
        ),
      )
    }

    const sidebarElement = sidebarRef.current
    if (sidebarElement) {
      animations.push(
        sidebarElement.animate(
          collapsed
            ? [{ transform: 'translate3d(0, 0, 0)' }, { transform: 'translate3d(-100%, 0, 0)' }]
            : [{ transform: 'translate3d(-100%, 0, 0)' }, { transform: 'translate3d(0, 0, 0)' }],
          timing,
        ),
      )
    }

    const settle = () => {
      if (sidebarAnimations.current !== animations) return
      sidebarAnimations.current = []
      sidebarTransitionActive.current = false
      /* Leave the animating state first, in this same task. Cancelling while
       * the class is still applied paints one frame of the sidebar back at its
       * starting position — the flash the transition used to end on. */
      flushSync(() => setSidebarAnimating(false))
      animations.forEach((animation) => animation.cancel())
    }

    sidebarAnimations.current = animations
    if (animations.length === 0) {
      settle()
      return
    }
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(settle)
  }

  /* Small screens collapse the sidebar into an off-canvas drawer. The state is
   * harmless on desktop: the drawer classes only take effect under 640px. */
  const [navOpen, setNavOpen] = useState(false)
  const chatId = chat?.id
  useEffect(() => {
    setNavOpen(false)
  }, [chatId])
  useEffect(() => {
    if (!navOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNavOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navOpen])
  useEffect(
    () => () => {
      sidebarAnimations.current.forEach((animation) => animation.cancel())
      sidebarAnimations.current = []
      sidebarTransitionActive.current = false
    },
    [],
  )
  return (
    <div
      ref={shellRef}
      className={cx(
        'rml-shell',
        forkOpen && 'is-fork-open',
        documentMode && 'is-document',
        navOpen && 'is-nav-open',
        sidebarCollapsed && 'is-sidebar-collapsed',
        sidebarAnimating && 'is-sidebar-animating',
        settingsOpen && 'is-settings-open',
        className,
      )}
    >
      <div className="rml-desktop-drag" aria-hidden="true" />
      {/* Sits in the titlebar strip beside the traffic lights and stays there in
          both states — the toggle used to teleport between here and the panel's
          own head. Only the new-chat shortcut is conditional: it stands in for
          the panel's button while the panel is away. */}
      <nav className="rml-titlebar-controls" aria-label="Conversation controls">
        <button
          type="button"
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!sidebarCollapsed}
          aria-controls="rautml-conversation-list"
          title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={() => setDesktopSidebarCollapsed(!sidebarCollapsed)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3.5" y="4" width="17" height="16" rx="3" />
            <path d="M9 4v16" />
            <path d={sidebarCollapsed ? 'm14 9 3 3-3 3' : 'm16 9-3 3 3 3'} />
          </svg>
        </button>
        <AnimatePresence>
          {sidebarCollapsed && !sidebarAnimating ? (
            /* the wrapper carries the entry, not the button: framer writes its
               values as inline styles, which would outrank the group's own
               :disabled and :active rules */
            <motion.div
              className="rml-titlebar-controls__slot"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18, ease: EASE }}
            >
              <button
                type="button"
                aria-label="New chat"
                title={onBlankChat ? "You're already in a new chat" : 'New chat'}
                disabled={onBlankChat}
                onClick={() => void newChat()}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M13.5 5H6.4A2.4 2.4 0 0 0 4 7.4v10.2A2.4 2.4 0 0 0 6.4 20h10.2a2.4 2.4 0 0 0 2.4-2.4v-7.1" />
                  <path d="m12 14 1-.2 6.4-6.4a2 2 0 0 0-2.8-2.8L10.2 11l-.2 3z" />
                </svg>
              </button>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </nav>
      <aside ref={sidebarRef} className="rml-shell__sidebar">
        {sidebar ?? (
          <ChatListSidebar
            collapsed={sidebarCollapsed && !sidebarAnimating}
            onCollapsedChange={setDesktopSidebarCollapsed}
          />
        )}
      </aside>

      {navOpen ? (
        <button
          type="button"
          className="rml-shell__scrim"
          aria-label="Close the conversation list"
          onClick={() => setNavOpen(false)}
        />
      ) : null}

      <main className="rml-shell__main">
        {documentMode ? (
          <button
            type="button"
            className="rml-shell__nav-fab"
            aria-label="Show conversations"
            aria-expanded={navOpen}
            onClick={() => setNavOpen(true)}
          >
            <Icon name="menu" size={16} />
          </button>
        ) : (
        <header className="rml-topbar">
          <div className="rml-topbar__lead">
            <button
              type="button"
              className="rml-topbar__menu"
              aria-label="Show conversations"
              aria-expanded={navOpen}
              onClick={() => setNavOpen(true)}
            >
              <Icon name="menu" size={16} />
            </button>
            <h1 className="rml-topbar__title" title={chat?.title}>
              <TypewriterText text={chat?.title ?? 'Rautml'} />
            </h1>
            <AnimatePresence>
              {connection === 'reconnecting' ? (
                <motion.span
                  className="rml-topbar__status"
                  initial={{ opacity: 0, y: -3 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -3 }}
                  transition={{ duration: 0.24, ease: EASE }}
                >
                  <span className="rml-topbar__dot" />
                  Reconnecting…
                </motion.span>
              ) : null}
            </AnimatePresence>
          </div>
          <div className="rml-topbar__actions">
            <LocalSources />
            {header}
            <ThemeToggle />
          </div>
        </header>
        )}

        <div className="rml-shell__body">
          <div className="rml-shell__scroll">{children}</div>
          {floating}
        </div>

        <div className="rml-shell__dock">{composer ?? <Composer thread="main" autoFocus />}</div>
      </main>

      <aside className="rml-shell__fork" aria-hidden={!forkOpen}>
        <div className="rml-shell__fork-inner">{fork}</div>
      </aside>

      <AnimatePresence>
        {providerAlert ? (
          <motion.div
            className="rml-provider-warning"
            role="alert"
            initial={{ opacity: 0, x: '-50%', y: -18, scale: 0.98 }}
            animate={{ opacity: 1, x: '-50%', y: 0, scale: 1 }}
            exit={{ opacity: 0, x: '-50%', y: -12, scale: 0.98 }}
            transition={{ duration: 0.3, ease: EASE }}
          >
            <span className="rml-provider-warning__icon" aria-hidden="true">!</span>
            <span className="rml-provider-warning__copy">
              <strong>Provider connection stopped the run</strong>
              <small>{providerAlert.message}</small>
            </span>
            <button type="button" onClick={() => void reconnectProvider(providerAlert.providerId)}>Reconnect</button>
            <button type="button" onClick={() => {
              openSettings('models')
              dismissProviderAlert()
            }}>Change provider</button>
            <button className="rml-provider-warning__close" type="button" aria-label="Dismiss" onClick={dismissProviderAlert}>×</button>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {error ? (
          <motion.div
            className="rml-toast"
            role="status"
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.28, ease: EASE }}
          >
            <span className="rml-toast__text">{error}</span>
            <button type="button" className="rml-toast__close" onClick={dismissError}>
              Dismiss
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

export default Layout
