/* ForkComposer — the fork panel's own input.
 *
 * Self-contained (no shell/chat imports): autosizing textarea, Enter to send,
 * Shift+Enter for a newline, and an IME guard so a Korean composition commit never
 * fires a send. Sends through store.sendMessage('fork', …); swaps to a stop button
 * while the fork run streams.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useIsRunning, useStore } from '../../state/store'
import { cx } from '../../lib/utils'
import { EASE } from '../../lib/motion'
import './ForkComposer.css'

export interface ForkComposerProps {
  placeholder?: string
  autoFocus?: boolean
  disabled?: boolean
  className?: string
}

const MAX_HEIGHT = 148

export function ForkComposer({
  placeholder = 'Ask a follow-up…',
  autoFocus = true,
  disabled = false,
  className,
}: ForkComposerProps) {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const running = useIsRunning('fork')
  const sendMessage = useStore((s) => s.sendMessage)
  const stopRun = useStore((s) => s.stopRun)

  const canSend = value.trim().length > 0 && !running && !disabled

  // autosize: collapse, then grow to content, capped.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden'
  }, [value])

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])

  const submit = useCallback(() => {
    const content = value.trim()
    if (!content) return
    setValue('')
    requestAnimationFrame(() => ref.current?.focus())
    void sendMessage('fork', content)
  }, [sendMessage, value])

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter') return
    // Korean/Japanese IME: Enter commits the candidate — it must never send.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.shiftKey || e.altKey) return
    e.preventDefault()
    if (!canSend) return
    submit()
  }

  return (
    <div className={cx('rml-forkcomposer', className)}>
      <div className={cx('rml-forkcomposer__field', running && 'is-running')}>
        <textarea
          ref={ref}
          className="rml-forkcomposer__input"
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          spellCheck={false}
          aria-label="Follow-up message"
        />

        <AnimatePresence initial={false} mode="popLayout">
          {running ? (
            <motion.button
              key="stop"
              type="button"
              className="rml-forkcomposer__btn rml-forkcomposer__btn--stop"
              onClick={() => void stopRun()}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={{ duration: 0.2, ease: EASE }}
              aria-label="Stop generating"
              title="Stop"
            >
              <span className="rml-forkcomposer__stop" />
            </motion.button>
          ) : (
            <motion.button
              key="send"
              type="button"
              className="rml-forkcomposer__btn rml-forkcomposer__btn--send"
              onClick={submit}
              disabled={!canSend}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={{ duration: 0.2, ease: EASE }}
              aria-label="Send follow-up"
              title="Send"
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
                <path d="M12 19V5.8" />
                <path d="m6 11.8 6-6 6 6" />
              </svg>
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

export default ForkComposer
