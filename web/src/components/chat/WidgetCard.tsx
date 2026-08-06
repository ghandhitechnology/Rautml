/* `visualize_show_widget` → a small inline visual rendered in its own document.
 *
 * The html goes into an <iframe srcdoc> with no sandbox attribute (full JS, by
 * design — same posture as AssetFrame) which also guarantees the widget's CSS
 * can never leak into the app. A tiny injected script reports its own height
 * back over postMessage so the frame hugs its content, capped at 400px. */

import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { EASE } from '../../lib/motion'
import { cx, uid } from '../../lib/utils'
import { useTheme } from '../../state/store'
import { useNearViewport } from '../../lib/useNearViewport'
import './WidgetCard.css'

const MAX_HEIGHT = 400
const MIN_HEIGHT = 60

interface ThemeVars {
  text: string
  muted: string
  accent: string
  border: string
  surface2: string
  scheme: 'light' | 'dark'
}

/** Read the live token values so the widget document matches the app's theme. */
function useThemeVars(): ThemeVars {
  const theme = useTheme()
  return useMemo(() => {
    const fallback: ThemeVars =
      theme === 'dark'
        ? {
            text: '#f5f4ee',
            muted: '#a8a69e',
            accent: '#d97757',
            border: '#3f3e3a',
            surface2: '#3a3a37',
            scheme: 'dark',
          }
        : {
            text: '#1f1e1d',
            muted: '#73726c',
            accent: '#d97757',
            border: '#e8e6dc',
            surface2: '#f0eee6',
            scheme: 'light',
          }
    if (typeof document === 'undefined') return fallback
    const cs = getComputedStyle(document.documentElement)
    const read = (name: string, dflt: string) => cs.getPropertyValue(name).trim() || dflt
    return {
      text: read('--text', fallback.text),
      muted: read('--text-muted', fallback.muted),
      accent: read('--accent', fallback.accent),
      border: read('--border', fallback.border),
      surface2: read('--surface-2', fallback.surface2),
      scheme: theme === 'dark' ? 'dark' : 'light',
    }
  }, [theme])
}

function baseStyle(v: ThemeVars): string {
  return `<style>
:root{color-scheme:${v.scheme};--text:${v.text};--muted:${v.muted};--accent:${v.accent};--border:${v.border};--surface-2:${v.surface2}}
html,body{margin:0;padding:0;background:transparent}
body{font-family:Pretendard,-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;font-size:14px;line-height:1.6;color:${v.text};-webkit-font-smoothing:antialiased;overflow-x:auto;overflow-y:hidden}
*{box-sizing:border-box}
a{color:${v.accent}}
::-webkit-scrollbar{width:9px;height:9px}
::-webkit-scrollbar-thumb{background:${v.border};border-radius:99px}
::-webkit-scrollbar-track{background:transparent}
</style>`
}

/* The parent writes this height back onto the frame, resizing our viewport and
 * changing what we measure — a closed loop. Because measure() includes
 * documentElement.offsetHeight (the viewport), viewport-relative content
 * measures taller than the frame it was just handed, every time, and ratchets
 * upward at rAF cadence forever. A burst limit catches that: no real document
 * changes height 15 times a second, so exceeding it means we are measuring our
 * own writes — freeze at the current height, which is stable and never clips.
 * A short history of reported heights catches the slower A -> B -> A flip,
 * latching onto the cycle and settling at its tall end. Measurement is also
 * rAF-coalesced, so a burst of ResizeObserver callbacks costs one pass. */
function heightScript(id: string): string {
  return `<script>(function(){var ID=${JSON.stringify(id)},HISTORY=4,BURST_MS=1000,BURST_MAX=15,last=-1,raf=0,recent=[],lo=0,hi=0,stamps=[],frozen=false;
function measure(){var d=document.documentElement,b=document.body;return Math.ceil(Math.max(d.scrollHeight,b?b.scrollHeight:0,d.offsetHeight))}
function emit(h){var now=(window.performance&&performance.now)?performance.now():+new Date();
while(stamps.length&&now-stamps[0]>BURST_MS)stamps.shift();stamps.push(now);
if(stamps.length>BURST_MAX){frozen=true;return}
last=h;try{parent.postMessage({__rautml_h:h,id:ID},'*')}catch(e){}}
function post(){if(frozen)return;var h=measure();if(h<=0||Math.abs(h-last)<2)return;
if(hi&&h>=lo-1&&h<=hi+1)return;
if(hi){hi=0;lo=0;recent=[]}
if(recent.indexOf(h)!==-1){lo=h;hi=h;for(var i=0;i<recent.length;i++){if(recent[i]<lo)lo=recent[i];if(recent[i]>hi)hi=recent[i]}recent=[];if(hi!==last)emit(hi);return}
recent.push(h);if(recent.length>HISTORY)recent.shift();emit(h)}
function send(){if(raf)return;raf=requestAnimationFrame(function(){raf=0;post()})}
try{new ResizeObserver(send).observe(document.documentElement)}catch(e){}
window.addEventListener('load',send);document.addEventListener('DOMContentLoaded',send);
[0,80,300,900].forEach(function(t){setTimeout(send,t)});send();})()<\/script>`
}

/** Splice the base style into <head> and the reporter before </body>. */
function buildSrcDoc(html: string, id: string, vars: ThemeVars): string {
  const style = baseStyle(vars)
  const script = heightScript(id)
  let out = html

  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (m) => `${m}${style}`)
  else if (/<html[^>]*>/i.test(out)) out = out.replace(/<html[^>]*>/i, (m) => `${m}<head>${style}</head>`)
  else out = `${style}${out}`

  if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, `${script}</body>`)
  else out = `${out}${script}`

  return out
}

export interface WidgetCardProps {
  /** Raw html from the `widget` event. */
  html: string
  compact?: boolean
  className?: string
}

export function WidgetCard({ html, compact = false, className }: WidgetCardProps) {
  const [hostRef, near] = useNearViewport<HTMLDivElement>()
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const idRef = useRef<string>(uid('w-'))
  const vars = useThemeVars()
  const [height, setHeight] = useState(MIN_HEIGHT)
  const [ready, setReady] = useState(false)

  const srcDoc = useMemo(() => buildSrcDoc(html, idRef.current, vars), [html, vars])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current
      if (!frame || (event.source && event.source !== frame.contentWindow)) return
      const data = event.data as { __rautml_h?: unknown; id?: unknown } | null
      if (!data || typeof data.__rautml_h !== 'number' || data.id !== idRef.current) return
      const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(data.__rautml_h)))
      setHeight((prev) => (Math.abs(prev - next) < 2 ? prev : next))
      setReady(true)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // A widget swapped in place starts over from the collapsed state.
  useEffect(() => {
    setReady(false)
  }, [html])

  return (
    <motion.div
      ref={hostRef}
      className={cx('rml-widget', compact && 'rml-widget--compact', ready && 'is-ready', className)}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.36, ease: EASE }}
    >
      {near ? (
        <iframe
          ref={frameRef}
          className="rml-widget__frame"
          title="Inline visual"
          srcDoc={srcDoc}
          sandbox="allow-scripts allow-forms allow-modals allow-downloads allow-popups allow-popups-to-escape-sandbox"
          loading="lazy"
          scrolling="no"
          style={{ height: `${height}px` }}
        />
      ) : (
        /* Released while far offscreen — hold the measured height so the thread
         * keeps its shape and scrolling back reflows nothing. */
        <div className="rml-widget__frame" style={{ height: `${height}px` }} aria-hidden="true" />
      )}
    </motion.div>
  )
}

export default WidgetCard
