/* Theme continuity for generated documents.
 *
 * Assets render in same-origin srcDoc iframes and, per the design constitution,
 * style themselves with [data-theme] selectors that outrank prefers-color-scheme.
 * The shell keeps that attribute in sync with its own theme toggle: injected into
 * the HTML string before first paint (no flash), then stamped live on toggle.
 */

import type { ThemeName } from './types'

/** Stamp the app theme onto a same-origin iframe's <html>. Safe on torn-down frames. */
export function stampFrameTheme(el: HTMLIFrameElement | null | undefined, theme: ThemeName) {
  try {
    const root = el?.contentDocument?.documentElement
    if (!root) return
    root.dataset.theme = theme
    // Native UI (scrollbars, form controls) follows even if the page ignores the attribute.
    root.style.colorScheme = theme
  } catch {
    /* never same-origin trouble here, but never throw from a paint path either */
  }
}

/** Inject data-theme into the document's <html> tag so the first paint already matches. */
export function withThemeAttr(html: string, theme: ThemeName): string {
  const re = /<html([^>]*)>/i
  if (!re.test(html)) return html
  return html.replace(re, (match, attrs: string) =>
    /data-theme=/i.test(attrs) ? match : `<html${attrs} data-theme="${theme}">`,
  )
}
