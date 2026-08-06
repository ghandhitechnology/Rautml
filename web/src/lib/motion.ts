/* Shared motion language (CONTRACT.md § Design tokens → Motion).
 * Standard easing [0.22, 1, 0.36, 1], durations 200–450ms, transform/opacity only. */

export const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1]

export const DUR = {
  fast: 0.2,
  base: 0.28,
  slow: 0.42,
} as const

export const transition = {
  fast: { duration: DUR.fast, ease: EASE },
  base: { duration: DUR.base, ease: EASE },
  slow: { duration: DUR.slow, ease: EASE },
} as const

/** Length of the sidebar's collapse/expand slide. Lives here rather than in
 *  Layout so the panel's own contents can sit out the transition without the
 *  two modules importing each other. */
export const SIDEBAR_TRANSITION_MS = 420

/** Spring used for panels sliding in (fork panel, cards settling). */
export const SPRING = { type: 'spring' as const, stiffness: 340, damping: 34, mass: 0.9 }

/** Gentle rise used for list items and freshly appended bubbles. */
export const rise = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: transition.base,
}
