import type { FollowUpAttachment } from '../../lib/types'
import { cx } from '../../lib/utils'
import './ContextAttachmentTile.css'

export interface ContextAttachmentTileProps {
  attachment: FollowUpAttachment
  onRemove?: () => void
  compact?: boolean
  className?: string
}

export function ContextAttachmentTile({
  attachment,
  onRemove,
  compact = false,
  className,
}: ContextAttachmentTileProps) {
  return (
    <div
      className={cx(
        'rml-contexttile',
        `rml-contexttile--${attachment.kind}`,
        compact && 'is-compact',
        className,
      )}
      title={`${attachment.assetTitle} · ${attachment.preview}`}
    >
      <span className="rml-contexttile__icon" aria-hidden="true">
        {attachment.kind === 'diagram' ? (
          <svg viewBox="0 0 20 20" fill="none">
            <rect x="2.6" y="3" width="14.8" height="14" rx="2.5" />
            <path d="M5.4 13.8 8.6 10l2.5 2.4 3.5-4.2" />
            <circle cx="13.9" cy="6.7" r="1.2" />
          </svg>
        ) : (
          <svg viewBox="0 0 20 20" fill="none">
            <path d="M4 4.3h12M4 7.8h9.3M4 11.3h12M4 14.8h7.1" />
          </svg>
        )}
      </span>
      <span className="rml-contexttile__label">[{attachment.label}]</span>
      {!compact ? (
        <span className="rml-contexttile__source" aria-hidden="true">
          {attachment.assetTitle}
        </span>
      ) : null}
      {onRemove ? (
        <button
          type="button"
          className="rml-contexttile__remove"
          onClick={onRemove}
          aria-label={`Remove ${attachment.label}`}
          title={`Remove ${attachment.label}`}
        >
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="m4.5 4.5 7 7m0-7-7 7" />
          </svg>
        </button>
      ) : null}
    </div>
  )
}

export default ContextAttachmentTile
