/* Theme continuity for generated documents.
 *
 * Assets render in same-origin srcDoc iframes and, per the design constitution,
 * style themselves with [data-theme] selectors that outrank prefers-color-scheme.
 * The shell keeps that attribute in sync with its own theme toggle: injected into
 * the HTML string before first paint (no flash), then stamped live on toggle.
 */

import type { ThemeName } from './types'

const FRAME_THEME_MESSAGE = '__rautml_theme'

/** Stamp the app theme onto a same-origin iframe's <html>. Safe on torn-down frames. */
export function stampFrameTheme(el: HTMLIFrameElement | null | undefined, theme: ThemeName) {
  try {
    const root = el?.contentDocument?.documentElement
    if (!root) return
    root.dataset.theme = theme
    // Native UI (scrollbars, form controls) follows even if the page ignores the attribute.
    root.style.colorScheme = theme
  } catch {
    /* Sandboxed desktop frames are intentionally cross-origin. */
  }
  el?.contentWindow?.postMessage({ type: FRAME_THEME_MESSAGE, theme }, '*')
}

/** Inject data-theme into the document's <html> tag so the first paint already matches. */
export function withThemeAttr(html: string, theme: ThemeName): string {
  const re = /<html([^>]*)>/i
  if (!re.test(html)) return html
  const themed = html.replace(re, (match, attrs: string) =>
    /data-theme=/i.test(attrs) ? match : `<html${attrs} data-theme="${theme}">`,
  )
  const bridge = `<script data-rautml-theme-bridge>(function(){window.addEventListener('message',function(e){var d=e.data;if(!d||d.type!=='${FRAME_THEME_MESSAGE}'||(d.theme!=='light'&&d.theme!=='dark'))return;document.documentElement.dataset.theme=d.theme;document.documentElement.style.colorScheme=d.theme;});})();</script>`
  if (/<\/head>/i.test(themed)) return themed.replace(/<\/head>/i, `${bridge}</head>`)
  return themed.replace(/<html([^>]*)>/i, (match) => `${match}${bridge}`)
}
