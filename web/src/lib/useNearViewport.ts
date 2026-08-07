/* Keeps heavy embedded documents (asset + widget iframes) mounted only while they
 * are anywhere near the viewport.
 *
 * A long chat accumulates one live document per asset, each with its own
 * ResizeObserver, injected reporter and event listeners — the cost is paid
 * forever, even for content scrolled far out of sight. This hook reports
 * "close enough to matter"; callers unmount the iframe when it goes false and
 * hold the last measured height in a placeholder so scroll position never jumps.
 *
 * The margin is deliberately generous (a few screens): an iframe that is
 * remounted loses in-document state (chart interactions, form input, inner
 * scroll), so only content the user has genuinely left behind gets released.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

/** How far outside the viewport a document stays mounted, in px. ~3 screens. */
export const KEEP_MOUNTED_MARGIN = 2400

export function useNearViewport<T extends HTMLElement>(
  margin: number = KEEP_MOUNTED_MARGIN,
): readonly [(node: T | null) => void, boolean] {
  // Assume far until the observer says otherwise: a long chat's first paint
  // would otherwise mount every iframe at once. Anything genuinely near shows
  // up in the observer's first callback, which fires right after attach, and
  // the host keeps its placeholder height either way so the thread can't collapse.
  const [near, setNear] = useState(false)
  const node = useRef<T | null>(null)
  const observer = useRef<IntersectionObserver | null>(null)

  useEffect(() => () => observer.current?.disconnect(), [])

  /* A callback ref rather than a RefObject: the host element belongs to a
   * framer-motion component, and observation has to start the moment it lands. */
  const attach = useCallback(
    (next: T | null) => {
      if (next === node.current) return
      observer.current?.disconnect()
      observer.current = null
      node.current = next
      if (!next) return
      if (typeof IntersectionObserver === 'undefined') {
        // No way to observe → keep the old always-mounted behavior.
        setNear(true)
        return
      }
      const io = new IntersectionObserver(
        ([entry]) => {
          if (entry) setNear(entry.isIntersecting)
        },
        { rootMargin: `${margin}px 0px ${margin}px 0px` },
      )
      io.observe(next)
      observer.current = io
    },
    [margin],
  )

  return [attach, near] as const
}
