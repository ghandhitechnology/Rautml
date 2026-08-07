/* The thread. Single mount point for everything in components/chat.
 *
 * Composition per turn: bubble → activity timeline → widgets → assets → file
 * cards → input chips. Assets are injected by the assembler through
 * `renderAssets` so this file never reaches into components/asset.
 *
 * Render path: the store flushes stream deltas every 16ms and each flush clones
 * the thread's message array, so the thread subscribes to narrow slices and
 * every turn row is a memo() — an unchanged turn skips the render, extras
 * included. Turns carry their own per-message subscriptions (widgets, files,
 * the run's timeline) so a delta on one turn re-renders that turn only.
 *
 * Scrolling: the shell owns the scroll container (.rml-shell__scroll), so the
 * thread finds its scrollable ancestor, pins to the bottom while you are there,
 * and offers a "jump to latest" pill the moment you scroll away. */

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { EASE } from '../../lib/motion'
import { cx } from '../../lib/utils'
import type { InputRequest, Message, Thread } from '../../lib/types'
import {
  activeChatState,
  useInputRequests,
  useMessages,
  usePresentedFiles,
  useStore,
  useTimeline,
  useTimelines,
  useWidgets,
} from '../../state/store'
import MessageBubble from './MessageBubble'
import ActivityTimeline from './ActivityTimeline'
import InputChips from './InputChips'
import WidgetCard from './WidgetCard'
import { FileCards } from './FileCard'
import { Icon } from './icons'
import './ChatThread.css'

const BOTTOM_SLACK = 96
const EMPTY_RUN_ORDER: string[] = []

/* ------------------------------------------------------------------ scroll */

function resolveScroller(node: HTMLElement | null): HTMLElement | null {
  if (!node) return null
  const named = node.closest<HTMLElement>('.rml-shell__scroll, [data-scroll-container]')
  if (named) return named
  let el = node.parentElement
  while (el && el !== document.body) {
    const overflow = getComputedStyle(el).overflowY
    if (overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') return el
    el = el.parentElement
  }
  return null
}

function jumpToBottom(scroller: HTMLElement, smooth: boolean) {
  if (smooth) {
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' })
    return
  }
  // Bypass the container's CSS `scroll-behavior: smooth` — streaming needs to
  // pin instantly or every delta queues another animation.
  const prev = scroller.style.scrollBehavior
  scroller.style.scrollBehavior = 'auto'
  scroller.scrollTop = scroller.scrollHeight
  scroller.style.scrollBehavior = prev
}

/* --------------------------------------------------------------------- turn */

// User turns are keyed positionally: the store swaps the optimistic `local-…`
// id for the server's on message.start, and an id-based key would
// unmount/remount the bubble mid-animation.
function turnKey(message: Message, index: number): string {
  return message.role === 'user' ? `u${index}` : message.id
}

interface TurnProps {
  message: Message
  thread: Thread
  /** The run's timeline + input chips hang off the run's last message. */
  isAnchor: boolean
  /** Play the entrance animation — false for history that predates this mount. */
  animate: boolean
  /** The thread's input requests (stable identity between input events). */
  requests: InputRequest[]
  compact: boolean
  chatId: string
  renderAssets?: (messageId: string) => ReactNode
}

/* One turn row. Memoized: an unchanged message object means the whole row —
 * bubble, timeline, widgets, cards — survives a delta flush untouched. */
const Turn = memo(function Turn({
  message,
  thread,
  isAnchor,
  animate,
  requests,
  compact,
  chatId,
  renderAssets,
}: TurnProps) {
  const widgets = useWidgets(message.id)
  const files = usePresentedFiles(message.id)
  const timeline = useTimeline(isAnchor ? message.runId : undefined)
  const thinking = useStore(
    (s) =>
      message.role === 'assistant' &&
      message.runId != null &&
      activeChatState(s)?.activeRun[thread]?.id === message.runId,
  )

  const chips = useMemo(
    () => (isAnchor && message.runId ? requests.filter((r) => r.runId === message.runId) : []),
    [requests, isAnchor, message.runId],
  )
  const assets = useMemo(
    () => (message.role === 'assistant' ? renderAssets?.(message.id) : null),
    [renderAssets, message.id, message.role],
  )

  // Kept referentially stable across re-renders whose trigger (a timeline step,
  // a delta) changed nothing below the bubble — MessageBubble's memo depends on it.
  const extras = useMemo(() => {
    const hasTimeline = isAnchor && !!timeline
    if (!hasTimeline && chips.length === 0 && widgets.length === 0 && !assets && files.length === 0) {
      return null
    }
    return (
      <>
        {hasTimeline ? <ActivityTimeline timeline={timeline} compact={compact} /> : null}
        {chips.map((r) => (
          <InputChips key={r.id} request={r} compact={compact} />
        ))}
        {widgets.map((html, i) => (
          <WidgetCard key={`${message.id}-w${i}`} html={html} compact={compact} />
        ))}
        {assets}
        {files.length ? <FileCards files={files} chatId={chatId} compact={compact} /> : null}
      </>
    )
  }, [isAnchor, timeline, chips, widgets, assets, files, compact, chatId, message.id])

  return (
    <motion.div
      className="rml-thread__turn"
      initial={animate ? { opacity: 0, y: 10 } : false}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.32, ease: EASE }}
    >
      <MessageBubble message={message} compact={compact} thinking={thinking}>
        {extras}
      </MessageBubble>
    </motion.div>
  )
})

/* ------------------------------------------------------------- empty state */

const SUGGESTIONS = [
  '카페인이 수면에 미치는 영향을 인터랙티브하게 보여줘',
  'Research the 2026 solid-state battery race and build me a page',
  '베이지안 추론을 시각적으로 설명해줘',
]

function EmptyState({ thread }: { thread: Thread }) {
  const sendMessage = useStore((s) => s.sendMessage)
  return (
    <div className="rml-thread__empty">
      <motion.div
        className="rml-thread__empty-inner"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.42, ease: EASE }}
      >
        <p className="rml-thread__greet-en">What should we look into?</p>
        <p className="rml-thread__greet-ko">오늘은 무엇을 파헤쳐 볼까요?</p>
        <p className="rml-thread__greet-sub">
          Ask for anything — it researches first, then builds something worth looking at.
        </p>

        <ul className="rml-thread__hints">
          {SUGGESTIONS.map((s, i) => (
            <motion.li
              key={s}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.36, ease: EASE, delay: 0.1 + i * 0.06 }}
            >
              <button type="button" onClick={() => void sendMessage(thread, s)}>
                <span>{s}</span>
                <Icon name="arrowDown" size={14} className="rml-thread__hint-arrow" />
              </button>
            </motion.li>
          ))}
        </ul>
      </motion.div>
    </div>
  )
}

/* -------------------------------------------------------------------- view */

export interface ChatThreadProps {
  /** Which thread to render. Defaults to the main conversation. */
  thread?: Thread
  /**
   * Assets attached to an assistant message. Wired by the assembler to
   * components/asset so this module stays inside its ownership boundary.
   */
  renderAssets?: (messageId: string) => ReactNode
  /** Replace the built-in empty state (pass `null` to render nothing). */
  emptyState?: ReactNode | null
  /** Denser everything — used by the fork panel. */
  compact?: boolean
  className?: string
}

export function ChatThread({
  thread = 'main',
  renderAssets,
  emptyState,
  compact = false,
  className,
}: ChatThreadProps) {
  const chatId = useStore((s) => activeChatState(s)?.chat.id ?? null)
  const loading = useStore((s) => activeChatState(s)?.loading ?? false)
  const messages = useMessages(thread)
  const requests = useInputRequests(thread)
  const timelines = useTimelines()
  const runOrder = useStore((s) => activeChatState(s)?.runOrder ?? EMPTY_RUN_ORDER)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [scroller, setScroller] = useState<HTMLElement | null>(null)
  const atBottom = useRef(true)
  const [showJump, setShowJump] = useState(false)

  /* Entrance animations belong to turns that arrive live. Hydrated history
   * must not replay them, so the keys present on the first settled render of
   * each chat are seeded as "already seen"; switching chats re-seeds, and so
   * does the render that flips `loading` off — hydrate() lands the history in
   * the same update. */
  const seeded = useRef<{ chatId: string | null; fresh: boolean; keys: Set<string> }>({
    chatId: null,
    fresh: true,
    keys: new Set(),
  })
  if (seeded.current.chatId !== chatId || seeded.current.fresh || loading) {
    seeded.current = {
      chatId,
      fresh: loading,
      keys: new Set(messages.map((m, i) => turnKey(m, i))),
    }
  }

  useLayoutEffect(() => {
    setScroller(resolveScroller(rootRef.current))
  }, [])

  /* keep `atBottom` honest + drive the jump pill */
  useEffect(() => {
    if (!scroller) return
    const onScroll = () => {
      const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
      const at = distance < BOTTOM_SLACK
      atBottom.current = at
      setShowJump(!at && scroller.scrollHeight - scroller.clientHeight > 160)
    }
    onScroll()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [scroller])

  /* follow growth (streaming text, new rows, expanding timelines) */
  useEffect(() => {
    const node = rootRef.current
    if (!scroller || !node) return
    const ro = new ResizeObserver(() => {
      if (atBottom.current) jumpToBottom(scroller, false)
    })
    ro.observe(node)
    return () => ro.disconnect()
  }, [scroller])

  /* a different conversation always opens at the newest turn */
  useLayoutEffect(() => {
    if (!scroller || !chatId) return
    atBottom.current = true
    setShowJump(false)
    jumpToBottom(scroller, false)
  }, [scroller, chatId])

  const onJump = useCallback(() => {
    if (!scroller) return
    atBottom.current = true
    setShowJump(false)
    jumpToBottom(scroller, true)
  }, [scroller])

  /* Timelines and input requests hang off the last message of their run. */
  const anchorByRun = useMemo(() => {
    const map = new Map<string, string>()
    for (const m of messages) if (m.runId) map.set(m.runId, m.id)
    return map
  }, [messages])

  /* Requests whose run has no anchor message render loose, under the list. */
  const orphanRequests = useMemo(
    () => requests.filter((r) => !r.runId || !anchorByRun.has(r.runId)),
    [requests, anchorByRun],
  )

  const orphanRuns = useMemo(() => {
    return runOrder.filter((runId) => {
      const t = timelines[runId]
      if (!t || t.thread !== thread || anchorByRun.has(runId)) return false
      // A live run shows even with no steps yet — that window is exactly when
      // the reader most needs to see that something is happening.
      return t.items.length > 0 || t.status === 'running' || t.status === 'awaiting_input'
    })
  }, [runOrder, timelines, thread, anchorByRun])

  if (!chatId) return null

  const isEmpty = messages.length === 0 && orphanRuns.length === 0

  return (
    <div
      ref={rootRef}
      className={cx('rml-thread', compact && 'rml-thread--compact', isEmpty && 'is-empty', className)}
      data-thread={thread}
    >
      {isEmpty ? (
        emptyState === undefined ? (
          <EmptyState thread={thread} />
        ) : (
          emptyState
        )
      ) : (
        <div className="rml-thread__list" key={chatId}>
          <AnimatePresence initial={false}>
            {messages.map((message, index) => {
              const key = turnKey(message, index)
              return (
                <Turn
                  key={key}
                  message={message}
                  thread={thread}
                  isAnchor={!!message.runId && anchorByRun.get(message.runId) === message.id}
                  animate={!seeded.current.keys.has(key)}
                  requests={requests}
                  compact={compact}
                  chatId={chatId}
                  renderAssets={renderAssets}
                />
              )
            })}
          </AnimatePresence>

          {orphanRuns.map((runId) => (
            <div className="rml-thread__turn" key={`run-${runId}`}>
              <ActivityTimeline timeline={timelines[runId]} compact={compact} />
            </div>
          ))}

          {orphanRequests.map((r) => (
            <div className="rml-thread__turn" key={`req-${r.id}`}>
              <InputChips request={r} compact={compact} />
            </div>
          ))}

          <div className="rml-thread__tail" aria-hidden="true" />
        </div>
      )}

      <div className="rml-thread__sticky">
        <AnimatePresence>
          {showJump ? (
            <motion.button
              type="button"
              className="rml-thread__jump"
              onClick={onJump}
              initial={{ opacity: 0, y: 8, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.96 }}
              transition={{ duration: 0.24, ease: EASE }}
              aria-label="Jump to the latest message"
            >
              <Icon name="arrowDown" size={14} />
              <span>Jump to latest</span>
            </motion.button>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  )
}

export default ChatThread
