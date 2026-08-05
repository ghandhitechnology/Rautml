/* DocumentHeader — the only chrome the document wears.
 *
 * A slim glass bar hovering over the top of the page: history toggle, the asset's name in
 * Lora (doubling as the asset switcher when the chat has more than one), the version picker,
 * copy-HTML / open-in-new-tab, and the theme toggle (document mode hides the shell topbar,
 * so this bar carries it). Quiet by default, legible on any document underneath it.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { Asset } from '../../lib/types'
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

const COPIED_MS = 1600

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
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const copyHtml = useCallback(async () => {
    window.clearTimeout(timer.current)
    setCopyFailed(false)
    try {
      const html = await getHtml()
      await navigator.clipboard.writeText(html)
      setCopied(true)
    } catch {
      setCopyFailed(true)
      setCopied(true) // the button still resolves, just in the failed voice
    }
    timer.current = window.setTimeout(() => {
      setCopied(false)
      setCopyFailed(false)
    }, COPIED_MS)
  }, [getHtml])

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

          {/* Local sources sits immediately left of the copy icon, per spec. */}
          <LocalSources className="rml-dochead__sources" />

          <button
            type="button"
            className={cx('rml-dochead__btn', copied && (copyFailed ? 'is-failed' : 'is-copied'))}
            onClick={copyHtml}
            aria-label={copyFailed ? 'Copy failed' : copied ? 'HTML copied' : 'Copy HTML'}
            title={copyFailed ? '복사 실패 · Copy failed' : copied ? '복사됨 · Copied' : 'HTML 복사 · Copy HTML'}
          >
            <AnimatePresence initial={false} mode="popLayout">
              <motion.span
                key={copied ? 'done' : 'copy'}
                className="rml-dochead__glyph"
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.6 }}
                transition={{ duration: 0.2, ease: EASE }}
              >
                <Icon name={copied ? (copyFailed ? 'cross' : 'check') : 'copy'} size={15} />
              </motion.span>
            </AnimatePresence>
          </button>

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
