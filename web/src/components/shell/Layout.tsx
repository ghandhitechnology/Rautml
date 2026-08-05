import { useEffect, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useChatMeta, useConnection, useForkOpen, useProviderAlert, useStore, useStoreError } from '../../state/store'
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
  const dismissProviderAlert = useStore((s) => s.dismissProviderAlert)
  const reconnectProvider = useStore((s) => s.reconnectProvider)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed)

  const setDesktopSidebarCollapsed = (collapsed: boolean) => {
    setSidebarCollapsed(collapsed)
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed))
    } catch {
      /* private mode — the choice lasts for this session */
    }
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

  return (
    <div
      className={cx(
        'rml-shell',
        forkOpen && 'is-fork-open',
        documentMode && 'is-document',
        navOpen && 'is-nav-open',
        sidebarCollapsed && 'is-sidebar-collapsed',
        className,
      )}
    >
      <aside className="rml-shell__sidebar">
        {sidebar ?? (
          <ChatListSidebar
            collapsed={sidebarCollapsed}
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
