/* ForkComposer — the fork panel's own input.
 *
 * Autosizing textarea, Enter to send, Shift+Enter for a newline, and an IME
 * guard so a Korean composition commit never fires a send. Sends through
 * store.sendMessage('fork', …); swaps to a stop button while the fork run
 * streams. Carries the fork-scoped ModelPicker toggle: the side thread keeps
 * its own model + effort pair and never changes the main chat's.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useFollowUpAttachments, useIsRunning, useStore } from '../../state/store'
import { cx } from '../../lib/utils'
import { EASE } from '../../lib/motion'
import { ModelPicker } from '../shell/ModelPicker'
import ContextAttachmentTile from './ContextAttachmentTile'
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
  const reduceMotion = useReducedMotion()
  const ref = useRef<HTMLTextAreaElement>(null)
  const running = useIsRunning('fork')
  const attachments = useFollowUpAttachments()
  const sendMessage = useStore((s) => s.sendMessage)
  const stopRun = useStore((s) => s.stopRun)
  const removeAttachment = useStore((s) => s.removeFollowUpAttachment)

  const canSend = value.trim().length > 0 && !running && !disabled

  // autosize: collapse, then grow to content, capped.
  const autosize = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden'
  }, [])

  useLayoutEffect(() => {
    autosize()
  }, [value, autosize])

  // The fork column animates open from zero width, so the mount-time measure
  // sees the placeholder wrapped one glyph per line and caps the field tall.
  // Re-measure whenever the textarea's real width changes.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let lastWidth = el.clientWidth
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === lastWidth) return
      lastWidth = el.clientWidth
      autosize()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [autosize])

  // Wait for the panel's enter spring to settle before focusing — immediate
  // focus makes the shell fork column scrollLeft to chase the field and leaves
  // the whole sidebar permanently shifted left.
  useEffect(() => {
    if (!autoFocus) return
    const id = window.setTimeout(() => ref.current?.focus({ preventScroll: true }), 280)
    return () => window.clearTimeout(id)
  }, [autoFocus])

  const submit = useCallback(() => {
    const content = value.trim()
    if (!content) return
    setValue('')
    requestAnimationFrame(() => ref.current?.focus())
    void sendMessage('fork', content, attachments)
  }, [attachments, sendMessage, value])

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
      <motion.div
        layout={!reduceMotion}
        className={cx('rml-forkcomposer__field', running && 'is-running')}
        transition={{ duration: reduceMotion ? 0 : 0.28, ease: EASE }}
      >
        <motion.div
          className={cx(
            'rml-forkcomposer__attachments',
            attachments.length > 0 && 'is-visible',
          )}
          initial={false}
          animate={
            attachments.length
              ? { opacity: 1, height: 'auto', y: 0, filter: 'blur(0px)' }
              : { opacity: 0, height: 0, y: 4, filter: 'blur(3px)' }
          }
          transition={{ duration: reduceMotion ? 0 : 0.28, ease: EASE }}
          aria-label="Attached follow-up context"
          aria-hidden={!attachments.length}
        >
          {attachments.map((attachment) => (
            <motion.div
              layout={!reduceMotion}
              key={attachment.id}
              initial={reduceMotion ? false : { opacity: 0, scale: 0.86, y: 7 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.24, ease: EASE }}
            >
              <ContextAttachmentTile
                attachment={attachment}
                onRemove={() => removeAttachment(attachment.id)}
              />
            </motion.div>
          ))}
        </motion.div>

        <div className="rml-forkcomposer__inputrow">
          <textarea
            ref={ref}
            className="rml-forkcomposer__input"
            rows={1}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={attachments.length ? 'Ask about this selection…' : placeholder}
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
      </motion.div>

      {/* The fork's own model + effort, as a quiet toggle under the field —
          inherits the main selection until changed here, and changing it here
          never touches the main chat's pair. */}
      <div className="rml-forkcomposer__row">
        <ModelPicker inline thread="fork" className="rml-forkcomposer__model" />
      </div>
    </div>
  )
}

export default ForkComposer
