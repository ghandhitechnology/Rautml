/* AssetFrame — renders one asset version inside an <iframe srcDoc>.
 *
 * Generated assets run scripts and interactions inside an opaque sandboxed origin,
 * isolating the desktop shell without flattening the document experience.
 *
 * Auto-height: a tiny reporter script is injected before </body>; it watches the document with a
 * ResizeObserver and posts { type: '__rautml_h', h } to the parent. We match the message source
 * against our own iframe windows, then animate the container height to it.
 *
 * Version switching keeps the *old* frame visible at the *old* height until the incoming version
 * has reported its first height — then the two cross-fade and the height morphs. No jank, no flash.
 *
 * Wrapped in memo: all props are primitives (plus an optional callback), so a thread
 * re-render from streaming tokens never re-renders the live document subtree.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { fetchAssetHtml } from '../../lib/api'
import { stampFrameTheme, withThemeAttr } from '../../lib/frameTheme'
import { cx } from '../../lib/utils'
import { EASE } from '../../lib/motion'
import {
  FRAME_CONTEXT_DOM_EVENT,
  FRAME_CONTEXT_OPEN_DOM_EVENT,
  injectFollowUpContext,
  isFrameContextOpenPayload,
  isFrameContextPayload,
  postFrameMarks,
  type FrameContextPayload,
} from '../../lib/frameContext'
import { useQuestionedMarks, useStore, useTheme } from '../../state/store'
import { useNearViewport } from '../../lib/useNearViewport'
import './AssetFrame.css'

/** postMessage discriminator shared with the injected reporter. */
export const HEIGHT_MESSAGE_TYPE = '__rautml_h'

/** Floor for the frame — an asset never collapses below this, even while loading. */
export const MIN_FRAME_HEIGHT = 200

/** Ceiling. Nothing legitimate reports this tall; a bigger number is a runaway. */
export const MAX_FRAME_HEIGHT = 12000

const HEIGHT_SCRIPT = `
<script>(function () {
  var TYPE = '${HEIGHT_MESSAGE_TYPE}';
  // The parent writes our reported height back onto the frame, which resizes
  // our viewport, which changes what we measure — a closed loop.
  //
  // measure() deliberately includes documentElement.offsetHeight (the viewport
  // itself) so short content still fills the frame, which means the loop can
  // only ever ratchet *upward*: an asset whose content is viewport-relative
  // plus anything (min-height:100vh with a footer, height:110% under a
  // full-height root, a chart that re-fits) measures taller than the frame it
  // was just given, every single time. That runs at rAF cadence for as long as
  // the chat stays open and walks the height into the millions.
  //
  // Two guards, because the loop has two shapes:
  //   * a burst limit catches the ratchet — no real document changes height
  //     more than a handful of times a second, so exceeding that means we are
  //     measuring our own writes. Freeze at the current height: stable, still
  //     tall enough not to clip.
  //   * a short history of what we reported catches the A -> B -> A flip, which
  //     never trips the burst limit if it is slow. Latch onto the cycle's
  //     range and settle at its tall end.
  var HISTORY = 4, MAX_H = 12000, BURST_MS = 1000, BURST_MAX = 15;
  var last = -1, raf = 0, recent = [], lo = 0, hi = 0, stamps = [], frozen = false;
  function measure() {
    var d = document.documentElement, b = document.body;
    return Math.ceil(Math.max(
      b ? b.scrollHeight : 0, b ? b.offsetHeight : 0,
      d ? d.scrollHeight : 0, d ? d.offsetHeight : 0
    ));
  }
  function send(h) {
    var now = (window.performance && performance.now) ? performance.now() : +new Date();
    while (stamps.length && now - stamps[0] > BURST_MS) stamps.shift();
    stamps.push(now);
    if (stamps.length > BURST_MAX) {
      frozen = true;
      return;
    }
    last = h;
    try { parent.postMessage({ type: TYPE, h: h }, '*'); } catch (e) {}
  }
  function post() {
    if (frozen) return;
    var h = measure();
    if (h > MAX_H) h = MAX_H;
    if (h <= 0 || Math.abs(h - last) < 2) return;
    if (hi && h >= lo - 1 && h <= hi + 1) return;
    if (hi) { hi = 0; lo = 0; recent = []; }
    if (recent.indexOf(h) !== -1) {
      lo = h; hi = h;
      for (var i = 0; i < recent.length; i += 1) {
        if (recent[i] < lo) lo = recent[i];
        if (recent[i] > hi) hi = recent[i];
      }
      recent = [];
      if (hi !== last) send(hi);
      return;
    }
    recent.push(h);
    if (recent.length > HISTORY) recent.shift();
    send(h);
  }
  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(function () { raf = 0; post(); });
  }
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(schedule);
    if (document.documentElement) ro.observe(document.documentElement);
    if (document.body) ro.observe(document.body);
  }
  window.addEventListener('load', schedule);
  window.addEventListener('resize', schedule);
  document.addEventListener('transitionend', schedule, true);
  document.addEventListener('animationend', schedule, true);
  try { if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule); } catch (e) {}
  [0, 80, 300, 900, 2200].forEach(function (t) { setTimeout(schedule, t); });
})();</script>
`

/** Insert the height reporter immediately before the final </body> (appended if there is none). */
export function injectHeightReporter(html: string): string {
  const idx = html.toLowerCase().lastIndexOf('</body>')
  if (idx === -1) return html + HEIGHT_SCRIPT
  return html.slice(0, idx) + HEIGHT_SCRIPT + html.slice(idx)
}

export interface AssetFrameProps {
  assetId: string
  /** Version to display. Changing it cross-fades + height-morphs to the new document. */
  version: number
  /** Asset title — used for the iframe's accessible name. */
  title?: string
  /** Collapse floor, defaults to 200px. */
  minHeight?: number
  /** True once the visible version has reported its first height (skeleton gone). */
  onReadyChange?: (ready: boolean) => void
  className?: string
}

interface Layer {
  key: string
  version: number
  /** With the height reporter injected — what actually goes into srcDoc. */
  doc: string
}

type Status = 'loading' | 'ready' | 'error'

const BONES: [width: string, height: number][] = [
  ['38%', 22],
  ['84%', 11],
  ['72%', 11],
  ['91%', 11],
  ['56%', 11],
]

export const AssetFrame = memo(function AssetFrame({
  assetId,
  version,
  title,
  minHeight = MIN_FRAME_HEIGHT,
  onReadyChange,
  className,
}: AssetFrameProps) {
  const reduceMotion = useReducedMotion()
  // Scrolled far enough away and the document is released; the measured height
  // is kept so the frame holds its place and scroll position never jumps.
  const [hostRef, near] = useNearViewport<HTMLDivElement>()
  const [layers, setLayers] = useState<Layer[]>([])
  const [heights, setHeights] = useState<Record<string, number>>({})
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)

  const frames = useRef(new Map<string, HTMLIFrameElement>())
  const seq = useRef(0)

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
      .then((raw) => {
        if (cancelled) return
        seq.current += 1
        const layer: Layer = {
          key: `${requestKey}#${seq.current}`,
          version,
          // Theme attr goes in before first paint so a house-styled asset never flashes
          // the wrong scheme; live toggles are stamped into the open document below.
          doc: withThemeAttr(
            injectFollowUpContext(injectHeightReporter(raw)),
            useStore.getState().theme,
          ),
        }
        // First load paints straight away; later versions queue behind the visible one.
        setLayers((prev) => (prev.length === 0 ? [layer] : [prev[0]!, layer]))
        setStatus('ready')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load asset')
        setStatus('error')
      })

    return () => {
      cancelled = true
    }
  }, [assetId, version, reloadNonce])

  /* --------------------------------------------------- height messages in */

  const handleMessage = useCallback((event: MessageEvent) => {
    const data = event.data as { type?: unknown; h?: unknown } | null
    if (!data || typeof data !== 'object' || data.type !== HEIGHT_MESSAGE_TYPE) return
    const h = Math.min(MAX_FRAME_HEIGHT, Math.ceil(Number(data.h)))
    if (!Number.isFinite(h) || h <= 0) return

    let key: string | null = null
    for (const [k, el] of frames.current) {
      if (el.contentWindow && el.contentWindow === event.source) {
        key = k
        break
      }
    }
    if (!key) return
    const matched = key

    setHeights((prev) => (prev[matched] === h ? prev : { ...prev, [matched]: h }))
    // The incoming version just told us how tall it is → promote it (cross-fade + height morph).
    setLayers((prev) => (prev.length > 1 && prev[1]!.key === matched ? [prev[1]!] : prev))
  }, [])

  useEffect(() => {
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [handleMessage])

  useEffect(() => {
    const attach = (data: FrameContextPayload, key: string) => {
      const layer = layers.find((candidate) => candidate.key === key)
      if (!layer) return
      useStore.getState().addFollowUpAttachment({
        id: data.id,
        kind: data.kind,
        preview: data.preview,
        content: data.content,
        assetId,
        assetTitle: title || 'Untitled asset',
        version: layer.version,
      })
    }
    const ownsSource = (source: MessageEvent['source']) => {
      for (const frame of frames.current.values()) {
        if (frame.contentWindow === source) return true
      }
      return false
    }
    const onContextMessage = (event: MessageEvent) => {
      if (isFrameContextOpenPayload(event.data)) {
        if (ownsSource(event.source)) useStore.getState().focusForkAttachment(event.data.id)
        return
      }
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
    const onDomOpen = (event: Event) => {
      const custom = event as CustomEvent<unknown>
      if (!isFrameContextOpenPayload(custom.detail)) return
      for (const frame of frames.current.values()) {
        if (frame === custom.target) {
          useStore.getState().focusForkAttachment(custom.detail.id)
          return
        }
      }
    }
    window.addEventListener('message', onContextMessage)
    window.addEventListener(FRAME_CONTEXT_DOM_EVENT, onDomAttach)
    window.addEventListener(FRAME_CONTEXT_OPEN_DOM_EVENT, onDomOpen)
    return () => {
      window.removeEventListener('message', onContextMessage)
      window.removeEventListener(FRAME_CONTEXT_DOM_EVENT, onDomAttach)
      window.removeEventListener(FRAME_CONTEXT_OPEN_DOM_EVENT, onDomOpen)
    }
  }, [assetId, layers, title])

  /* ---------------------------------------------- questioned-selection marks */

  const marks = useQuestionedMarks(assetId)
  // Streaming fork tokens rebuild this array every flush; re-marking the frames
  // on content that didn't change makes them redo the same DOM work per token.
  const postedMarks = useRef('')
  useEffect(() => {
    const serialized = JSON.stringify(marks)
    if (serialized === postedMarks.current) return
    postedMarks.current = serialized
    for (const el of frames.current.values()) postFrameMarks(el, marks)
  }, [marks, layers])

  /* ----------------------------------------------------------- derivations */

  const visible = layers[0] ?? null
  const measured = visible ? heights[visible.key] : undefined
  const ready = measured != null
  const frameHeight = Math.max(minHeight, measured ?? minHeight)

  // Drop measurements for layers that are gone.
  useEffect(() => {
    const live = new Set(layers.map((l) => l.key))
    for (const key of frames.current.keys()) if (!live.has(key)) frames.current.delete(key)
    setHeights((prev) => {
      const keys = Object.keys(prev)
      if (keys.every((k) => live.has(k))) return prev
      const next: Record<string, number> = {}
      for (const k of keys) if (live.has(k)) next[k] = prev[k]!
      return next
    })
  }, [layers])

  const notifyReady = useRef(onReadyChange)
  notifyReady.current = onReadyChange
  useEffect(() => {
    notifyReady.current?.(ready)
  }, [ready])

  const retry = () => {
    setReloadNonce((n) => n + 1)
  }

  /* -------------------------------------------------------------- rendering */

  return (
    <motion.div
      ref={hostRef}
      className={cx('rml-frame', ready && 'is-ready', className)}
      initial={false}
      animate={{ height: status === 'error' ? 'auto' : frameHeight }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.42, ease: EASE }}
    >
      <AnimatePresence initial={false}>
        {(near ? layers : []).map((layer, i) => (
          <motion.div
            key={layer.key}
            className="rml-frame__layer"
            initial={{ opacity: 0 }}
            animate={{ opacity: i === 0 ? 1 : 0 }}
            exit={{ opacity: 0 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.3, ease: EASE }}
            style={{ pointerEvents: i === 0 ? 'auto' : 'none' }}
          >
            <iframe
              ref={(el) => {
                if (el) frames.current.set(layer.key, el)
                else frames.current.delete(layer.key)
              }}
              className="rml-frame__iframe"
              title={`${title ?? 'Asset'} — v${layer.version}`}
              srcDoc={layer.doc}
              sandbox="allow-scripts allow-forms allow-modals allow-downloads allow-popups allow-popups-to-escape-sandbox"
              onLoad={(e) => {
                stampFrameTheme(e.currentTarget, useStore.getState().theme)
                postFrameMarks(e.currentTarget, marks)
              }}
              scrolling="no"
              style={{ height: `${Math.max(minHeight, heights[layer.key] ?? frameHeight)}px` }}
            />
          </motion.div>
        ))}
      </AnimatePresence>

      <AnimatePresence>
        {near && !ready && status !== 'error' && (
          <motion.div
            key="skeleton"
            className="rml-frame__skeleton"
            initial={{ opacity: 1 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.26, ease: EASE }}
            aria-hidden="true"
          >
            <div className="rml-frame__bones">
              {BONES.map(([width, height], i) => (
                <span key={i} style={{ width, height }} />
              ))}
            </div>
            <div className="rml-frame__sheen" />
          </motion.div>
        )}
      </AnimatePresence>

      {status === 'error' && (
        <div className="rml-frame__error" role="alert">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 8.4v4.4" />
            <path d="M12 16.3h.01" />
            <path d="M10.3 3.9 2.6 17.4a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          </svg>
          <p className="rml-frame__error-title">This asset couldn’t be loaded.</p>
          {error && <p className="rml-frame__error-detail">{error}</p>}
          <button type="button" className="rml-frame__retry" onClick={retry}>
            Try again
          </button>
        </div>
      )}
    </motion.div>
  )
})

export default AssetFrame
