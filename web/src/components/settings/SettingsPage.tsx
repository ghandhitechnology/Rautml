import { useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { EASE } from '../../lib/motion'
import { cx } from '../../lib/utils'
import { useSettingsError, useSettingsOpen, useSettingsSection, useStore } from '../../state/store'
import type { SettingsSection } from '../../lib/types'
import ModelSettings from './ModelSettings'
import KeySettings from './KeySettings'
import PersonalizationSettings from './PersonalizationSettings'
import './SettingsPage.css'

const SECTIONS: { id: SettingsSection; label: string; blurb: string }[] = [
  { id: 'models', label: 'Model selector', blurb: 'Providers and available models' },
  { id: 'keys', label: 'API keys', blurb: 'Your keys for outside services' },
  { id: 'personalization', label: 'Personalization', blurb: 'Design taste and about you' },
]

/**
 * Full-window settings takeover with its own left nav.
 *
 * Rendered as an overlay beside the shell rather than in place of it: unmounting
 * Layout would tear down the live thread and its SSE-driven view for the length
 * of a settings visit. The shell is marked inert underneath instead.
 *
 * The z-index stays below the Electron drag strip (Layout.css `.rml-desktop-drag`,
 * z-index 200) so the window remains draggable while settings is open.
 */
export function SettingsPage() {
  const open = useSettingsOpen()
  const section = useSettingsSection()
  const error = useSettingsError()
  const setSection = useStore((s) => s.setSettingsSection)
  const closeSettings = useStore((s) => s.closeSettings)
  const paneRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeSettings()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, closeSettings])

  // Move focus into the page so keyboard users are not left behind in the chat,
  // and hand it back to the invoking button on close — otherwise it drops to body.
  const invokerRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (open) {
      invokerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null
      closeRef.current?.focus()
      return
    }
    const invoker = invokerRef.current
    invokerRef.current = null
    if (!invoker) return
    // The shell drops `inert` on this same flip; wait a frame so the invoker is
    // focusable again no matter which component's effect runs first.
    requestAnimationFrame(() => {
      if (useStore.getState().settingsOpen) return // reopened within the frame
      const target = invoker.isConnected
        ? invoker
        : document.querySelector<HTMLElement>('[data-settings-button]')
      target?.focus()
    })
  }, [open])

  // Each section starts at the top rather than inheriting the last one's scroll.
  useEffect(() => {
    paneRef.current?.scrollTo({ top: 0 })
  }, [section])

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="rml-settings"
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.24, ease: EASE }}
        >
          <nav className="rml-settings__nav" aria-label="Settings sections">
            <div className="rml-settings__brand">
              <h1 className="rml-settings__title">Settings</h1>
              <button
                ref={closeRef}
                type="button"
                className="rml-settings__close"
                onClick={closeSettings}
                aria-label="Close settings"
                title="Close settings (Esc)"
              >
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <path d="m5.5 5.5 9 9M14.5 5.5l-9 9" />
                </svg>
              </button>
            </div>

            <ul className="rml-settings__tabs">
              {SECTIONS.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={cx('rml-settings__tab', item.id === section && 'is-active')}
                    aria-current={item.id === section ? 'page' : undefined}
                    onClick={() => setSection(item.id)}
                  >
                    <span className="rml-settings__tab-label">{item.label}</span>
                    <span className="rml-settings__tab-blurb">{item.blurb}</span>
                    {item.id === section ? (
                      <motion.span
                        layoutId="rml-settings-rail"
                        className="rml-settings__rail"
                        aria-hidden="true"
                        transition={{ duration: 0.28, ease: EASE }}
                      />
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          <div className="rml-settings__pane" ref={paneRef}>
            <div className="rml-settings__content">
              {error ? (
                <p className="rml-settings__error" role="alert">
                  {error}
                </p>
              ) : null}
              {section === 'models' ? <ModelSettings /> : null}
              {section === 'keys' ? <KeySettings /> : null}
              {section === 'personalization' ? <PersonalizationSettings /> : null}
            </div>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

export default SettingsPage
