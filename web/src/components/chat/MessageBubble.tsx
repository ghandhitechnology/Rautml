/* One turn in a thread.
 *   user      → right-aligned, accent-tinted card, plain text (line breaks preserved)
 *   assistant → no card at all: full-width prose, the page itself is the surface
 * While `status === 'streaming'` the last block grows a shimmering caret.
 * `status === 'error'` swaps in a muted, coral-edged treatment.
 * Memoized: stream flushes hit the thread every 16ms; unchanged turns skip. */

import { memo, type ReactNode } from 'react'
import { cx } from '../../lib/utils'
import type { Message } from '../../lib/types'
import { useSources } from '../../state/store'
import Markdown, { CopyButton } from './Markdown'
import { Icon } from './icons'
import './MessageBubble.css'

export interface MessageBubbleProps {
  message: Message
  /** Attachments rendered under the body: timeline, widgets, assets, file cards, chips. */
  children?: ReactNode
  /** Denser type + spacing for the fork panel. */
  compact?: boolean
  /** Show the three-dot thinking indicator when an assistant turn has no text yet. */
  thinking?: boolean
  /** Offer the copy affordance under the turn. */
  copyable?: boolean
  className?: string
}

/** File chips under a user bubble — the sources uploaded with that message. */
function SourceChips({ sourceIds }: { sourceIds: string[] }) {
  const sources = useSources()
  return (
    <ul className="rml-msg__sources">
      {sourceIds.map((id) => {
        const source = sources.find((s) => s.id === id)
        return (
          <li key={id} className="rml-msg__source" title={source?.name}>
            <Icon name="paperclip" size={11} />
            <span>{source?.name ?? 'Uploaded file'}</span>
          </li>
        )
      })}
    </ul>
  )
}

function ThinkingDots() {
  return (
    <span className="rml-thinking" role="status" aria-label="Thinking">
      <i />
      <i />
      <i />
    </span>
  )
}

export const MessageBubble = memo(function MessageBubble({
  message,
  children,
  compact = false,
  thinking = false,
  copyable = true,
  className,
}: MessageBubbleProps) {
  const isUser = message.role === 'user'
  const streaming = message.status === 'streaming'
  const errored = message.status === 'error'
  const empty = message.content.trim().length === 0
  // half-written answers are a footgun to copy; interrupted ones are still worth keeping
  const canCopy = copyable && !streaming && !empty
  // the user bubble is a small card — its copy control is glyph-only
  const iconOnly = isUser

  return (
    <article
      className={cx(
        'rml-msg',
        isUser ? 'rml-msg--user' : 'rml-msg--assistant',
        compact && 'rml-msg--compact',
        streaming && 'is-streaming',
        errored && 'is-error',
        className,
      )}
      data-message-id={message.id}
      data-role={message.role}
    >
      {isUser ? (
        <div className="rml-msg__bubble">
          <p className="rml-msg__text">{message.content}</p>
          {message.sourceIds?.length ? <SourceChips sourceIds={message.sourceIds} /> : null}
        </div>
      ) : (
        <div className="rml-msg__body">
          {empty ? (
            streaming || thinking ? <ThinkingDots /> : null
          ) : (
            <Markdown className={cx(compact && 'rml-md--compact')} streaming={streaming}>
              {message.content}
            </Markdown>
          )}

          {errored ? (
            <p className="rml-msg__error">
              <Icon name="alert" size={14} />
              <span>{empty ? 'This response could not be completed.' : 'Response interrupted.'}</span>
            </p>
          ) : null}
        </div>
      )}

      {canCopy ? (
        <div className="rml-msg__actions">
          <CopyButton value={message.content} label={iconOnly ? 'Copy message' : 'Copy'} />
        </div>
      ) : null}

      {children ? <div className="rml-msg__extras">{children}</div> : null}
    </article>
  )
})

export default MessageBubble
