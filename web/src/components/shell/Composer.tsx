import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useActiveChatId, useIsRunning, useStagedUploads, useStore } from '../../state/store'
import type { Thread } from '../../lib/types'
import { cx, formatBytes } from '../../lib/utils'
import { EASE } from '../../lib/motion'
import { Icon } from '../chat/icons'
import { ElaborationPicker } from './ElaborationPicker'
import { ModelPicker } from './ModelPicker'
import './Composer.css'

/** The upload types local sources can extract text from. */
const ACCEPT_EXTS = '.pdf,.csv,.docx,.pptx,.md,.markdown,.tex,.hwp,.hwpx'

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
  const [dragOver, setDragOver] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const activeChatId = useActiveChatId()
  const storeRunning = useIsRunning(thread)
  const sendMessage = useStore((s) => s.sendMessage)
  const stopRun = useStore((s) => s.stopRun)
  const attachFiles = useStore((s) => s.attachFiles)
  const removeStagedUpload = useStore((s) => s.removeStagedUpload)
  const stagedUploads = useStagedUploads()

  // File attach lives on the main composer only; the fork panel asks about
  // the chat, it doesn't feed it. The slot is held open before a chat exists —
  // otherwise the placeholder jumps a button's width when the first send
  // creates one, in what reads as the same input bar.
  const showAttach = thread === 'main' && !compact
  const canAttach = showAttach && !!activeChatId && !disabled
  const staged = canAttach ? stagedUploads : []
  const uploading = staged.some((u) => u.status === 'uploading')

  const isRunning = running ?? storeRunning
  const isDisabled = disabled || (!activeChatId && !onSend)
  const canSend = value.trim().length > 0 && !isRunning && !isDisabled && !uploading

  const pickFiles = () => fileRef.current?.click()

  const handleFileInput = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = '' // picking the same file twice must re-fire onChange
    if (files.length) void attachFiles(files)
  }

  const handleDragOver = (e: DragEvent) => {
    if (!canAttach || !e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    setDragOver(true)
  }

  const handleDrop = (e: DragEvent) => {
    if (!canAttach) return
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files ?? [])
    if (files.length) void attachFiles(files)
  }

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
      <AnimatePresence>
        {staged.length > 0 ? (
          <motion.ul
            className="rml-composer__uploads"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.2, ease: EASE }}
          >
            {staged.map((u) => (
              <li
                key={u.localId}
                className={cx('rml-composer__upload', `is-${u.status}`)}
                title={u.status === 'error' ? u.error : `${u.name} · ${formatBytes(u.size)}`}
              >
                {u.status === 'uploading' ? (
                  <span
                    className="rml-composer__upload-ring"
                    style={{ ['--progress' as string]: u.progress }}
                    aria-hidden="true"
                  />
                ) : (
                  <Icon name={u.status === 'error' ? 'alert' : 'file'} size={13} />
                )}
                <span className="rml-composer__upload-name">{u.name}</span>
                <span className="rml-composer__upload-meta">
                  {u.status === 'error' ? (u.error ?? 'failed') : formatBytes(u.size)}
                </span>
                <button
                  type="button"
                  className="rml-composer__upload-remove"
                  onClick={() => removeStagedUpload(u.localId)}
                  aria-label={`Remove ${u.name}`}
                >
                  <Icon name="cross" size={11} />
                </button>
              </li>
            ))}
          </motion.ul>
        ) : null}
      </AnimatePresence>

      <div
        className={cx(
          'rml-composer__field',
          showAttach && 'has-attach',
          isRunning && 'is-running',
          dragOver && 'is-dragover',
        )}
        onDragOver={handleDragOver}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        {/* Attach files into the chat's local sources; they ride the next send. */}
        {showAttach && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT_EXTS}
              multiple
              hidden
              onChange={handleFileInput}
            />
            <button
              type="button"
              className="rml-composer__attach"
              onClick={pickFiles}
              disabled={!canAttach}
              aria-label="Attach files"
              title={
                canAttach
                  ? '파일 첨부 · Attach files (pdf, csv, docx, pptx, md, tex, hwp, hwpx)'
                  : 'Open a chat to attach files'
              }
            >
              <Icon name="paperclip" size={16} />
            </button>
          </>
        )}

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

        {/* Elaboration + model + effort selection travels with the next message;
            fork inherits it. The audience pebble sits left of the model pebble. */}
        {!compact && <ElaborationPicker className="rml-composer__model" />}
        {!compact && <ModelPicker className="rml-composer__model" />}

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
        {hint ??
          (uploading ? (
            <span className="rml-composer__hint">Uploading files…</span>
          ) : (
            <span className="rml-composer__hint">
              <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
            </span>
          ))}
      </div>
    </div>
  )
}

export default Composer
