/* AssetCard — the generated artifact, sitting in the chat flow at its message's position.
 *
 * It blooms: the timeline runs while the model writes the file, then the card expands out of the
 * message (scale 0.96 → 1, a few px of rise, origin top) on a settling spring. Header carries the
 * Lora title, the version pill, open-in-new-tab and copy-HTML.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { assetUrl, fetchAssetHtml } from '../../lib/api'
import type { Asset } from '../../lib/types'
import { cx } from '../../lib/utils'
import { EASE } from '../../lib/motion'
import AssetFrame from './AssetFrame'
import VersionPicker from './VersionPicker'
import './AssetCard.css'

export interface AssetCardProps {
  asset: Asset
  /** Play the expand-from-message animation on mount. Default true. */
  autoExpandAnimation?: boolean
  className?: string
}

const EXPAND_SPRING = { type: 'spring' as const, stiffness: 300, damping: 30, mass: 0.85 }
const COPIED_MS = 1600

export function AssetCard({ asset, autoExpandAnimation = true, className }: AssetCardProps) {
  const reduceMotion = useReducedMotion()
  const latest = Math.max(1, asset.latestVersion || 1)
  const [version, setVersion] = useState(latest)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const copyTimer = useRef<number | undefined>(undefined)

  // A version arriving live pulls the view forward to it (CONTRACT § AssetCard).
  useEffect(() => {
    setVersion((current) => (latest > current ? latest : Math.min(current, latest)))
  }, [latest])

  useEffect(() => () => window.clearTimeout(copyTimer.current), [])

  const copyHtml = useCallback(async () => {
    window.clearTimeout(copyTimer.current)
    setCopyFailed(false)
    try {
      const html = await fetchAssetHtml(asset.id, version)
      await navigator.clipboard.writeText(html)
      setCopied(true)
    } catch {
      setCopyFailed(true)
      setCopied(true) // the button still resolves, just in the failed voice
    }
    copyTimer.current = window.setTimeout(() => {
      setCopied(false)
      setCopyFailed(false)
    }, COPIED_MS)
  }, [asset.id, version])

  const href = assetUrl(asset.id, version)
  const enter = autoExpandAnimation && !reduceMotion

  return (
    <motion.section
      className={cx('rml-asset', className)}
      initial={enter ? { opacity: 0, scale: 0.96, y: -6 } : false}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={enter ? EXPAND_SPRING : { duration: 0 }}
      aria-label={`Asset: ${asset.title}`}
    >
      <header className="rml-asset__bar">
        <span className="rml-asset__glyph" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <rect x="3.2" y="4.2" width="17.6" height="15.6" rx="3.2" />
            <path d="M3.2 9.1h17.6" />
            <path d="M7.4 13.4h6.2M7.4 16.4h9.2" />
          </svg>
        </span>

        <h3 className="rml-asset__title" title={asset.title}>
          {asset.title || 'Untitled asset'}
        </h3>

        <div className="rml-asset__tools">
          <VersionPicker latestVersion={latest} value={version} onChange={setVersion} />

          <span className="rml-asset__divider" aria-hidden="true" />

          <button
            type="button"
            className={cx('rml-asset__btn', copied && (copyFailed ? 'is-failed' : 'is-copied'))}
            onClick={copyHtml}
            aria-label={copyFailed ? 'Copy failed' : copied ? 'HTML copied' : 'Copy HTML'}
            title={copyFailed ? 'Copy failed' : copied ? 'Copied' : 'Copy HTML'}
          >
            <AnimatePresence initial={false} mode="popLayout">
              {copied ? (
                <motion.span
                  key="tick"
                  className="rml-asset__icon"
                  initial={{ opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.6 }}
                  transition={{ duration: 0.2, ease: EASE }}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    {copyFailed ? (
                      <path d="M7.5 7.5 16.5 16.5M16.5 7.5 7.5 16.5" />
                    ) : (
                      <path d="m5.6 12.6 4.1 4.1 8.7-9.4" />
                    )}
                  </svg>
                </motion.span>
              ) : (
                <motion.span
                  key="copy"
                  className="rml-asset__icon"
                  initial={{ opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.6 }}
                  transition={{ duration: 0.2, ease: EASE }}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="9" y="9" width="11" height="11" rx="2.6" />
                    <path d="M15 6.1a2.6 2.6 0 0 0-2.6-2.6H6.1A2.6 2.6 0 0 0 3.5 6.1v6.3A2.6 2.6 0 0 0 6.1 15" />
                  </svg>
                </motion.span>
              )}
            </AnimatePresence>
          </button>

          <a
            className="rml-asset__btn"
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="Open asset in a new tab"
            title="Open in new tab"
          >
            <span className="rml-asset__icon">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M13.4 4.4h6.2v6.2" />
                <path d="M19.6 4.4 11.2 12.8" />
                <path d="M18.1 14.4v4.1a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V7.9a2 2 0 0 1 2-2h4.2" />
              </svg>
            </span>
          </a>
        </div>
      </header>

      <AssetFrame
        assetId={asset.id}
        version={version}
        title={asset.title}
        className="rml-asset__frame"
      />
    </motion.section>
  )
}

export default AssetCard
