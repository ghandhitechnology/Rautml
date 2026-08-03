/* HistoryOverlay — the conversation, faded over its own document.
 *
 * A full-column glass sheet with its own scroll (ChatThread finds it through the
 * `data-scroll-container` hook, so pinning and the jump pill keep working). Assets appear
 * here only as compact chips: tapping one closes the overlay and puts that document on stage.
 * The document header and composer stay put; DocumentDock fades its response/activity slabs
 * in place for the duration so they don't sit on top of the conversation.
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
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: reduceMotion ? 0 : 0.18, ease: EASE } }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.22, ease: EASE }}
      aria-label="Conversation"
    >
      <div className="rml-history__inner">
        <ChatThread renderAssets={(messageId) => <ChipsForMessage messageId={messageId} />} />
      </div>
    </motion.div>
  )
}

export default HistoryOverlay
