/* Live activity strip for one run.
 *
 * While the run is alive the strip is open and rows stream in as tool.start /
 * tool.end land (height animates to a measured content height, rows fade+rise).
 * When the run finishes it collapses itself to "Worked for 12s · 5 steps";
 * clicking the header re-expands it and that choice sticks. */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { EASE } from '../../lib/motion'
import { cx, formatDuration } from '../../lib/utils'
import type { RunTimeline, SubagentRun, TimelineItem } from '../../lib/types'
import { Icon, toolIcon } from './icons'
import './ActivityTimeline.css'

const LIVE = new Set(['running', 'awaiting_input'])

// Critically damped: it keeps up with bursts of tool calls without overshooting.
const EXPAND = { type: 'spring' as const, stiffness: 360, damping: 36, mass: 0.85 }
const COLLAPSE = { duration: 0.2, ease: EASE }

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
  for (const sub of timeline.subagents ?? []) last = Math.max(last, sub.endedAt ?? sub.startedAt)
  return last
}

function StatusGlyph({
  status,
  reduceMotion,
}: {
  status: TimelineItem['status']
  reduceMotion: boolean
}) {
  return (
    <span className={cx('rml-tl__status', `is-${status}`)}>
      <AnimatePresence initial={false} mode="wait">
        {status === 'running' ? (
          <motion.span
            key="spin"
            className="rml-tl__spinner"
            initial={reduceMotion ? false : { opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduceMotion ? undefined : { opacity: 0, scale: 0.6 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.2, ease: EASE }}
          />
        ) : (
          <motion.span
            key={status}
            className="rml-tl__mark"
            initial={reduceMotion ? false : { opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduceMotion ? undefined : { opacity: 0, scale: 0.5 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.24, ease: EASE }}
          >
            <Icon name={status === 'error' ? 'cross' : 'check'} size={12} />
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  )
}

function Row({ item, reduceMotion }: { item: TimelineItem; reduceMotion: boolean }) {
  return (
    <motion.li
      layout="position"
      className={cx('rml-tl__row', `is-${item.status}`)}
      initial={reduceMotion ? false : { opacity: 0, y: -6, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduceMotion ? undefined : { opacity: 0, y: -3 }}
      transition={
        reduceMotion
          ? { duration: 0 }
          : {
              layout: EXPAND,
              y: EXPAND,
              scale: EXPAND,
              opacity: { duration: 0.2, ease: EASE },
            }
      }
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
      <StatusGlyph status={item.status} reduceMotion={reduceMotion} />
    </motion.li>
  )
}

/** Compact composer-chip label for a subagent's model. */
const SUBAGENT_MODEL_LABELS: Record<string, string> = {
  'x-ai/grok-4.5': 'Grok 4.5',
  'openai/gpt-5.6-luna': 'Luna',
}

function subagentModelLabel(model: string): string {
  return SUBAGENT_MODEL_LABELS[model] ?? model.split('/').pop() ?? model
}

/** Tail of the subagent's stream, flattened to one line for the live preview. */
function streamTail(text: string, max = 110): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `…${flat.slice(flat.length - max)}`
}

/**
 * One spawned research subagent: its own header, its own nested tool rows and
 * its own streamed text. Expanded while it runs, collapses to one line when it
 * reports — unless the reader took control of the toggle.
 */
function SubagentGroup({ sub, reduceMotion }: { sub: SubagentRun; reduceMotion: boolean }) {
  const running = sub.status === 'running'
  const [open, setOpen] = useState(running)
  const pinned = useRef(false)
  const wasRunning = useRef(running)

  useEffect(() => {
    if (running && !wasRunning.current && !pinned.current) setOpen(true)
    if (!running && wasRunning.current && !pinned.current) setOpen(false)
    wasRunning.current = running
  }, [running])

  const endFallback = sub.items.reduce(
    (last, i) => Math.max(last, i.endedAt ?? i.startedAt),
    sub.startedAt,
  )
  const elapsed = Math.max(0, (sub.endedAt ?? (running ? Date.now() : endFallback)) - sub.startedAt)
  const meta = running
    ? formatDuration(elapsed)
    : (sub.summary ?? `${formatDuration(elapsed)} · ${sub.items.length} step${sub.items.length === 1 ? '' : 's'}`)

  return (
    <motion.li
      layout="position"
      className={cx('rml-tl__sub', `is-${sub.status}`, open && 'is-open')}
      initial={reduceMotion ? false : { opacity: 0, y: -6, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduceMotion ? undefined : { opacity: 0, y: -3 }}
      transition={
        reduceMotion
          ? { duration: 0 }
          : { layout: EXPAND, y: EXPAND, scale: EXPAND, opacity: { duration: 0.2, ease: EASE } }
      }
    >
      <button
        type="button"
        className="rml-tl__sub-head"
        onClick={() => {
          pinned.current = true
          setOpen((v) => !v)
        }}
        aria-expanded={open}
      >
        <span className="rml-tl__icon">
          <Icon name="stack" size={14} />
        </span>
        <span className="rml-tl__label" title={sub.title}>
          {sub.title}
        </span>
        <span className="rml-tl__sub-model">{subagentModelLabel(sub.model)}</span>
        <span className="rml-tl__summary" title={meta}>
          {meta}
        </span>
        <StatusGlyph status={sub.status} reduceMotion={reduceMotion} />
      </button>

      {open ? (
        <div className="rml-tl__sub-body">
          {sub.items.length > 0 ? (
            <ul className="rml-tl__list rml-tl__sub-list">
              <AnimatePresence initial={false}>
                {sub.items.map((item) => (
                  <Row key={item.toolCallId} item={item} reduceMotion={reduceMotion} />
                ))}
              </AnimatePresence>
            </ul>
          ) : null}
          {sub.text ? <div className="rml-tl__sub-text">{sub.text}</div> : null}
        </div>
      ) : running && sub.text ? (
        <div className="rml-tl__sub-tail" aria-hidden="true">
          {streamTail(sub.text)}
        </div>
      ) : null}
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
  const reduceMotion = !!useReducedMotion()

  useTicker(live)

  // Open on start, self-collapse on finish — unless the reader took control.
  useEffect(() => {
    if (live && !wasLive.current && !pinned.current) setExpanded(true)
    if (!live && wasLive.current && !pinned.current) setExpanded(false)
    wasLive.current = live
  }, [live])

  const subagents = timeline?.subagents ?? []

  // A live run always shows its header, even before the first step: the whole
  // reasoning stretch happens here, and hiding it is what made the UI go quiet.
  if (!timeline || (!live && timeline.items.length === 0 && subagents.length === 0)) return null

  // Each subagent group renders right under the spawn_subagents row it came from.
  const byParent = new Map<string, SubagentRun[]>()
  for (const sub of subagents) {
    const list = byParent.get(sub.parentToolCallId) ?? []
    list.push(sub)
    byParent.set(sub.parentToolCallId, list)
  }
  const itemIds = new Set(timeline.items.map((i) => i.toolCallId))
  const rendered: ReactNode[] = []
  for (const item of timeline.items) {
    rendered.push(<Row key={item.toolCallId} item={item} reduceMotion={reduceMotion} />)
    for (const sub of byParent.get(item.toolCallId) ?? []) {
      rendered.push(<SubagentGroup key={sub.subagentId} sub={sub} reduceMotion={reduceMotion} />)
    }
  }
  for (const sub of subagents) {
    if (!itemIds.has(sub.parentToolCallId)) {
      rendered.push(<SubagentGroup key={sub.subagentId} sub={sub} reduceMotion={reduceMotion} />)
    }
  }

  const steps = timeline.items.length + subagents.reduce((n, s) => n + s.items.length, 0)
  // Anchored on the run's first real step and closed by its completion event — both are
  // server timestamps (ChatEvent.at), so this reads the same before and after a reload.
  // Live, the honest clock is "since you pressed send" — it must not jump
  // backwards when the first step finally lands and sets firstStepAt.
  const from = live
    ? timeline.startedAt
    : (timeline.firstStepAt ?? timeline.items[0]?.startedAt ?? timeline.startedAt)
  const to = timeline.endedAt ?? (live ? Date.now() : lastActivity(timeline))
  const elapsed = Math.max(0, to - from)
  const failed =
    timeline.items.some((i) => i.status === 'error') || subagents.some((s) => s.status === 'error')

  // While live the header carries the phase — "Thinking…", or the reasoning
  // headline once one arrives — so it keeps moving between tool rows.
  const summary = live
    ? `${timeline.phaseLabel || 'Working'} · ${formatDuration(elapsed)}`
    : `Worked for ${formatDuration(elapsed)} · ${steps} step${steps === 1 ? '' : 's'}`

  const open = expanded && rendered.length > 0

  return (
    <section
      className={cx(
        'rml-tl',
        compact && 'rml-tl--compact',
        live && 'is-live',
        failed && 'has-error',
        open && 'is-expanded',
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
        aria-expanded={open}
      >
        <span className="rml-tl__pip" aria-hidden="true" />
        <span className="rml-tl__summary-text">{summary}</span>
        <span className="rml-tl__chevron" aria-hidden="true">
          <Icon name="chevron" size={14} />
        </span>
      </button>

      {/* Before the first step there is nothing to open into — the header alone
          carries the phase, so the panel stays shut rather than gaping. */}
      <motion.div
        className="rml-tl__panel"
        initial={live && open && !reduceMotion ? { height: 0, opacity: 0 } : false}
        animate={{ height: open ? height : 0, opacity: open ? 1 : 0 }}
        transition={
          reduceMotion
            ? { duration: 0 }
            : {
                height: open ? EXPAND : COLLAPSE,
                opacity: { duration: open ? 0.22 : 0.14, ease: EASE },
              }
        }
        style={{ overflow: 'hidden' }}
        aria-hidden={!open}
      >
        <div ref={inner} className="rml-tl__inner">
          <ul className="rml-tl__list">
            <AnimatePresence initial={false}>{rendered}</AnimatePresence>
          </ul>
        </div>
      </motion.div>
    </section>
  )
}

export default ActivityTimeline
