/* VersionPicker — v1 … vN as a segmented pill.
 *
 * The selected segment is a shared-layout thumb (framer-motion `layoutId`), so switching slides
 * rather than blinks. When a new version lands live (asset.version), the pill emits one soft coral
 * ring — a whisper, not a shout — and the card auto-switches to the latest.
 */

import { useEffect, useId, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { cx } from '../../lib/utils'
import { EASE, SPRING } from '../../lib/motion'
import './VersionPicker.css'

export interface VersionPickerProps {
  /** Highest version that exists (asset.latestVersion). Segments are 1…latestVersion. */
  latestVersion: number
  /** Currently displayed version. */
  value: number
  onChange: (version: number) => void
  /** Disable interaction (e.g. while the asset is unavailable). */
  disabled?: boolean
  className?: string
}

const PULSE_MS = 720

export function VersionPicker({
  latestVersion,
  value,
  onChange,
  disabled = false,
  className,
}: VersionPickerProps) {
  const reduceMotion = useReducedMotion()
  const layoutId = useId()
  const [pulsing, setPulsing] = useState(false)
  const previousLatest = useRef(latestVersion)
  const listRef = useRef<HTMLDivElement>(null)

  const count = Math.max(1, Math.floor(latestVersion) || 1)
  const versions = Array.from({ length: count }, (_, i) => i + 1)

  // A version arriving live gets one gentle ring.
  useEffect(() => {
    if (latestVersion > previousLatest.current) {
      previousLatest.current = latestVersion
      setPulsing(true)
      const timer = window.setTimeout(() => setPulsing(false), PULSE_MS)
      return () => window.clearTimeout(timer)
    }
    previousLatest.current = latestVersion
    return
  }, [latestVersion])

  // Keep the active segment in view when there are many versions.
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const active = list.querySelector<HTMLElement>('[data-active="true"]')
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [value, count])

  return (
    <div
      className={cx('rml-vpick', pulsing && 'is-pulsing', disabled && 'is-disabled', className)}
      role="tablist"
      aria-label="Asset version"
    >
      <div className="rml-vpick__list" ref={listRef}>
        {versions.map((v) => {
          const active = v === value
          return (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={active}
              data-active={active}
              className={cx('rml-vpick__seg', active && 'is-active')}
              onClick={() => !active && onChange(v)}
              disabled={disabled}
              title={v === count ? `Version ${v} (latest)` : `Version ${v}`}
            >
              {active && (
                <motion.span
                  layoutId={`vpick-thumb-${layoutId}`}
                  className="rml-vpick__thumb"
                  transition={reduceMotion ? { duration: 0 } : SPRING}
                />
              )}
              <span className="rml-vpick__label">v{v}</span>
            </button>
          )
        })}
      </div>

      <AnimatePresence>
        {pulsing && !reduceMotion && (
          <motion.span
            key="pulse"
            className="rml-vpick__ring"
            initial={{ opacity: 0.5, scale: 0.96 }}
            animate={{ opacity: 0, scale: 1.13 }}
            exit={{ opacity: 0 }}
            transition={{ duration: PULSE_MS / 1000, ease: EASE }}
            aria-hidden="true"
          />
        )}
      </AnimatePresence>
    </div>
  )
}

export default VersionPicker
