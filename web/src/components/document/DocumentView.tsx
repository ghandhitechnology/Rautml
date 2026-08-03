/* DocumentView — document takeover. The asset *is* the main column.
 *
 * Three layers, bottom to top:
 *   1. the stage — DocumentFrame, edge to edge, dimming and easing back when history opens
 *   2. the history overlay — the conversation slid over the page (mounted on demand)
 *   3. the header — glass chrome that stays above both, so the way back is never hidden
 *
 * The first asset of a chat arrives with `bloom` set: the stage springs up out of the place
 * the timeline occupied and its corners flatten into the column. Reopening a chat that
 * already has assets skips all of it and simply *is* the document.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { assetUrl, fetchAssetHtml } from '../../lib/api'
import {
  assetsNewestFirst,
  useAssets,
  useBloom,
  useConnection,
  useForkOpen,
  useHistoryOpen,
  useSelectedAsset,
  useStore,
} from '../../state/store'
import { cx } from '../../lib/utils'
import { EASE } from '../../lib/motion'
import DocumentFrame from './DocumentFrame'
import DocumentHeader from './DocumentHeader'
import HistoryOverlay from './HistoryOverlay'
import './DocumentView.css'

const BLOOM = { type: 'spring' as const, stiffness: 220, damping: 28, mass: 0.9 }
const SETTLE = { duration: 0.34, ease: EASE }

export interface DocumentViewProps {
  className?: string
}

export function DocumentView({ className }: DocumentViewProps) {
  const assets = useAssets()
  const asset = useSelectedAsset()
  const historyOpen = useHistoryOpen()
  const forkOpen = useForkOpen()
  const connection = useConnection()
  const bloom = useBloom()
  const reduceMotion = useReducedMotion()

  const selectAsset = useStore((s) => s.selectAsset)
  const toggleHistory = useStore((s) => s.toggleHistory)
  const setHistoryOpen = useStore((s) => s.setHistoryOpen)
  const clearBloom = useStore((s) => s.clearBloom)

  /* The takeover animation is a one-shot: read it at mount, then hand the flag back. */
  const shouldBloom = useRef(bloom && !reduceMotion)
  useEffect(() => {
    if (bloom) clearBloom()
  }, [bloom, clearBloom])

  const ordered = useMemo(() => assetsNewestFirst(assets), [assets])
  const latest = Math.max(1, asset?.latestVersion || 1)

  /* ------------------------------------------------------- version selection */

  const [picked, setPicked] = useState<{ assetId: string; version: number } | null>(null)
  const seenLatest = useRef<Record<string, number>>({})

  useEffect(() => {
    if (!asset) return
    const previous = seenLatest.current[asset.id]
    seenLatest.current[asset.id] = latest
    // An edit landed while we were watching → follow it forward, in place.
    if (previous !== undefined && latest > previous) setPicked({ assetId: asset.id, version: latest })
  }, [asset, latest])

  const version = asset && picked?.assetId === asset.id ? Math.min(picked.version, latest) : latest

  const onVersionChange = useCallback(
    (next: number) => {
      if (!asset) return
      setPicked({ assetId: asset.id, version: next })
    },
    [asset],
  )

  /* --------------------------------------------------------------- copy html */

  const htmlRef = useRef<{ key: string; html: string } | null>(null)
  const onHtmlChange = useCallback((html: string, assetId: string, v: number) => {
    htmlRef.current = { key: `${assetId}:${v}`, html }
  }, [])

  const getHtml = useCallback(async () => {
    if (!asset) return ''
    const key = `${asset.id}:${version}`
    if (htmlRef.current?.key === key) return htmlRef.current.html
    return fetchAssetHtml(asset.id, version)
  }, [asset, version])

  /* ------------------------------------------------------------------- keys */

  useEffect(() => {
    if (!historyOpen) return
    const onKey = (e: KeyboardEvent) => {
      // The fork panel owns Escape while it is open.
      if (e.key !== 'Escape' || forkOpen) return
      setHistoryOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [historyOpen, forkOpen, setHistoryOpen])

  if (!asset) return null

  return (
    <div className={cx('rml-doc', className)}>
      <motion.div
        className="rml-doc__stage"
        initial={
          shouldBloom.current ? { opacity: 0, scale: 0.94, y: 26, borderRadius: 22 } : false
        }
        animate={{
          opacity: historyOpen ? 0.55 : 1,
          scale: historyOpen ? 0.985 : 1,
          y: 0,
          borderRadius: 0,
        }}
        transition={shouldBloom.current ? BLOOM : SETTLE}
      >
        {/* one asset in, one asset out — the page itself never blinks */}
        <AnimatePresence initial={false} mode="popLayout">
          <motion.div
            key={asset.id}
            className="rml-doc__sheetwrap"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.36, ease: EASE }}
          >
            <DocumentFrame
              assetId={asset.id}
              version={version}
              title={asset.title}
              onHtmlChange={onHtmlChange}
            />
          </motion.div>
        </AnimatePresence>
      </motion.div>

      {shouldBloom.current ? (
        <motion.span
          className="rml-doc__flash"
          aria-hidden="true"
          initial={{ opacity: 0.55, scale: 0.7 }}
          animate={{ opacity: 0, scale: 1.35 }}
          transition={{ duration: 0.72, ease: EASE }}
        />
      ) : null}

      <AnimatePresence>{historyOpen ? <HistoryOverlay key="history" /> : null}</AnimatePresence>

      <motion.div
        className="rml-doc__chrome"
        initial={shouldBloom.current ? { opacity: 0, y: -12 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.34, ease: EASE, delay: shouldBloom.current ? 0.16 : 0 }}
      >
        <DocumentHeader
          asset={asset}
          assets={ordered}
          version={version}
          onVersionChange={onVersionChange}
          onSelectAsset={selectAsset}
          historyOpen={historyOpen}
          onToggleHistory={toggleHistory}
          getHtml={getHtml}
          href={assetUrl(asset.id, version)}
          reconnecting={connection === 'reconnecting'}
        />
      </motion.div>
    </div>
  )
}

export default DocumentView
