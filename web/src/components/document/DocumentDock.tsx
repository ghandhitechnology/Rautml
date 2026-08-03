/* DocumentDock — everything that floats over the document at the bottom of the column.
 *
 * Bottom to top: the composer as a glass pill (the same Composer as the docked chat, so
 * IME-safe Enter and the stop button come along untouched), a compact activity strip while
 * a run is alive, and a dismissible response sheet carrying the model's streaming prose.
 * The sheet is only ever raised for a run we watched live — reloading a finished chat lands
 * on the document, not on a wall of text.
 *
 * Both floating slabs mount/unmount themselves (`Slab` below) rather than leaning on
 * AnimatePresence: an exit that fails to complete there strands an invisible, full-height
 * ghost in this flex column, which shoves the composer off its mark. Owning the lifecycle
 * means the worst case is a slab that lingers *visible*, never one that haunts the layout.
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
import { useActiveChat, useStore } from '../../state/store'
import { cx } from '../../lib/utils'
import { EASE } from '../../lib/motion'
import './DocumentDock.css'

export interface DocumentDockProps {
  className?: string
}

const LIVE = new Set(['running', 'awaiting_input'])

const SHOWN = { opacity: 1, y: 0, scale: 1 }
const HIDDEN = { opacity: 0, y: 12, scale: 0.985 }
const ENTER = { opacity: 0, y: 16, scale: 0.98 }

/* ------------------------------------------------------------------- slab */

/** A floating pane that rises in, and takes itself out of the tree once it has faded. */
function Slab({
  open,
  className,
  label,
  children,
  onGone,
}: {
  open: boolean
  className?: string
  label?: string
  children: ReactNode
  /** Fired after the closing animation, when the slab is about to leave the layout. */
  onGone?: () => void
}) {
  const reduceMotion = useReducedMotion()
  const gone = useRef(onGone)
  gone.current = onGone

  return (
    <motion.section
      className={className}
      aria-label={label}
      initial={reduceMotion ? { opacity: 0 } : ENTER}
      animate={open ? SHOWN : HIDDEN}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.3, ease: EASE }}
      onAnimationComplete={() => {
        if (!open) gone.current?.()
      }}
      aria-hidden={!open}
      style={{ pointerEvents: open ? 'auto' : 'none' }}
    >
      {children}
    </motion.section>
  )
}

/* ------------------------------------------------------------------- dock */

export function DocumentDock({ className }: DocumentDockProps) {
  const state = useActiveChat()
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
  const activityOpen = running && !!timeline && timeline.items.length > 0

  /* Each slab keeps its last content while it fades, then drops out of the column. */
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
