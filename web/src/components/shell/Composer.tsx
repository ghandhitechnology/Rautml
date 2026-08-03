import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useActiveChatId, useIsRunning, useStore } from '../../state/store'
import type { Thread } from '../../lib/types'
import { cx } from '../../lib/utils'
import { EASE } from '../../lib/motion'
import './Composer.css'

export interface ComposerProps {
  /** Which thread this composer writes to. Defaults to the main chat. */
  thread?: Thread
  placeholder?: string
  /** Tighter padding + smaller type — used inside the fork panel. */
  compact?: boolean
  autoFocus?: boolean
  /** Hard-disable (e.g. no chat open). */
  disabled?: boolean
  /** Override the run state; defaults to the store's active run for `thread`. */
  running?: boolean
  /** Override sending; defaults to store.sendMessage(thread, content). */
  onSend?: (content: string) => void | Promise<void>
  /** Override stopping; defaults to store.stopRun(). */
  onStop?: () => void
  /** Small hint line under the field (e.g. input chips are pending). */
  hint?: ReactNode
  className?: string
}

const MAX_HEIGHT = 208

export function Composer({
  thread = 'main',
  placeholder,
  compact = false,
  autoFocus = false,
  disabled = false,
  running,
  onSend,
  onStop,
  hint,
  className,
}: ComposerProps) {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const activeChatId = useActiveChatId()
  const storeRunning = useIsRunning(thread)
  const sendMessage = useStore((s) => s.sendMessage)
  const stopRun = useStore((s) => s.stopRun)

  const isRunning = running ?? storeRunning
  const isDisabled = disabled || (!activeChatId && !onSend)
  const canSend = value.trim().length > 0 && !isRunning && !isDisabled

  // autosize: collapse then grow to content, capped.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    const next = Math.min(el.scrollHeight, MAX_HEIGHT)
    el.style.height = `${next}px`
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden'
  }, [value, compact])

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus, activeChatId])

  const submit = useCallback(() => {
    const content = value.trim()
    if (!content) return
    setValue('')
    // Return focus for the next turn; the caret stays where the user expects.
    requestAnimationFrame(() => ref.current?.focus())
    if (onSend) void onSend(content)
    else void sendMessage(thread, content)
  }, [onSend, sendMessage, thread, value])

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter') return
    // Korean/Japanese IME: Enter commits the candidate, it must never send.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.shiftKey || e.altKey) return
    e.preventDefault()
    if (!canSend) return
    submit()
  }

  const handleStop = () => {
    if (onStop) onStop()
    else void stopRun()
  }

  return (
    <div className={cx('rml-composer', compact && 'rml-composer--compact', className)}>
      <div className={cx('rml-composer__field', isRunning && 'is-running')}>
        <textarea
          ref={ref}
          className="rml-composer__input"
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            placeholder ??
            (thread === 'fork' ? 'Ask about this conversation…' : 'Ask Rautml anything…')
          }
          disabled={isDisabled}
          spellCheck={false}
          aria-label={thread === 'fork' ? 'Fork message' : 'Message'}
        />

        <div className="rml-composer__actions">
          <AnimatePresence initial={false} mode="popLayout">
            {isRunning ? (
              <motion.button
                key="stop"
                type="button"
                className="rml-composer__btn rml-composer__btn--stop"
                onClick={handleStop}
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                transition={{ duration: 0.2, ease: EASE }}
                aria-label="Stop generating"
                title="Stop"
              >
                <span className="rml-composer__stop-glyph" />
              </motion.button>
            ) : (
              <motion.button
                key="send"
                type="button"
                className="rml-composer__btn rml-composer__btn--send"
                onClick={submit}
                disabled={!canSend}
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                transition={{ duration: 0.2, ease: EASE }}
                aria-label="Send message"
                title="Send"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 19V5.6" />
                  <path d="m5.8 11.8 6.2-6.2 6.2 6.2" />
                </svg>
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </div>

      <div className="rml-composer__footnote">
        {hint ?? (
          <span className="rml-composer__hint">
            <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
          </span>
        )}
      </div>
    </div>
  )
}

export default Composer
