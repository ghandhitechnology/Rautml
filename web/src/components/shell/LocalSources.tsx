/* LocalSources — the "Local sources" text button that lives in the top bar
 * (shell topbar, and the document header left of the copy icon), opening a
 * panel with every file uploaded into this chat: status, download, delete.
 * Files land here automatically when a message with attachments is sent, and
 * they stay for the life of the chat — agents can search them at any age. */

import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { sourceFileUrl } from '../../lib/api'
import type { Source } from '../../lib/types'
import { cx, formatBytes } from '../../lib/utils'
import { EASE } from '../../lib/motion'
import { useActiveChatId, useSources, useStore } from '../../state/store'
import { Icon } from '../chat/icons'
import './LocalSources.css'

function statusLine(source: Source): { text: string; tone: 'ok' | 'busy' | 'bad' } {
  if (source.status === 'processing') return { text: 'Indexing…', tone: 'busy' }
  if (source.status === 'error') {
    return { text: source.error ?? 'Extraction failed', tone: 'bad' }
  }
  return { text: `${formatBytes(source.size)} · searchable`, tone: 'ok' }
}

export function LocalSources({ className }: { className?: string }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const activeChatId = useActiveChatId()
  const sources = useSources()
  const removeSource = useStore((s) => s.removeSource)

  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  // No chat, no sources area to show.
  if (!activeChatId) return null

  return (
    <div className={cx('rml-sources', className)} ref={rootRef}>
      <button
        type="button"
        className={cx('rml-sources__btn', open && 'is-open')}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="이 대화에 업로드된 파일 · Files uploaded to this chat"
      >
        <span className="rml-sources__label">Local sources</span>
        {sources.length > 0 ? <span className="rml-sources__count">{sources.length}</span> : null}
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            className="rml-sources__panel"
            role="dialog"
            aria-label="Local sources"
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98, transition: { duration: 0.14, ease: EASE } }}
            transition={{ duration: 0.22, ease: EASE }}
          >
            {sources.length === 0 ? (
              <p className="rml-sources__empty">
                No files yet. Attach files in the composer — they are stored here after the turn
                and stay searchable for the whole conversation.
              </p>
            ) : (
              <ul className="rml-sources__list">
                {sources.map((source) => {
                  const status = statusLine(source)
                  return (
                    <li key={source.id} className="rml-sources__item">
                      <Icon
                        name={source.status === 'error' ? 'alert' : 'file'}
                        size={15}
                        className="rml-sources__glyph"
                      />
                      <span className="rml-sources__text">
                        <span className="rml-sources__name" title={source.name}>
                          {source.name}
                        </span>
                        <span
                          className={cx('rml-sources__status', `is-${status.tone}`)}
                          title={status.text}
                        >
                          {status.text}
                        </span>
                      </span>
                      <span className="rml-sources__actions">
                        <a
                          className="rml-sources__action"
                          href={sourceFileUrl(source.id)}
                          download={source.name}
                          aria-label={`Download ${source.name}`}
                          title="다운로드 · Download"
                        >
                          <Icon name="download" size={14} />
                        </a>
                        <button
                          type="button"
                          className="rml-sources__action rml-sources__action--danger"
                          onClick={() => void removeSource(source.id)}
                          aria-label={`Delete ${source.name}`}
                          title="삭제 · Delete"
                        >
                          <Icon name="cross" size={13} />
                        </button>
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

export default LocalSources
