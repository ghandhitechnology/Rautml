import { AnimatePresence, motion } from 'framer-motion'
import { useStore, useTheme } from '../../state/store'
import { cx } from '../../lib/utils'
import { EASE } from '../../lib/motion'
import './ThemeToggle.css'

export interface ThemeToggleProps {
  className?: string
}

/** Sun ⇄ moon with a small rotate-and-settle micro-animation (transform/opacity only). */
export function ThemeToggle({ className }: ThemeToggleProps) {
  const theme = useTheme()
  const toggleTheme = useStore((s) => s.toggleTheme)
  const isDark = theme === 'dark'

  return (
    <button
      type="button"
      className={cx('rml-theme-toggle', className)}
      onClick={toggleTheme}
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      title={isDark ? 'Light mode' : 'Dark mode'}
    >
      <AnimatePresence initial={false} mode="popLayout">
        {isDark ? (
          <motion.span
            key="moon"
            className="rml-theme-toggle__icon"
            initial={{ opacity: 0, rotate: -70, scale: 0.6 }}
            animate={{ opacity: 1, rotate: 0, scale: 1 }}
            exit={{ opacity: 0, rotate: 70, scale: 0.6 }}
            transition={{ duration: 0.28, ease: EASE }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.7 8.7 0 1 0 11.1 11.1Z" />
            </svg>
          </motion.span>
        ) : (
          <motion.span
            key="sun"
            className="rml-theme-toggle__icon"
            initial={{ opacity: 0, rotate: 70, scale: 0.6 }}
            animate={{ opacity: 1, rotate: 0, scale: 1 }}
            exit={{ opacity: 0, rotate: -70, scale: 0.6 }}
            transition={{ duration: 0.28, ease: EASE }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="4.1" />
              <path d="M12 2.6v2.1M12 19.3v2.1M4.4 4.4l1.5 1.5M18.1 18.1l1.5 1.5M2.6 12h2.1M19.3 12h2.1M4.4 19.6l1.5-1.5M18.1 5.9l1.5-1.5" />
            </svg>
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  )
}

export default ThemeToggle
