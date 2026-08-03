/* AssetChip — an asset as a reference, not as a stage.
 *
 * In document mode the artifact itself owns the main column, so inside the conversation
 * history an asset only needs to say "I was made here" and offer a way back. One compact
 * row: glyph, Lora title, version + age, and an arrow that returns you to the document.
 */

import { motion, useReducedMotion } from 'framer-motion'
import type { Asset } from '../../lib/types'
import { cx, relativeTime } from '../../lib/utils'
import './AssetChip.css'

export interface AssetChipProps {
  asset: Asset
  /** Marks the asset currently on stage. */
  active?: boolean
  /** Click handler — the assembler wires this to store.selectAsset. */
  onOpen?: (assetId: string) => void
  /** Play the entrance animation on mount. Default true. */
  animate?: boolean
  className?: string
}

const SPRING = { type: 'spring' as const, stiffness: 320, damping: 30, mass: 0.85 }

export function AssetChip({ asset, active = false, onOpen, animate = true, className }: AssetChipProps) {
  const reduceMotion = useReducedMotion()
  const version = Math.max(1, asset.latestVersion || 1)
  const enter = animate && !reduceMotion

  return (
    <motion.button
      type="button"
      className={cx('rml-chip', active && 'is-active', className)}
      onClick={() => onOpen?.(asset.id)}
      initial={enter ? { opacity: 0, scale: 0.97, y: -4 } : false}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={enter ? SPRING : { duration: 0 }}
      aria-label={`Open document: ${asset.title}`}
      title={`${asset.title} — 문서 열기 · Open document`}
    >
      <span className="rml-chip__glyph" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <rect x="3.2" y="4.2" width="17.6" height="15.6" rx="3.2" />
          <path d="M3.2 9.1h17.6" />
          <path d="M7.4 13.4h6.2M7.4 16.4h9.2" />
        </svg>
      </span>

      <span className="rml-chip__text">
        <span className="rml-chip__title">{asset.title || 'Untitled document'}</span>
        <span className="rml-chip__meta">
          v{version} · {relativeTime(asset.createdAt)}
          {active ? ' · 보는 중 · on stage' : ''}
        </span>
      </span>

      <span className="rml-chip__arrow" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="M5.4 12h12.2" />
          <path d="m12.4 6.6 5.4 5.4-5.4 5.4" />
        </svg>
      </span>
    </motion.button>
  )
}

export default AssetChip
