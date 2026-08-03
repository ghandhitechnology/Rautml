/* Live activity strip for one run.
 *
 * While the run is alive the strip is open and rows stream in as tool.start /
 * tool.end land (height animates to a measured content height, rows fade+rise).
 * When the run finishes it collapses itself to "Worked for 12s · 5 steps";
 * clicking the header re-expands it and that choice sticks. */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { EASE } from '../../lib/motion'
import { cx, formatDuration } from '../../lib/utils'
import type { RunTimeline, TimelineItem } from '../../lib/types'
import { Icon, toolIcon } from './icons'
import './ActivityTimeline.css'

const LIVE = new Set(['running', 'awaiting_input'])

/** Measured height of an element, kept fresh through a ResizeObserver. */
function useMeasuredHeight<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  const [height, setHeight] = useState(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => setHeight(el.getBoundingClientRect().height)
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return [ref, height] as const
}

/** Ticks once a second while `active`, so the live elapsed label stays honest. */
function useTicker(active: boolean) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => setTick((t) => t + 1), 1000)
    return () => window.clearInterval(id)
  }, [active])
}

/** Latest timestamp we know about — the fallback end for a run whose completion we never saw. */
function lastActivity(timeline: RunTimeline): number {
  let last = timeline.firstStepAt ?? timeline.startedAt
  for (const item of timeline.items) last = Math.max(last, item.endedAt ?? item.startedAt)
  return last
}

function StatusGlyph({ status }: { status: TimelineItem['status'] }) {
  return (
    <span className={cx('rml-tl__status', `is-${status}`)}>
      <AnimatePresence initial={false} mode="wait">
        {status === 'running' ? (
          <motion.span
            key="spin"
            className="rml-tl__spinner"
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.6 }}
            transition={{ duration: 0.2, ease: EASE }}
          />
        ) : (
          <motion.span
            key={status}
            className="rml-tl__mark"
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.5 }}
            transition={{ duration: 0.24, ease: EASE }}
          >
            <Icon name={status === 'error' ? 'cross' : 'check'} size={12} />
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  )
}

function Row({ item }: { item: TimelineItem }) {
  return (
    <motion.li
      className={cx('rml-tl__row', `is-${item.status}`)}
      initial={{ opacity: 0, y: -5 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.28, ease: EASE }}
    >
      <span className="rml-tl__icon">
        <Icon name={toolIcon(item.name)} size={14} />
      </span>
      <span className="rml-tl__label" title={item.label}>
        {item.label}
      </span>
      {item.summary ? (
        <span className="rml-tl__summary" title={item.summary}>
          {item.summary}
        </span>
      ) : null}
      <StatusGlyph status={item.status} />
    </motion.li>
  )
}

export interface ActivityTimelineProps {
  timeline: RunTimeline | null | undefined
  /** Denser rows for the fork panel. */
  compact?: boolean
  /** Start expanded regardless of run state (default: expanded while live). */
  defaultExpanded?: boolean
  className?: string
}

export function ActivityTimeline({
  timeline,
  compact = false,
  defaultExpanded,
  className,
}: ActivityTimelineProps) {
  const live = !!timeline && LIVE.has(timeline.status)
  const [expanded, setExpanded] = useState(defaultExpanded ?? live)
  const pinned = useRef(defaultExpanded !== undefined)
  const wasLive = useRef(live)
  const [inner, height] = useMeasuredHeight<HTMLDivElement>()

  useTicker(live)

  // Open on start, self-collapse on finish — unless the reader took control.
  useEffect(() => {
    if (live && !wasLive.current && !pinned.current) setExpanded(true)
    if (!live && wasLive.current && !pinned.current) setExpanded(false)
    wasLive.current = live
  }, [live])

  if (!timeline || timeline.items.length === 0) return null

  const steps = timeline.items.length
  // Anchored on the run's first real step and closed by its completion event — both are
  // server timestamps (ChatEvent.at), so this reads the same before and after a reload.
  const from = timeline.firstStepAt ?? timeline.items[0]?.startedAt ?? timeline.startedAt
  const to = timeline.endedAt ?? (live ? Date.now() : lastActivity(timeline))
  const elapsed = Math.max(0, to - from)
  const failed = timeline.items.some((i) => i.status === 'error')

  const summary = live
    ? `Working · ${formatDuration(elapsed)}`
    : `Worked for ${formatDuration(elapsed)} · ${steps} step${steps === 1 ? '' : 's'}`

  return (
    <section
      className={cx(
        'rml-tl',
        compact && 'rml-tl--compact',
        live && 'is-live',
        failed && 'has-error',
        expanded && 'is-expanded',
        className,
      )}
      aria-label="Activity"
    >
      <button
        type="button"
        className="rml-tl__head"
        onClick={() => {
          pinned.current = true
          setExpanded((v) => !v)
        }}
        aria-expanded={expanded}
      >
        <span className="rml-tl__pip" aria-hidden="true" />
        <span className="rml-tl__summary-text">{summary}</span>
        <span className="rml-tl__chevron" aria-hidden="true">
          <Icon name="chevron" size={14} />
        </span>
      </button>

      <motion.div
        className="rml-tl__panel"
        initial={false}
        animate={{ height: expanded ? height : 0, opacity: expanded ? 1 : 0 }}
        transition={{
          height: { duration: 0.34, ease: EASE },
          opacity: { duration: expanded ? 0.28 : 0.16, ease: EASE },
        }}
        style={{ overflow: 'hidden' }}
        aria-hidden={!expanded}
      >
        <div ref={inner} className="rml-tl__inner">
          <ul className="rml-tl__list">
            <AnimatePresence initial={false}>
              {timeline.items.map((item) => (
                <Row key={item.toolCallId} item={item} />
              ))}
            </AnimatePresence>
          </ul>
        </div>
      </motion.div>
    </section>
  )
}

export default ActivityTimeline
