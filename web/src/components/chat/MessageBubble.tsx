/* One turn in a thread.
 *   user      → right-aligned, accent-tinted card, plain text (line breaks preserved)
 *   assistant → no card at all: full-width prose, the page itself is the surface
 * While `status === 'streaming'` the last block grows a shimmering caret.
 * `status === 'error'` swaps in a muted, coral-edged treatment. */

import type { ReactNode } from 'react'
import { cx } from '../../lib/utils'
import type { Message } from '../../lib/types'
import Markdown from './Markdown'
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
  className?: string
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

export function MessageBubble({
  message,
  children,
  compact = false,
  thinking = false,
  className,
}: MessageBubbleProps) {
  const isUser = message.role === 'user'
  const streaming = message.status === 'streaming'
  const errored = message.status === 'error'
  const empty = message.content.trim().length === 0

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
        </div>
      ) : (
        <div className="rml-msg__body">
          {empty ? (
            streaming || thinking ? <ThinkingDots /> : null
          ) : (
            <Markdown className={cx(compact && 'rml-md--compact')}>{message.content}</Markdown>
          )}

          {errored ? (
            <p className="rml-msg__error">
              <Icon name="alert" size={14} />
              <span>{empty ? 'This response could not be completed.' : 'Response interrupted.'}</span>
            </p>
          ) : null}
        </div>
      )}

      {children ? <div className="rml-msg__extras">{children}</div> : null}
    </article>
  )
}

export default MessageBubble
