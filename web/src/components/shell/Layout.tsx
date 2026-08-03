import type { ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useChatMeta, useConnection, useForkOpen, useStore, useStoreError } from '../../state/store'
import { cx } from '../../lib/utils'
import { EASE } from '../../lib/motion'
import ChatListSidebar from './ChatListSidebar'
import Composer from './Composer'
import ThemeToggle from './ThemeToggle'
import TypewriterText from './TypewriterText'
import './Layout.css'

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

  return (
    <div
      className={cx(
        'rml-shell',
        forkOpen && 'is-fork-open',
        documentMode && 'is-document',
        className,
      )}
    >
      <aside className="rml-shell__sidebar">{sidebar ?? <ChatListSidebar />}</aside>

      <main className="rml-shell__main">
        {documentMode ? null : (
        <header className="rml-topbar">
          <div className="rml-topbar__lead">
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
