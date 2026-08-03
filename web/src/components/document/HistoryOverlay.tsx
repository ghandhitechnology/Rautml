/* HistoryOverlay — the conversation, slid back over its own document.
 *
 * A full-column glass sheet with its own scroll (ChatThread finds it through the
 * `data-scroll-container` hook, so pinning and the jump pill keep working). Assets appear
 * here only as compact chips: tapping one closes the overlay and puts that document on stage.
 * The floating composer and the document header stay put above this — the chrome never moves.
 */

import { motion, useReducedMotion } from 'framer-motion'
import { ChatThread } from '../chat'
import { AssetChip } from '../asset'
import { useAsset, useAssetIdsForMessage, useSelectedAssetId, useStore } from '../../state/store'
import { cx } from '../../lib/utils'
import { EASE } from '../../lib/motion'
import './HistoryOverlay.css'

function ChipForId({ assetId }: { assetId: string }) {
  const asset = useAsset(assetId)
  const selectedId = useSelectedAssetId()
  const selectAsset = useStore((s) => s.selectAsset)
  if (!asset) return null
  return <AssetChip asset={asset} active={asset.id === selectedId} onOpen={selectAsset} />
}

function ChipsForMessage({ messageId }: { messageId: string }) {
  const assetIds = useAssetIdsForMessage(messageId)
  if (!assetIds.length) return null
  return (
    <>
      {assetIds.map((id) => (
        <ChipForId key={id} assetId={id} />
      ))}
    </>
  )
}

export interface HistoryOverlayProps {
  className?: string
}

export function HistoryOverlay({ className }: HistoryOverlayProps) {
  const reduceMotion = useReducedMotion()

  return (
    <motion.div
      className={cx('rml-history', className)}
      data-scroll-container=""
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -22, scale: 0.995 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={
        reduceMotion
          ? { opacity: 0, transition: { duration: 0.16 } }
          : { opacity: 0, x: -16, scale: 0.997, transition: { duration: 0.22, ease: EASE } }
      }
      transition={{ duration: 0.34, ease: EASE }}
      aria-label="Conversation"
    >
      <div className="rml-history__inner">
        <ChatThread renderAssets={(messageId) => <ChipsForMessage messageId={messageId} />} />
      </div>
    </motion.div>
  )
}

export default HistoryOverlay
