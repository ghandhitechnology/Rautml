/* DocumentHeader — the only chrome the document wears.
 *
 * A slim glass bar hovering over the top of the page: history toggle, the asset's name in
 * Lora (doubling as the asset switcher when the chat has more than one), the version picker,
 * download options / open-in-new-tab, and the theme toggle (document mode hides the shell topbar,
 * so this bar carries it). Quiet by default, legible on any document underneath it.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { Asset } from '../../lib/types'
import {
  downloadHtmlFile,
  downloadPdfFile,
  htmlDownloadFilename,
  pdfDownloadFilename,
} from '../../lib/downloads'
import { cx, relativeTime } from '../../lib/utils'
import { EASE } from '../../lib/motion'
import { Icon } from '../chat/icons'
import { VersionPicker } from '../asset'
import { LocalSources, ThemeToggle } from '../shell'
import './DocumentHeader.css'

export interface DocumentHeaderProps {
  asset: Asset
  /** Every asset in the chat, newest first. A switcher appears when there is more than one. */
  assets: Asset[]
  version: number
  onVersionChange: (version: number) => void
  onSelectAsset: (assetId: string) => void
  historyOpen: boolean
  onToggleHistory: () => void
  /** Resolves the raw HTML currently on screen. */
  getHtml: () => Promise<string>
  /** Direct URL of the visible version. */
  href: string
  /** Reconnecting badge (the shell topbar is gone in document mode). */
  reconnecting?: boolean
  className?: string
}

const DOWNLOAD_STATE_MS = 1600

type DownloadFormat = 'html' | 'pdf'
type DownloadStatus = 'idle' | 'working' | 'done' | 'failed'

function DownloadMenu({
  title,
  version,
  getHtml,
}: {
  title: string | undefined
  version: number
  getHtml: () => Promise<string>
}) {
  const [open, setOpen] = useState(false)
  const [format, setFormat] = useState<DownloadFormat>('html')
  const [status, setStatus] = useState<DownloadStatus>('idle')
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const firstItemRef = useRef<HTMLButtonElement>(null)
  const timer = useRef<number | undefined>(undefined)
  const pdfAvailable = Boolean(window.rautmlDesktop?.renderPdf)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  useEffect(() => {
    if (!open) return
    const focusFrame = window.requestAnimationFrame(() => firstItemRef.current?.focus())
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
      buttonRef.current?.focus()
    }
    window.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      window.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const download = useCallback(
    async (nextFormat: DownloadFormat) => {
      window.clearTimeout(timer.current)
      setOpen(false)
      setFormat(nextFormat)
      setStatus('working')
      try {
        const html = await getHtml()
        if (nextFormat === 'html') {
          downloadHtmlFile(html, htmlDownloadFilename(title, version))
        } else {
          const renderPdf = window.rautmlDesktop?.renderPdf
          if (!renderPdf) throw new Error('PDF export requires the desktop app.')
          const pdf = await renderPdf(html)
          downloadPdfFile(pdf, pdfDownloadFilename(title, version))
        }
        setStatus('done')
      } catch {
        setStatus('failed')
      }
      timer.current = window.setTimeout(() => setStatus('idle'), DOWNLOAD_STATE_MS)
    },
    [getHtml, title, version],
  )

  const label =
    status === 'working'
      ? `Preparing ${format.toUpperCase()}`
      : status === 'done'
        ? `${format.toUpperCase()} downloaded`
        : status === 'failed'
          ? `${format.toUpperCase()} download failed`
          : 'Download document'

  return (
    <div className="rml-dochead__download" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={cx(
          'rml-dochead__btn',
          open && 'is-open',
          status === 'done' && 'is-downloaded',
          status === 'failed' && 'is-failed',
        )}
        onClick={() => setOpen((value) => !value)}
        disabled={status === 'working'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={`${label} · 다운로드`}
      >
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            key={status}
            className="rml-dochead__glyph"
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.6 }}
            transition={{ duration: 0.2, ease: EASE }}
          >
            {status === 'working' ? (
              <span className="rml-dochead__download-spinner" aria-hidden="true" />
            ) : (
              <Icon
                name={status === 'done' ? 'check' : status === 'failed' ? 'cross' : 'download'}
                size={15}
              />
            )}
          </motion.span>
        </AnimatePresence>
      </button>

      <span className="rml-sr-only" aria-live="polite">
        {status === 'idle' ? '' : label}
      </span>

      <AnimatePresence>
        {open ? (
          <motion.div
            className="rml-dochead__download-menu"
            role="menu"
            aria-label="Download document as"
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.2, ease: EASE }}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
              event.preventDefault()
              const items = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  '[role="menuitem"]:not(:disabled)',
                ),
              )
              const index = items.indexOf(document.activeElement as HTMLButtonElement)
              const direction = event.key === 'ArrowDown' ? 1 : -1
              items[(index + direction + items.length) % items.length]?.focus()
            }}
          >
            <button
              ref={firstItemRef}
              type="button"
              className="rml-dochead__download-item"
              role="menuitem"
              onClick={() => void download('html')}
            >
              <span className="rml-dochead__download-icon" aria-hidden="true">
                <Icon name="code" size={15} />
              </span>
              <span className="rml-dochead__download-label">Download HTML</span>
              <span className="rml-dochead__download-ext">.html</span>
            </button>
            <button
              type="button"
              className="rml-dochead__download-item"
              role="menuitem"
              disabled={!pdfAvailable}
              title={pdfAvailable ? undefined : 'PDF export is available in the desktop app'}
              onClick={() => void download('pdf')}
            >
              <span className="rml-dochead__download-icon" aria-hidden="true">
                <Icon name="file" size={15} />
              </span>
              <span className="rml-dochead__download-label">Download PDF</span>
              <span className="rml-dochead__download-ext">
                {pdfAvailable ? '.pdf' : 'Desktop only'}
              </span>
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

/* ---------------------------------------------------------------- switcher */

function AssetSwitcher({
  assets,
  current,
  onSelect,
}: {
  assets: Asset[]
  current: Asset
  onSelect: (assetId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    // Capture phase + stopPropagation so Esc closes the menu without also closing history.
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

  return (
    <div className="rml-dochead__switch" ref={rootRef}>
      <button
        type="button"
        className={cx('rml-dochead__switch-btn', open && 'is-open')}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Switch document"
        title={`${assets.length} documents · 문서 ${assets.length}개`}
      >
        <Icon name="stack" size={13} />
        <span className="rml-dochead__switch-count">{assets.length}</span>
        <Icon name="chevron" size={12} className="rml-dochead__switch-caret" />
      </button>

      <AnimatePresence>
        {open ? (
          <motion.ul
            className="rml-dochead__menu"
            role="listbox"
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98, transition: { duration: 0.14, ease: EASE } }}
            transition={{ duration: 0.22, ease: EASE }}
          >
            {assets.map((a) => {
              const active = a.id === current.id
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={cx('rml-dochead__menu-item', active && 'is-active')}
                    onClick={() => {
                      setOpen(false)
                      if (!active) onSelect(a.id)
                    }}
                  >
                    <span className="rml-dochead__menu-dot" aria-hidden="true" />
                    <span className="rml-dochead__menu-text">
                      <span className="rml-dochead__menu-title">{a.title || 'Untitled'}</span>
                      <span className="rml-dochead__menu-meta">
                        v{Math.max(1, a.latestVersion || 1)} · {relativeTime(a.createdAt)}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </motion.ul>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

/* ------------------------------------------------------------------ header */

export function DocumentHeader({
  asset,
  assets,
  version,
  onVersionChange,
  onSelectAsset,
  historyOpen,
  onToggleHistory,
  getHtml,
  href,
  reconnecting = false,
  className,
}: DocumentHeaderProps) {
  const latest = Math.max(1, asset.latestVersion || 1)

  return (
    <header className={cx('rml-dochead', className)}>
      <div className="rml-dochead__scrim" aria-hidden="true" />

      <div className="rml-dochead__bar">
        <button
          type="button"
          className={cx('rml-dochead__btn', 'rml-dochead__history', historyOpen && 'is-on')}
          onClick={onToggleHistory}
          aria-pressed={historyOpen}
          aria-label={historyOpen ? 'Hide the conversation' : 'Show the conversation'}
          title={historyOpen ? '문서로 돌아가기 · Back to document' : '대화 보기 · Conversation'}
        >
          <Icon name="chat" size={16} />
        </button>

        <div className="rml-dochead__id">
          <h2 className="rml-dochead__title" title={asset.title}>
            {asset.title || 'Untitled document'}
          </h2>
          {assets.length > 1 ? (
            <AssetSwitcher assets={assets} current={asset} onSelect={onSelectAsset} />
          ) : null}
        </div>

        <div className="rml-dochead__tools">
          <AnimatePresence>
            {reconnecting ? (
              <motion.span
                className="rml-dochead__status"
                initial={{ opacity: 0, y: -3 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -3 }}
                transition={{ duration: 0.24, ease: EASE }}
              >
                <span className="rml-dochead__dot" />
                Reconnecting…
              </motion.span>
            ) : null}
          </AnimatePresence>

          <VersionPicker latestVersion={latest} value={version} onChange={onVersionChange} />

          <span className="rml-dochead__divider" aria-hidden="true" />

          {/* Local sources sits immediately left of the download icon. */}
          <LocalSources className="rml-dochead__sources" />

          <DownloadMenu title={asset.title} version={version} getHtml={getHtml} />

          <a
            className="rml-dochead__btn"
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="Open this document in a new tab"
            title="새 탭에서 열기 · Open in new tab"
          >
            <Icon name="external" size={15} />
          </a>

          <span className="rml-dochead__divider" aria-hidden="true" />

          <ThemeToggle className="rml-dochead__theme" />
        </div>
      </div>
    </header>
  )
}

export default DocumentHeader
