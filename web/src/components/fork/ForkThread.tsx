/* ForkThread — the mini chat inside the fork panel.
 *
 * Everything it renders comes from the store's fork-thread slice: messages, the fork
 * run's timeline, and any ask_user_input_v0 chips addressed to the fork. Nothing is
 * imported from components/chat — the fork owns its own bubbles, timeline and markdown.
 */

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  useActiveRun,
  useInputRequests,
  useIsRunning,
  useMessages,
  useStore,
  useTimeline,
} from '../../state/store'
import type { InputRequest, Message } from '../../lib/types'
import { cx } from '../../lib/utils'
import { EASE } from '../../lib/motion'
import ForkMarkdown from './ForkMarkdown'
import ForkTimeline from './ForkTimeline'
import './ForkThread.css'

export interface ForkThreadProps {
  /** Replaces the built-in empty state. */
  empty?: ReactNode
  className?: string
}

const SUGGESTIONS = [
  'Summarize this conversation',
  'Explain the latest asset',
  'Which sources back this up?',
]

/* ----------------------------------------------------------------- bubbles */

function UserBubble({ message }: { message: Message }) {
  return (
    <motion.div
      className="rml-forkmsg rml-forkmsg--user"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: EASE }}
    >
      <div className="rml-forkmsg__bubble">{message.content}</div>
    </motion.div>
  )
}

function AssistantBlock({ message }: { message: Message }) {
  const streaming = message.status === 'streaming'
  const empty = message.content.trim().length === 0

  return (
    <motion.div
      className={cx('rml-forkmsg', 'rml-forkmsg--assistant', message.status === 'error' && 'is-error')}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: EASE }}
    >
      <ForkTimeline runId={message.runId} />
      {empty ? (
        streaming ? (
          <ThinkingDots />
        ) : (
          <p className="rml-forkmsg__quiet">No response.</p>
        )
      ) : (
        <div className="rml-forkmsg__body">
          <ForkMarkdown>{message.content}</ForkMarkdown>
          {streaming ? <span className="rml-forkmsg__caret" aria-hidden="true" /> : null}
        </div>
      )}
    </motion.div>
  )
}

function ThinkingDots() {
  return (
    <div className="rml-forkdots" role="status" aria-label="Thinking">
      <span />
      <span />
      <span />
    </div>
  )
}

/* -------------------------------------------------------------------- chips */

function ForkChips({
  request,
  onPick,
}: {
  request: InputRequest
  onPick: (value: string) => void
}) {
  return (
    <motion.div
      className={cx('rml-forkchips', request.resolved && 'is-resolved')}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: EASE }}
    >
      <p className="rml-forkchips__q">{request.question}</p>
      <div className="rml-forkchips__row">
        {request.options.map((option) => (
          <button
            key={option}
            type="button"
            className={cx('rml-forkchips__chip', request.value === option && 'is-picked')}
            disabled={request.resolved}
            onClick={() => onPick(option)}
          >
            {option}
          </button>
        ))}
      </div>
    </motion.div>
  )
}

/* ------------------------------------------------------------------- thread */

export function ForkThread({ empty, className }: ForkThreadProps) {
  const messages = useMessages('fork')
  const inputs = useInputRequests('fork')
  const running = useIsRunning('fork')
  const activeRun = useActiveRun('fork')
  const activeRunId = activeRun?.id
  const liveTimeline = useTimeline(activeRunId)
  const sendMessage = useStore((s) => s.sendMessage)
  const resolveInput = useStore((s) => s.resolveInput)

  const scrollRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [atBottom, setAtBottom] = useState(true)

  const steps = liveTimeline?.items.length ?? 0
  const awaitingFirstToken =
    running && !!activeRunId && !messages.some((m) => m.role === 'assistant' && m.runId === activeRunId)

  // Stay pinned to the newest token unless the reader scrolled up to re-read something.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || !stick.current) return
    el.scrollTop = el.scrollHeight
  }, [messages, inputs, running, steps])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 72
    stick.current = near
    setAtBottom(near)
  }

  const jump = () => {
    const el = scrollRef.current
    if (!el) return
    stick.current = true
    setAtBottom(true)
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  const isEmpty = messages.length === 0 && inputs.length === 0 && !running

  return (
    <div className={cx('rml-forkthread', className)}>
      <div className="rml-forkthread__scroll" ref={scrollRef} onScroll={onScroll}>
        {isEmpty ? (
          (empty ?? (
            <div className="rml-forkempty">
              <span className="rml-forkempty__mark" aria-hidden="true">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="7" cy="5.9" r="2.1" />
                  <circle cx="7" cy="18.1" r="2.1" />
                  <circle cx="17.4" cy="11" r="2.1" />
                  <path d="M7 8v8" />
                  <path d="M9 6.9c3.3 1 4.4 2.2 6.4 3.3" />
                </svg>
              </span>
              <h3 className="rml-forkempty__title">Ask on the side</h3>
              <p className="rml-forkempty__copy">
                A focused thread about this conversation and everything it has built. Answers stay
                here — the main chat keeps its flow.
              </p>
              <div className="rml-forkempty__chips">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="rml-forkempty__chip"
                    onClick={() => void sendMessage('fork', s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ))
        ) : (
          <div className="rml-forkthread__list">
            {messages.map((m) =>
              m.role === 'user' ? (
                <UserBubble key={m.id} message={m} />
              ) : (
                <AssistantBlock key={m.id} message={m} />
              ),
            )}

            {awaitingFirstToken ? (
              <motion.div
                className="rml-forkmsg rml-forkmsg--assistant"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.24, ease: EASE }}
              >
                <ForkTimeline runId={activeRunId} />
                <ThinkingDots />
              </motion.div>
            ) : null}

            {inputs.map((request) => (
              <ForkChips
                key={request.id}
                request={request}
                onPick={(value) => void resolveInput(request.id, value)}
              />
            ))}
          </div>
        )}
      </div>

      <AnimatePresence>
        {!atBottom ? (
          <motion.button
            type="button"
            className="rml-forkthread__jump"
            onClick={jump}
            initial={{ opacity: 0, y: 6, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.94 }}
            transition={{ duration: 0.2, ease: EASE }}
            aria-label="Jump to latest"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 5v13" />
              <path d="m6 12.2 6 6 6-6" />
            </svg>
          </motion.button>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

export default ForkThread
