/* DocumentDock — everything that floats over the document at the bottom of the column.
 *
 * Bottom to top: the composer as a glass pill (the same Composer as the docked chat, so
 * IME-safe Enter and the stop button come along untouched), a compact activity strip while
 * a run is alive, and a dismissible response sheet carrying the model's streaming prose.
 * The sheet is only ever raised for a run we watched live — reloading a finished chat lands
 * on the document, not on a wall of text.
 *
 * Opening the conversation overlay fades the floating slabs out in place (layout stays put)
 * so returning to the document reveals them exactly where they were — no rise from the
 * bottom. Slabs only height-collapse when their content is truly gone.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { Composer } from '../shell'
import { ActivityTimeline, Markdown } from '../chat'
import { useActiveChat, useHistoryOpen, useStore } from '../../state/store'
import { cx } from '../../lib/utils'
import { EASE } from '../../lib/motion'
import './DocumentDock.css'

export interface DocumentDockProps {
  className?: string
}

const LIVE = new Set(['running', 'awaiting_input'])

/** Matches `--sp-2`; animated with height so dismissing slabs release the flex gap too. */
const SLAB_GAP = 8

const EXPAND = { duration: 0.32, ease: EASE }
const COLLAPSE = { duration: 0.24, ease: EASE }
const FADE = { duration: 0.2, ease: EASE }
const SNAP = { duration: 0 }

/* ------------------------------------------------------------------- measure */

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

/* ------------------------------------------------------------------- slab */

/**
 * A floating pane. `open` means content still belongs here; `covered` means the chat
 * overlay is up — fade out in place without collapsing, so uncovering looks like it
 * never moved. Leaving the tree only happens after a real close (`!open`).
 */
function Slab({
  open,
  covered,
  className,
  label,
  children,
  onGone,
}: {
  open: boolean
  covered: boolean
  className?: string
  label?: string
  children: ReactNode
  /** Fired after a real close animation, when the slab may leave the layout. */
  onGone?: () => void
}) {
  const reduceMotion = useReducedMotion()
  const [inner, height] = useMeasuredHeight<HTMLDivElement>()
  const gone = useRef(onGone)
  gone.current = onGone

  const visible = open && !covered
  // After a chat cover, the next reveal is a fade — not a fresh expand-from-bottom.
  const [uncover, setUncover] = useState(false)
  useLayoutEffect(() => {
    if (open && covered) setUncover(true)
  }, [open, covered])

  // First entrance may expand; later size changes (streaming) snap so the slab doesn't bob.
  const entered = useRef(false)
  const sized = height > 0 ? height : undefined
  const inPlace = uncover || !visible || entered.current

  return (
    <motion.section
      className="rml-dock__slab"
      aria-label={label}
      initial={
        reduceMotion
          ? { opacity: 0, height: 0, marginBottom: 0 }
          : { opacity: 0, y: 14, scale: 0.985, height: 0, marginBottom: 0 }
      }
      animate={
        !open
          ? {
              opacity: 0,
              y: 10,
              scale: 0.985,
              height: 0,
              marginBottom: 0,
            }
          : {
              opacity: visible ? 1 : 0,
              y: 0,
              scale: 1,
              height: sized ?? 'auto',
              marginBottom: SLAB_GAP,
            }
      }
      transition={
        reduceMotion
          ? { duration: 0 }
          : !open
            ? {
                height: COLLAPSE,
                marginBottom: COLLAPSE,
                opacity: { duration: 0.18, ease: EASE },
                y: COLLAPSE,
                scale: COLLAPSE,
              }
            : inPlace
              ? {
                  // Cover / uncover / live resize: footprint stays put; only opacity fades.
                  height: SNAP,
                  marginBottom: SNAP,
                  opacity: FADE,
                  y: SNAP,
                  scale: SNAP,
                }
              : {
                  height: EXPAND,
                  marginBottom: EXPAND,
                  opacity: FADE,
                  y: EXPAND,
                  scale: EXPAND,
                }
      }
      onAnimationComplete={() => {
        if (open) entered.current = true
        if (visible && uncover) setUncover(false)
        if (!open) gone.current?.()
      }}
      aria-hidden={!visible}
      style={{ pointerEvents: visible ? 'auto' : 'none' }}
    >
      <div ref={inner} className={className}>
        {children}
      </div>
    </motion.section>
  )
}

/* ------------------------------------------------------------------- dock */

export function DocumentDock({ className }: DocumentDockProps) {
  const state = useActiveChat()
  const historyOpen = useHistoryOpen()
  const dismissSheet = useStore((s) => s.dismissSheet)

  const chatId = state?.chat.id ?? null
  const run = state?.activeRun.main ?? null
  const running = !!run && LIVE.has(run.status)
  const runId = run?.id ?? state?.currentRunId.main ?? null
  const timeline = runId ? (state?.timelines[runId] ?? null) : null

  /* The assistant message of the run in flight — the sheet's subject. */
  const liveMessage = useMemo(() => {
    if (!state || !runId) return null
    for (let i = state.messages.main.length - 1; i >= 0; i -= 1) {
      const m = state.messages.main[i]!
      if (m.role === 'assistant' && m.runId === runId) return m
    }
    return null
  }, [state, runId])

  // Sticky: once prose arrives during a live run it stays readable until dismissed or
  // superseded. Never set on hydration, because nothing is running then.
  const [stickyId, setStickyId] = useState<string | null>(null)
  useEffect(() => {
    setStickyId(null)
  }, [chatId])
  useEffect(() => {
    if (running && liveMessage && liveMessage.content.trim()) setStickyId(liveMessage.id)
  }, [running, liveMessage])

  const sheetMessage = useMemo(() => {
    if (!state || !stickyId) return null
    return state.messages.main.find((m) => m.id === stickyId) ?? null
  }, [state, stickyId])

  const dismissed = !!(stickyId && state?.dismissedSheets[stickyId])
  const sheetOpen = !!sheetMessage && !dismissed && !!sheetMessage.content.trim()
  // Opens as soon as the run is live — waiting for the first step is what left
  // the dock blank through the whole reasoning stretch.
  const activityOpen = running && !!timeline

  /* Hold while content is relevant; Slab drops itself after a real close. */
  const [sheetHeld, setSheetHeld] = useState<{ id: string; text: string; streaming: boolean } | null>(
    null,
  )
  useLayoutEffect(() => {
    if (sheetOpen && sheetMessage) {
      setSheetHeld({
        id: sheetMessage.id,
        text: sheetMessage.content,
        streaming: sheetMessage.status === 'streaming',
      })
    }
  }, [sheetOpen, sheetMessage])

  const [activityHeld, setActivityHeld] = useState<string | null>(null)
  useLayoutEffect(() => {
    if (activityOpen && runId) setActivityHeld(runId)
  }, [activityOpen, runId])

  const heldTimeline = activityHeld ? (state?.timelines[activityHeld] ?? null) : null

  const dropSheet = useCallback(() => setSheetHeld(null), [])
  const dropActivity = useCallback(() => setActivityHeld(null), [])

  /* keep the sheet pinned to its newest line while text streams in */
  const proseRef = useRef<HTMLDivElement>(null)
  const proseAtBottom = useRef(true)
  useEffect(() => {
    const el = proseRef.current
    if (!el || !proseAtBottom.current) return
    el.scrollTop = el.scrollHeight
  }, [sheetHeld?.text])

  return (
    <div className={cx('rml-dock', className)}>
      {sheetHeld ? (
        <Slab
          key="sheet"
          open={sheetOpen}
          covered={historyOpen}
          className="rml-dock__sheet"
          label="Response"
          onGone={dropSheet}
        >
          <header className="rml-dock__sheet-bar">
            <span className={cx('rml-dock__pip', running && 'is-live')} aria-hidden="true" />
            <span className="rml-dock__sheet-title">
              {sheetHeld.streaming ? '답변 중 · Responding' : '답변 · Response'}
            </span>
            <button
              type="button"
              className="rml-dock__sheet-close"
              onClick={() => dismissSheet(sheetHeld.id)}
              aria-label="Dismiss this response"
              title="닫기 · Dismiss"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m7 7 10 10M17 7 7 17" />
              </svg>
            </button>
          </header>

          <div
            className="rml-dock__sheet-prose"
            ref={proseRef}
            onScroll={(e) => {
              const el = e.currentTarget
              proseAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
            }}
          >
            <Markdown>{sheetHeld.text}</Markdown>
          </div>
        </Slab>
      ) : null}

      {heldTimeline ? (
        <Slab
          key="activity"
          open={activityOpen}
          covered={historyOpen}
          className="rml-dock__activity"
          label="Activity"
          onGone={dropActivity}
        >
          <ActivityTimeline timeline={heldTimeline} compact />
        </Slab>
      ) : null}

      <div className="rml-dock__composer">
        <Composer thread="main" autoFocus />
      </div>
    </div>
  )
}

export default DocumentDock
