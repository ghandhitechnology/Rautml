/* ForkBall — the floating coral orb at the bottom-right of the chat column.
 *
 * Appears (spring pop) once the open chat has at least one asset, idles with a slow
 * float, pulses a ring whenever a new asset lands, and hides itself while the fork
 * panel is open (the panel is what it "morphs" into).
 *
 * Mounts into App.tsx's [data-slot="fork-ball"] — that slot is already absolutely
 * positioned bottom-right of the main column, so this component owns no positioning
 * beyond its own layout row (tooltip + orb).
 */

import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useActiveChatId, useAssets, useForkOpen, useIsRunning, useStore } from '../../state/store'
import { cx } from '../../lib/utils'
import { EASE } from '../../lib/motion'
import './ForkBall.css'

export interface ForkBallProps {
  /** Tooltip + accessible label. */
  label?: string
  /** Show the ball even when the chat has no assets yet. */
  alwaysVisible?: boolean
  /** Defaults to opening the fork panel. */
  onClick?: () => void
  className?: string
}

const POP = { type: 'spring' as const, stiffness: 520, damping: 26, mass: 0.8 }

export function ForkBall({ label = 'Follow-up', alwaysVisible = false, onClick, className }: ForkBallProps) {
  const activeChatId = useActiveChatId()
  const assets = useAssets()
  const forkOpen = useForkOpen()
  const forkRunning = useIsRunning('fork')
  const setForkOpen = useStore((s) => s.setForkOpen)
  const reduceMotion = useReducedMotion()

  const assetCount = assets.length
  const seen = useRef(assetCount)
  const [pulseKey, setPulseKey] = useState(0)

  // A fresh asset (not the first one — that one gets the entrance pop) rings the orb.
  useEffect(() => {
    if (assetCount > seen.current && seen.current > 0) setPulseKey((k) => k + 1)
    seen.current = assetCount
  }, [assetCount])

  const visible = !!activeChatId && !forkOpen && (alwaysVisible || assetCount > 0)

  return (
    <AnimatePresence>
      {visible ? (
        <motion.div
          className={cx('rml-forkball', className)}
          initial={{ opacity: 0, scale: 0.35, y: 14 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.42, y: 6, transition: { duration: 0.2, ease: EASE } }}
          transition={POP}
        >
          <span className="rml-forkball__tip" aria-hidden="true">
            {label}
          </span>

          <motion.button
            type="button"
            className={cx('rml-forkball__btn', forkRunning && 'is-running')}
            onClick={() => (onClick ? onClick() : setForkOpen(true))}
            aria-label={label}
            title={label}
            animate={reduceMotion ? undefined : { y: [0, -4.5, 0] }}
            transition={
              reduceMotion
                ? undefined
                : { duration: 4.6, repeat: Infinity, ease: 'easeInOut', delay: 0.4 }
            }
            whileHover={{ scale: 1.06 }}
            whileTap={{ scale: 0.94 }}
          >
            <span className="rml-forkball__halo" aria-hidden="true" />

            <svg
              className="rml-forkball__glyph"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="7" cy="5.9" r="2.1" />
              <circle cx="7" cy="18.1" r="2.1" />
              <circle cx="17.4" cy="11" r="2.1" />
              <path d="M7 8v8" />
              <path d="M9 6.9c3.3 1 4.4 2.2 6.4 3.3" />
            </svg>

            <AnimatePresence>
              {pulseKey > 0 ? (
                <motion.span
                  key={pulseKey}
                  className="rml-forkball__ring"
                  aria-hidden="true"
                  initial={{ opacity: 0.55, scale: 0.82 }}
                  animate={{ opacity: 0, scale: 1.85 }}
                  transition={{ duration: 0.9, ease: EASE }}
                />
              ) : null}
            </AnimatePresence>

            <span className="rml-forkball__spin" aria-hidden="true" />
          </motion.button>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

export default ForkBall
