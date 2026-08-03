/* EffortSlider — the reasoning-effort dial inside the model popover.
 *
 * Feels continuous while it slides, but each provider value is a gravity well:
 * during a drag the thumb is gently pulled toward the nearest detent
 * (gaussian falloff, so the pull only wakes up close to a stop), and on
 * release it springs onto the winner. Clicking a label or the track jumps
 * straight there. The values are the provider's wire values, shown verbatim.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'framer-motion'
import type { MotionValue } from 'framer-motion'
import { cx } from '../../lib/utils'

export interface EffortSliderProps {
  /** Provider wire values, ascending (e.g. ['none','low','medium','high','xhigh','max']). */
  efforts: string[]
  value: string
  onChange: (effort: string) => void
}

/** Horizontal inset so the thumb's center can reach both extreme detents. */
const PAD = 10
/** How strongly a detent pulls the thumb toward itself while dragging (0..1). */
const MAGNET = 0.55
/** Snap spring: quick, with just enough bounce to feel the detent engage. */
const SNAP = { type: 'spring' as const, stiffness: 520, damping: 34, mass: 0.6 }

function nearestIndex(px: number, detents: number[]): number {
  let best = 0
  for (let i = 1; i < detents.length; i++) {
    if (Math.abs(detents[i]! - px) < Math.abs(detents[best]! - px)) best = i
  }
  return best
}

/** One tick on the track; swells as the thumb approaches (its own hook scope). */
function Detent({ x, at }: { x: MotionValue<number>; at: number }) {
  const scale = useTransform(x, (v) => 1 + 0.9 * Math.exp(-(((v - at) / 14) ** 2)))
  const opacity = useTransform(x, (v) => (Math.abs(v - at) < 7 ? 0 : 1))
  return <motion.span className="rml-effort__dot" style={{ left: at, scale, opacity }} />
}

export function EffortSlider({ efforts, value, onChange }: EffortSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const reduceMotion = useReducedMotion()

  const valueIndex = Math.max(0, efforts.indexOf(value))
  /** Index the thumb is nearest to right now (live during a drag). */
  const [liveIndex, setLiveIndex] = useState(valueIndex)

  const x = useMotionValue(PAD)
  const dragging = useRef(false)

  const usable = Math.max(0, width - PAD * 2)
  const detents =
    efforts.length > 1
      ? efforts.map((_, i) => PAD + (usable * i) / (efforts.length - 1))
      : [PAD + usable / 2]

  useLayoutEffect(() => {
    const el = trackRef.current
    if (!el) return
    const measure = () => setWidth(el.getBoundingClientRect().width)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Settle onto the current value whenever it, the model, or the width changes.
  useEffect(() => {
    if (dragging.current || width === 0) return
    const target = detents[valueIndex] ?? PAD
    setLiveIndex(valueIndex)
    if (reduceMotion) x.set(target)
    else animate(x, target, SNAP)
    // detents derives from width + efforts; valueIndex from value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueIndex, width, efforts.join('|'), reduceMotion])

  /** Raw pointer position → magnetized thumb position. */
  const magnetize = useCallback(
    (raw: number) => {
      const near = detents[nearestIndex(raw, detents)]!
      const spacing = detents.length > 1 ? detents[1]! - detents[0]! : usable || 1
      const d = near - raw
      // Gaussian well: no pull mid-span, a firm but soft tug near each stop.
      const pull = d * MAGNET * Math.exp(-((d / (spacing * 0.4)) ** 2))
      return raw + pull
    },
    [detents, usable],
  )

  const positionFromEvent = useCallback((e: ReactPointerEvent) => {
    const rect = trackRef.current!.getBoundingClientRect()
    return Math.min(rect.width - PAD, Math.max(PAD, e.clientX - rect.left))
  }, [])

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || width === 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragging.current = true
    const raw = positionFromEvent(e)
    setLiveIndex(nearestIndex(raw, detents))
    if (reduceMotion) x.set(magnetize(raw))
    else animate(x, magnetize(raw), { type: 'spring', stiffness: 700, damping: 40 })
  }

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    const raw = positionFromEvent(e)
    x.stop()
    x.set(magnetize(raw))
    setLiveIndex(nearestIndex(raw, detents))
  }

  const settle = (index: number) => {
    const target = detents[index] ?? PAD
    setLiveIndex(index)
    if (reduceMotion) x.set(target)
    else animate(x, target, SNAP)
    const effort = efforts[index]
    if (effort && effort !== value) onChange(effort)
  }

  const handlePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    dragging.current = false
    e.currentTarget.releasePointerCapture(e.pointerId)
    settle(nearestIndex(positionFromEvent(e), detents))
  }

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.min(efforts.length - 1, valueIndex + 1)
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(0, valueIndex - 1)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = efforts.length - 1
    if (next === null) return
    e.preventDefault()
    settle(next)
  }

  return (
    <div className="rml-effort">
      <div
        ref={trackRef}
        className="rml-effort__track"
        role="slider"
        tabIndex={0}
        aria-label="Reasoning effort"
        aria-valuemin={0}
        aria-valuemax={efforts.length - 1}
        aria-valuenow={valueIndex}
        aria-valuetext={value}
        aria-orientation="horizontal"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={handleKeyDown}
      >
        <div className="rml-effort__rail" />
        <motion.div className="rml-effort__fill" style={{ width: x }} />
        {detents.map((at, i) => (
          <Detent key={efforts[i]} x={x} at={at} />
        ))}
        <motion.div className="rml-effort__thumb" style={{ x }} />
      </div>

      <div className="rml-effort__labels">
        {efforts.map((effort, i) => (
          <button
            key={effort}
            type="button"
            tabIndex={-1}
            className={cx('rml-effort__label', i === liveIndex && 'is-active')}
            style={{ left: detents[i] }}
            onClick={() => settle(i)}
          >
            {effort}
          </button>
        ))}
      </div>
    </div>
  )
}

export default EffortSlider
