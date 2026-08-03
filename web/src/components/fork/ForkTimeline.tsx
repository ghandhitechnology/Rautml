/* ForkTimeline — the fork panel's own compact activity strip.
 *
 * Same idea as the main ActivityTimeline but built for a 380px column and owned by
 * components/fork (no cross-imports). Live while the run streams, collapses to
 * "Worked for 4.2s · 3 steps" when it finishes; click the header to re-expand.
 */

import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useTimeline } from '../../state/store'
import type { TimelineItem } from '../../lib/types'
import { cx, formatDuration } from '../../lib/utils'
import { EASE } from '../../lib/motion'
import './ForkTimeline.css'

export interface ForkTimelineProps {
  /** Run whose timeline to show. Nothing renders when it has no tool calls. */
  runId?: string
  className?: string
}

/* ------------------------------------------------------------------- icons */

function Icon({ name }: { name: string }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
  switch (name) {
    case 'web_search':
      return (
        <svg {...common}>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m15.4 15.4 4.1 4.1" />
        </svg>
      )
    case 'web_fetch':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M3.5 12h17M12 3.5c2.3 2.5 3.4 5.4 3.4 8.5s-1.1 6-3.4 8.5c-2.3-2.5-3.4-5.4-3.4-8.5S9.7 6 12 3.5Z" />
        </svg>
      )
    case 'image_search':
      return (
        <svg {...common}>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
          <circle cx="9" cy="9.8" r="1.6" />
          <path d="m4.6 17.2 4.6-4.3 4 3.4 2.6-2.2 3.6 3.1" />
        </svg>
      )
    case 'bash_tool':
      return (
        <svg {...common}>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
          <path d="m7.6 9.6 2.6 2.5-2.6 2.5M12.8 15h3.8" />
        </svg>
      )
    case 'create_file':
      return (
        <svg {...common}>
          <path d="M13.5 3.5H7.2A2.2 2.2 0 0 0 5 5.7v12.6a2.2 2.2 0 0 0 2.2 2.2h9.6a2.2 2.2 0 0 0 2.2-2.2V9.2Z" />
          <path d="M13.5 3.5V9h5.5" />
        </svg>
      )
    case 'str_replace':
      return (
        <svg {...common}>
          <path d="M4.5 8.2h11a3.6 3.6 0 0 1 0 7.2H8" />
          <path d="m7.4 5.1-2.9 3.1 2.9 3.1M11 12.3l-2.9 3.1L11 18.5" />
        </svg>
      )
    case 'view':
      return (
        <svg {...common}>
          <path d="M2.8 12S6.3 5.8 12 5.8 21.2 12 21.2 12 17.7 18.2 12 18.2 2.8 12 2.8 12Z" />
          <circle cx="12" cy="12" r="2.6" />
        </svg>
      )
    case 'present_files':
      return (
        <svg {...common}>
          <path d="M12 4.4v9.8" />
          <path d="m8.3 10.6 3.7 3.6 3.7-3.6" />
          <path d="M4.8 16.4v1.4a2 2 0 0 0 2 2h10.4a2 2 0 0 0 2-2v-1.4" />
        </svg>
      )
    case 'ask_user_input_v0':
      return (
        <svg {...common}>
          <path d="M20 14.6a2.4 2.4 0 0 1-2.4 2.4H8.9L4.6 20V6.4A2.4 2.4 0 0 1 7 4h10.6A2.4 2.4 0 0 1 20 6.4Z" />
        </svg>
      )
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="7.5" />
          <path d="M12 8.4v3.9l2.6 1.6" />
        </svg>
      )
  }
}

/* -------------------------------------------------------------------- item */

function Row({ item }: { item: TimelineItem }) {
  return (
    <motion.li
      className={cx('rml-forktl__item', `is-${item.status}`)}
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: EASE }}
    >
      <span className="rml-forktl__icon">
        <Icon name={item.name} />
      </span>
      <span className="rml-forktl__body">
        <span className="rml-forktl__label" title={item.label}>
          {item.label}
        </span>
        {item.summary ? <span className="rml-forktl__summary">{item.summary}</span> : null}
      </span>
      <span className="rml-forktl__state" aria-hidden="true" />
    </motion.li>
  )
}

/* ------------------------------------------------------------------- strip */

export function ForkTimeline({ runId, className }: ForkTimelineProps) {
  const timeline = useTimeline(runId)
  const [override, setOverride] = useState<boolean | null>(null)

  const live = !!timeline && (timeline.status === 'running' || timeline.status === 'awaiting_input')

  // A live run keeps its strip even before the first step, so the fork column
  // shows the reasoning phase instead of nothing.
  if (!timeline || (!live && timeline.items.length === 0)) return null

  const expanded = override ?? live
  const elapsed = (timeline.endedAt ?? Date.now()) - timeline.startedAt
  const steps = timeline.items.length
  const failed = timeline.items.some((i) => i.status === 'error')

  const summary = live
    ? (timeline.items.find((i) => i.status === 'running')?.label ??
      timeline.phaseLabel ??
      'Working…')
    : `Worked for ${formatDuration(elapsed)} · ${steps} step${steps === 1 ? '' : 's'}`

  return (
    <div className={cx('rml-forktl', live && 'is-live', failed && 'has-error', className)}>
      <button
        type="button"
        className="rml-forktl__head"
        onClick={() => setOverride(!expanded)}
        aria-expanded={expanded}
      >
        <span className="rml-forktl__pip" aria-hidden="true" />
        <span className="rml-forktl__headline">{summary}</span>
        <svg
          className={cx('rml-forktl__chev', expanded && 'is-open')}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m7 10 5 5 5-5" />
        </svg>
      </button>

      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.ul
            className="rml-forktl__list"
            initial={{ opacity: 0, y: -3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -3 }}
            transition={{ duration: 0.2, ease: EASE }}
          >
            {timeline.items.map((item) => (
              <Row key={item.toolCallId} item={item} />
            ))}
          </motion.ul>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

export default ForkTimeline
