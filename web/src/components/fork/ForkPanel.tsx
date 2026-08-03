/* ForkPanel — the right sidebar the fork ball morphs into.
 *
 * The shell's grid animates the 380px column; this component owns what happens inside:
 * a spring that scales/slides in from the bottom-right corner (where the orb sat), a
 * dissolving coral echo of the orb, the header, the thread and the composer. Closing
 * collapses it back to the ball and returns focus there.
 */

import { useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useChatMeta, useForkOpen, useStore } from '../../state/store'
import { cx } from '../../lib/utils'
import { EASE, SPRING } from '../../lib/motion'
import ForkComposer from './ForkComposer'
import ForkThread from './ForkThread'
import './ForkPanel.css'

export interface ForkPanelProps {
  /** Header title. Defaults to "Follow-up". */
  title?: string
  /** Header subtitle. Defaults to the open chat's title. */
  subtitle?: string
  className?: string
}

export function ForkPanel({ title = 'Follow-up', subtitle, className }: ForkPanelProps) {
  const forkOpen = useForkOpen()
  const chat = useChatMeta()
  const setForkOpen = useStore((s) => s.setForkOpen)

  const close = () => {
    setForkOpen(false)
    // Hand focus back to the orb the panel collapses into.
    requestAnimationFrame(() => {
      const ball = document.querySelector<HTMLButtonElement>('[data-slot="fork-ball"] button')
      ball?.focus()
    })
  }

  useEffect(() => {
    if (!forkOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forkOpen])

  return (
    <AnimatePresence initial={false}>
      {forkOpen ? (
        <motion.section
          key="fork-panel"
          className={cx('rml-fork', className)}
          style={{ transformOrigin: '100% 100%' }}
          initial={{ opacity: 0, x: 30, scale: 0.94 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          exit={{ opacity: 0, x: 24, scale: 0.96, transition: { duration: 0.22, ease: EASE } }}
          transition={SPRING}
          aria-label="Follow-up thread"
        >
          {/* the orb, dissolving into the panel it became */}
          <motion.span
            className="rml-fork__echo"
            aria-hidden="true"
            initial={{ opacity: 0.5, scale: 0.35 }}
            animate={{ opacity: 0, scale: 1.6 }}
            transition={{ duration: 0.5, ease: EASE }}
          />

          <header className="rml-fork__header">
            <div className="rml-fork__lead">
              <h2 className="rml-fork__title">{title}</h2>
              <p className="rml-fork__sub" title={subtitle ?? chat?.title}>
                {subtitle ?? chat?.title ?? 'this conversation'}
              </p>
            </div>

            <button
              type="button"
              className="rml-fork__close"
              onClick={close}
              aria-label="Close follow-up panel"
              title="Close (Esc)"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m7 7 10 10M17 7 7 17" />
              </svg>
            </button>
          </header>

          <ForkThread />
          <ForkComposer />
        </motion.section>
      ) : null}
    </AnimatePresence>
  )
}

export default ForkPanel
