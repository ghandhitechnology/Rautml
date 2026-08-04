/* DocumentFrame — one asset version, edge to edge, scrolling on its own.
 *
 * Deliberately lean: this is NOT AssetFrame. There is no height reporter, no postMessage
 * handshake and no `scrolling="no"` — the iframe fills the column (100% × 100%) and the
 * generated page scrolls natively inside it, exactly as it would in a browser tab.
 * Still no `sandbox` attribute: assets are full documents that run their own JS.
 *
 * Switching version or asset keeps the outgoing document on screen until the incoming one
 * has actually loaded, then cross-fades. Nothing ever blinks white.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { fetchAssetHtml } from '../../lib/api'
import { stampFrameTheme, withThemeAttr } from '../../lib/frameTheme'
import { cx } from '../../lib/utils'
import { EASE } from '../../lib/motion'
import {
  FRAME_CONTEXT_DOM_EVENT,
  injectFollowUpContext,
  isFrameContextPayload,
  type FrameContextPayload,
} from '../../lib/frameContext'
import { useStore, useTheme } from '../../state/store'
import './DocumentFrame.css'

export interface DocumentFrameProps {
  assetId: string
  /** Version to display. Changing it (or the asset) cross-fades to the new document. */
  version: number
  title?: string
  /** Raw HTML of whatever is on screen — the header uses it for copy-to-clipboard. */
  onHtmlChange?: (html: string, assetId: string, version: number) => void
  className?: string
}

interface Layer {
  key: string
  assetId: string
  version: number
  raw: string
  doc: string
}

type Status = 'loading' | 'ready' | 'error'

const BONES: [width: string, height: number][] = [
  ['44%', 26],
  ['88%', 12],
  ['76%', 12],
  ['92%', 12],
  ['61%', 12],
  ['84%', 12],
]

/**
 * Keep in-page hash links and same-document clicks inside the srcDoc iframe.
 * Without this, some browsers treat `href="#…"` as a navigation that reloads
 * the frame (or worse, pokes the parent), which remounts layers and can leave
 * Framer/layout ghosts that look like a duplicated left chat bar.
 */
function withFrameGuards(html: string): string {
  const guard = `<script data-rautml-guard>(function(){document.addEventListener('click',function(e){var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(!a)return;var href=a.getAttribute('href')||'';if(href.charAt(0)==='#'){e.preventDefault();var id=decodeURIComponent(href.slice(1));if(!id){document.documentElement.scrollTop=0;document.body&&(document.body.scrollTop=0);return;}var el=document.getElementById(id)||document.getElementsByName(id)[0];if(el&&el.scrollIntoView)el.scrollIntoView({behavior:'smooth',block:'start'});}},true);})();</script>`
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${guard}</head>`)
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body([^>]*)>/i, `<body$1>${guard}`)
  return guard + html
}

export function DocumentFrame({
  assetId,
  version,
  title,
  onHtmlChange,
  className,
}: DocumentFrameProps) {
  const reduceMotion = useReducedMotion()
  const [layers, setLayers] = useState<Layer[]>([])
  const [ready, setReady] = useState<Record<string, true>>({})
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)

  const seq = useRef(0)
  const frames = useRef(new Map<string, HTMLIFrameElement>())

  /* keep every live document on the app's theme (assets honour [data-theme]) */
  const theme = useTheme()
  useEffect(() => {
    for (const el of frames.current.values()) stampFrameTheme(el, theme)
  }, [theme])

  /* ------------------------------------------------------------------ load */

  // Deps are the whole request (asset + version + retry nonce), so no dedupe ref is
  // needed — and a ref-based guard would swallow the refetch StrictMode's mount/unmount/
  // mount cycle demands, leaving the skeleton up forever.
  useEffect(() => {
    const requestKey = `${assetId}:${version}`
    let cancelled = false
    setStatus('loading')
    setError(null)

    fetchAssetHtml(assetId, version)
      .then((html) => {
        if (cancelled) return
        seq.current += 1
        const layer: Layer = {
          key: `${requestKey}#${seq.current}`,
          assetId,
          version,
          raw: html,
          // Theme + contextual selection affordances go in before first paint.
          doc: withThemeAttr(
            injectFollowUpContext(withFrameGuards(html)),
            useStore.getState().theme,
          ),
        }
        // First paint goes straight in; later ones queue behind whatever is visible.
        setLayers((prev) => (prev.length === 0 ? [layer] : [prev[0]!, layer]))
        setStatus('ready')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load this document')
        setStatus('error')
      })

    return () => {
      cancelled = true
    }
  }, [assetId, version, reloadNonce])

  /* --------------------------------------------------------------- promote */

  const markLoaded = useCallback((key: string) => {
    setReady((prev) => (prev[key] ? prev : { ...prev, [key]: true }))
    // The incoming document has painted → promote it and let the old one fade out.
    setLayers((prev) => (prev.length > 1 && prev[1]!.key === key ? [prev[1]!] : prev))
  }, [])

  const handleLoad = useCallback(
    (key: string, el: HTMLIFrameElement) => {
      // Some browsers fire one `load` for the initial empty document before srcDoc lands.
      try {
        const doc = el.contentDocument
        if (doc && doc.URL === 'about:blank' && !doc.body?.childNodes.length) return
      } catch {
        /* never cross-origin here, but never let this throw either */
      }
      stampFrameTheme(el, useStore.getState().theme)
      markLoaded(key)
    },
    [markLoaded],
  )

  /* drop bookkeeping for layers that are gone */
  useEffect(() => {
    const live = new Set(layers.map((l) => l.key))
    for (const key of frames.current.keys()) if (!live.has(key)) frames.current.delete(key)
    setReady((prev) => {
      const keys = Object.keys(prev)
      if (keys.every((k) => live.has(k))) return prev
      const next: Record<string, true> = {}
      for (const k of keys) if (live.has(k)) next[k] = true
      return next
    })
  }, [layers])

  /* ----------------------------------------------- selected asset context */

  useEffect(() => {
    const attach = (data: FrameContextPayload, key: string) => {
      const layer = layers.find((candidate) => candidate.key === key)
      if (!layer) return
      useStore.getState().addFollowUpAttachment({
        id: data.id,
        kind: data.kind,
        preview: data.preview,
        content: data.content,
        assetId: layer.assetId,
        assetTitle: title || 'Untitled asset',
        version: layer.version,
      })
    }
    const onMessage = (event: MessageEvent) => {
      if (!isFrameContextPayload(event.data)) return
      let key: string | null = null
      for (const [candidate, frame] of frames.current) {
        if (frame.contentWindow === event.source) {
          key = candidate
          break
        }
      }
      if (!key) return
      attach(event.data, key)
    }
    const onDomAttach = (event: Event) => {
      const custom = event as CustomEvent<unknown>
      if (!isFrameContextPayload(custom.detail)) return
      for (const [key, frame] of frames.current) {
        if (frame === custom.target) return attach(custom.detail, key)
      }
    }
    window.addEventListener('message', onMessage)
    window.addEventListener(FRAME_CONTEXT_DOM_EVENT, onDomAttach)
    return () => {
      window.removeEventListener('message', onMessage)
      window.removeEventListener(FRAME_CONTEXT_DOM_EVENT, onDomAttach)
    }
  }, [layers, title])

  const visible = layers[0] ?? null
  const painted = !!visible && !!ready[visible.key]

  const notify = useRef(onHtmlChange)
  notify.current = onHtmlChange
  useEffect(() => {
    if (!visible) return
    notify.current?.(visible.raw, visible.assetId, visible.version)
  }, [visible])

  const retry = () => setReloadNonce((n) => n + 1)

  /* ------------------------------------------------------------- rendering */

  return (
    <div className={cx('rml-docframe', painted && 'is-painted', className)}>
      <AnimatePresence initial={false}>
        {layers.map((layer, i) => (
          <motion.div
            key={layer.key}
            className="rml-docframe__layer"
            initial={{ opacity: 0 }}
            animate={{ opacity: i === 0 ? 1 : 0 }}
            exit={{ opacity: 0 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.32, ease: EASE }}
            style={{ pointerEvents: i === 0 ? 'auto' : 'none' }}
          >
            <iframe
              ref={(el) => {
                if (el) frames.current.set(layer.key, el)
                else frames.current.delete(layer.key)
              }}
              className="rml-docframe__iframe"
              title={`${title ?? 'Document'} — v${layer.version}`}
              srcDoc={layer.doc}
              onLoad={(e) => handleLoad(layer.key, e.currentTarget)}
            />
          </motion.div>
        ))}
      </AnimatePresence>

      {/* Always mounted — AnimatePresence exits reproducibly strand this overlay mid-fade
          (same PresenceChild ghost the dock slabs hit), so it fades via `animate` instead. */}
      {status !== 'error' ? (
        <motion.div
          key="skeleton"
          className="rml-docframe__skeleton"
          initial={false}
          animate={{
            opacity: painted ? 0 : 1,
            transitionEnd: { visibility: painted ? 'hidden' : 'visible' },
          }}
          transition={reduceMotion ? { duration: 0 } : { duration: 0.3, ease: EASE }}
          style={{ pointerEvents: 'none' }}
          aria-hidden="true"
        >
          <div className="rml-docframe__bones">
            {BONES.map(([width, height], i) => (
              <span key={i} style={{ width, height }} />
            ))}
          </div>
          <div className="rml-docframe__sheen" />
        </motion.div>
      ) : null}

      {status === 'error' ? (
        <div className="rml-docframe__error" role="alert">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 8.4v4.4" />
            <path d="M12 16.3h.01" />
            <path d="M10.3 3.9 2.6 17.4a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          </svg>
          <p className="rml-docframe__error-title">이 문서를 불러오지 못했어요.</p>
          <p className="rml-docframe__error-sub">This document couldn’t be loaded.</p>
          {error ? <p className="rml-docframe__error-detail">{error}</p> : null}
          <button type="button" className="rml-docframe__retry" onClick={retry}>
            다시 시도 · Try again
          </button>
        </div>
      ) : null}
    </div>
  )
}

export default DocumentFrame
