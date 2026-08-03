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

function heightScript(id: string): string {
  return `<script>(function(){var ID=${JSON.stringify(id)},last=-1;
function send(){var d=document.documentElement,b=document.body,h=Math.ceil(Math.max(d.scrollHeight,b?b.scrollHeight:0,d.offsetHeight));if(h!==last){last=h;try{parent.postMessage({__rautml_h:h,id:ID},'*')}catch(e){}}}
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
      className={cx('rml-widget', compact && 'rml-widget--compact', ready && 'is-ready', className)}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.36, ease: EASE }}
    >
      <iframe
        ref={frameRef}
        className="rml-widget__frame"
        title="Inline visual"
        srcDoc={srcDoc}
        loading="lazy"
        scrolling="no"
        style={{ height: `${height}px` }}
      />
    </motion.div>
  )
}

export default WidgetCard
