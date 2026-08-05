import { useEffect, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useChatMeta, useConnection, useForkOpen, useOnBlankChat, useProviderAlert, useStore, useStoreError } from '../../state/store'
import { cx } from '../../lib/utils'
import { EASE } from '../../lib/motion'
import { Icon } from '../chat/icons'
import ChatListSidebar from './ChatListSidebar'
import Composer from './Composer'
import LocalSources from './LocalSources'
import ThemeToggle from './ThemeToggle'
import TypewriterText from './TypewriterText'
import './Layout.css'

const SIDEBAR_COLLAPSED_KEY = 'rautml.sidebarCollapsed'
const SIDEBAR_TRANSITION_MS = 420
const SIDEBAR_TRANSITION_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'

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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed)
  const [sidebarAnimating, setSidebarAnimating] = useState(false)
  const shellRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const sidebarTransitionActive = useRef(false)
  const sidebarAnimations = useRef<Animation[]>([])

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
      documentMode &&
      document.documentElement.dataset.desktop === 'electron' &&
      !reduceMotion &&
      shell !== null &&
      typeof Element.prototype.animate === 'function'

    if (!useFlip) {
      setSidebarCollapsed(collapsed)
      persist()
      return
    }

    /* The generated page lives in an iframe. Animating its actual grid width
     * makes that independent document reflow on every frame, which produces a
     * visible follow-then-snap when it crosses a responsive breakpoint. Instead
     * we commit the final grid once, then FLIP the rendered surfaces from their
     * previous bounds. The iframe reflows exactly once, before the next paint. */
    const selectors = ['.rml-docframe', '.rml-dochead__bar', '.rml-dock', '.rml-slot--ball']
    const surfaces = selectors
      .map((selector) => shell.querySelector<HTMLElement>(selector))
      .filter((element): element is HTMLElement => element !== null)
    const before = new Map<HTMLElement, DOMRect>(
      surfaces.map((element) => [element, element.getBoundingClientRect()] as const),
    )

    sidebarTransitionActive.current = true
    flushSync(() => {
      setSidebarAnimating(true)
      setSidebarCollapsed(collapsed)
    })
    persist()

    const animations = surfaces.flatMap((element) => {
      const first = before.get(element)
      if (!first) return []
      const last = element.getBoundingClientRect()
      if (first.width <= 0 || last.width <= 0 || first.height <= 0 || last.height <= 0) return []

      const deltaX = first.left - last.left
      const deltaY = first.top - last.top
      const scaleX = first.width / last.width
      const scaleY = first.height / last.height
      return [
        element.animate(
          [
            {
              transform: `translate3d(${deltaX}px, ${deltaY}px, 0) scale(${scaleX}, ${scaleY})`,
              transformOrigin: 'top left',
            },
            { transform: 'translate3d(0, 0, 0) scale(1, 1)', transformOrigin: 'top left' },
          ],
          {
            duration: SIDEBAR_TRANSITION_MS,
            easing: SIDEBAR_TRANSITION_EASE,
            fill: 'both',
          },
        ),
      ]
    })

    const sidebarElement = sidebarRef.current
    if (sidebarElement) {
      animations.push(
        sidebarElement.animate(
          collapsed
            ? [{ transform: 'translate3d(0, 0, 0)' }, { transform: 'translate3d(-100%, 0, 0)' }]
            : [{ transform: 'translate3d(-100%, 0, 0)' }, { transform: 'translate3d(0, 0, 0)' }],
          {
            duration: SIDEBAR_TRANSITION_MS,
            easing: SIDEBAR_TRANSITION_EASE,
            fill: 'both',
          },
        ),
      )
    }

    sidebarAnimations.current = animations
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      if (sidebarAnimations.current !== animations) return
      animations.forEach((animation) => animation.cancel())
      sidebarAnimations.current = []
      sidebarTransitionActive.current = false
      setSidebarAnimating(false)
    })
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
        className,
      )}
    >
      <div className="rml-desktop-drag" aria-hidden="true" />
      <AnimatePresence>
        {sidebarCollapsed ? (
          <motion.nav
            className="rml-desktop-compact-controls"
            aria-label="Conversation controls"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2, ease: EASE }}
          >
            <button
              type="button"
              aria-label="Expand sidebar"
              title="Expand sidebar"
              onClick={() => setDesktopSidebarCollapsed(false)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="3.5" y="4" width="17" height="16" rx="3" />
                <path d="M9 4v16" />
                <path d="m14 9 3 3-3 3" />
              </svg>
            </button>
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
          </motion.nav>
        ) : null}
      </AnimatePresence>
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
              setDesktopSidebarCollapsed(false)
              setNavOpen(true)
              window.dispatchEvent(new Event('rautml:open-providers'))
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
