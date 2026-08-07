import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { flushSync } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useChatMeta, useConnection, useForkOpen, useOnBlankChat, useProviderAlert, useSettingsOpen, useStore, useStoreError } from '../../state/store'
import { cx } from '../../lib/utils'
import { EASE, SIDEBAR_TRANSITION_MS } from '../../lib/motion'
import { Icon } from '../chat/icons'
import ChatListSidebar from './ChatListSidebar'
import Composer from './Composer'
import LocalSources from './LocalSources'
import ThemeToggle from './ThemeToggle'
import TypewriterText from './TypewriterText'
import './Layout.css'

const SIDEBAR_COLLAPSED_KEY = 'rautml.sidebarCollapsed'
const SIDEBAR_WIDTH_KEY = 'rautml.sidebarWidthPx'
const SIDEBAR_TRANSITION_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'
const SIDEBAR_MIN_SCREEN_RATIO = 0.14
const SIDEBAR_MAX_SCREEN_RATIO = 0.3
const SIDEBAR_COLLAPSE_RATIO = 0.5
const SIDEBAR_DEFAULT_PX = 260
const SIDEBAR_PEEK_DELAY_MS = 100
const SIDEBAR_PEEK_CLOSE_DELAY_MS = 180
const TOAST_DISMISS_MS = 6_000

type ShellStyle = CSSProperties & { '--sidebar-w': string }

interface SidebarWidthBounds {
  min: number
  max: number
}

interface ForkLayoutSnapshot {
  main: DOMRect
  fork: DOMRect
}

function readSidebarWidthBounds(): SidebarWidthBounds {
  const expandedWindowWidth = window.screen.availWidth || window.screen.width || window.innerWidth
  return {
    min: Math.round(expandedWindowWidth * SIDEBAR_MIN_SCREEN_RATIO),
    max: Math.round(expandedWindowWidth * SIDEBAR_MAX_SCREEN_RATIO),
  }
}

function clampSidebarWidth(width: number, bounds: SidebarWidthBounds): number {
  return Math.min(bounds.max, Math.max(bounds.min, width))
}

/* Collapsing commits the grid in a single layout pass and lets the rendered
 * surfaces carry the motion (FLIP). Most surfaces only need translation. Wide
 * document surfaces also scale their committed pixels so their window-pinned
 * right edge stays fixed without repeatedly laying out the iframe. */
const SIDEBAR_FLIP_SURFACES = {
  /* The generated page and all floating chrome move as one composited frame.
   * Animating nested pieces separately left tiny one-frame seams in Electron. */
  document: ['.rml-shell__main', '.rml-dochead__bar'],
  chat: [
    '.rml-topbar__lead',
    '.rml-topbar__actions',
    '.rml-thread',
    /* the inner column, not the full-bleed wrapper around it: only the centred
     * box travels by half the track, which is the distance the eye follows */
    '.rml-welcome__inner',
    '.rml-composer',
    '.rml-slot--ball',
  ],
}

/* The document column has a window-pinned right edge. Scaling its committed
 * pixels from the previous box preserves the entire frame as one texture,
 * without animating width or forcing the iframe to lay out on every frame. */
const SIDEBAR_SCALE_SURFACES = new Set(['.rml-shell__main', '.rml-dochead__bar'])

function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'
  } catch {
    return false
  }
}

function readSidebarWidth(bounds: SidebarWidthBounds): number {
  try {
    const stored = Number.parseFloat(localStorage.getItem(SIDEBAR_WIDTH_KEY) ?? '')
    if (Number.isFinite(stored)) return clampSidebarWidth(stored, bounds)
  } catch {
    /* private mode — fall back to the original 260px visual width */
  }

  return clampSidebarWidth(SIDEBAR_DEFAULT_PX, bounds)
}

export interface LayoutProps {
  /** Left column. Defaults to the chat list. */
  sidebar?: ReactNode
  /** Extra controls in the top bar, left of the theme toggle. */
  header?: ReactNode
  /** Main column, scrollable — the chat thread lives here. */
  children?: ReactNode
  /** Bottom dock of the main column. Defaults to the main-thread composer. */
  composer?: ReactNode
  /** Right column — the fork panel. Width animates with the store's `forkOpen`. */
  fork?: ReactNode
  /** Absolutely-positioned overlay inside the main column (the fork ball). */
  floating?: ReactNode
  /**
   * Document takeover: the main column is a generated page rather than a thread.
   * The topbar steps aside (the document's own glass header carries its controls), the
   * body loses its padding and scroll, and the composer floats over the page instead of
   * sitting in a dock.
   */
  documentMode?: boolean
  className?: string
}

export function Layout({
  sidebar,
  header,
  children,
  composer,
  fork,
  floating,
  documentMode = false,
  className,
}: LayoutProps) {
  const chat = useChatMeta()
  const forkOpen = useForkOpen()
  const connection = useConnection()
  const error = useStoreError()
  const dismissError = useStore((s) => s.dismissError)
  const providerAlert = useProviderAlert()
  const onBlankChat = useOnBlankChat()
  const newChat = useStore((s) => s.newChat)
  const dismissProviderAlert = useStore((s) => s.dismissProviderAlert)
  const reconnectProvider = useStore((s) => s.reconnectProvider)
  const openSettings = useStore((s) => s.openSettings)
  const settingsOpen = useSettingsOpen()
  const sidebarWidthBounds = useRef(readSidebarWidthBounds()).current
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed)
  const [sidebarWidth, setSidebarWidth] = useState(() => readSidebarWidth(sidebarWidthBounds))
  const [sidebarResizing, setSidebarResizing] = useState(false)
  const [sidebarAnimating, setSidebarAnimating] = useState(false)
  const [sidebarPeeking, setSidebarPeeking] = useState(false)
  const shellRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const sidebarResizerRef = useRef<HTMLDivElement>(null)
  const sidebarWidthRef = useRef(sidebarWidth)
  const sidebarResizeActive = useRef(false)
  const sidebarResizeRaf = useRef<number | null>(null)
  const sidebarResizePendingX = useRef(0)
  /* Track width the drag started on: the grid holds it for the whole gesture
   * and commits the dragged width once, on pointer-up. */
  const sidebarResizeOrigin = useRef(0)
  const sidebarTransitionActive = useRef(false)
  const sidebarAnimations = useRef<Animation[]>([])
  const sidebarPeekOpenTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sidebarPeekCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const forkBefore = useRef<ForkLayoutSnapshot | null>(null)
  const forkAnimations = useRef<Animation[]>([])

  /* The settings takeover covers the shell but is a sibling of it, so the shell
   * has to be taken out of the tab order and the a11y tree by hand. `inert` is
   * set imperatively: React 18 does not recognise it as a prop. */
  useEffect(() => {
    const shell = shellRef.current
    if (!shell) return
    if (settingsOpen) shell.setAttribute('inert', '')
    else shell.removeAttribute('inert')
  }, [settingsOpen])

  /* Toasts auto-dismiss so a stale one never camps on screen. The timer resets
   * when a new message replaces the old; the close button remains for anyone
   * who wants it gone sooner. */
  useEffect(() => {
    if (!error) return
    const timer = setTimeout(dismissError, TOAST_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [error, dismissError])

  /* Capture the stable pre-toggle boxes synchronously from Zustand, before
   * React commits the fork's new grid track. The layout effect below can then
   * FLIP the whole document frame in one compositor pass. */
  useEffect(() => useStore.subscribe((state, previousState) => {
    if (
      state.forkOpen === previousState.forkOpen ||
      document.documentElement.dataset.desktop !== 'electron'
    ) return
    const shell = shellRef.current
    const mainElement = shell?.querySelector<HTMLElement>('.rml-shell__main')
    const forkElement = shell?.querySelector<HTMLElement>('.rml-shell__fork')
    if (!mainElement || !forkElement) return
    forkBefore.current = {
      main: mainElement.getBoundingClientRect(),
      fork: forkElement.getBoundingClientRect(),
    }
  }), [])

  useLayoutEffect(() => {
    const before = forkBefore.current
    forkBefore.current = null
    if (!before || document.documentElement.dataset.desktop !== 'electron') return

    const shell = shellRef.current
    const mainElement = shell?.querySelector<HTMLElement>('.rml-shell__main')
    const forkElement = shell?.querySelector<HTMLElement>('.rml-shell__fork')
    if (!mainElement || !forkElement) return

    forkAnimations.current.forEach((animation) => animation.cancel())
    forkAnimations.current = []
    forkElement.style.removeProperty('position')
    forkElement.style.removeProperty('inset')
    forkElement.style.removeProperty('width')
    forkElement.style.removeProperty('z-index')

    if (
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      typeof mainElement.animate !== 'function'
    ) return

    const after = mainElement.getBoundingClientRect()
    const scaleX = after.width > 0 ? before.main.width / after.width : 1
    const timing: KeyframeAnimationOptions = {
      duration: SIDEBAR_TRANSITION_MS,
      easing: SIDEBAR_TRANSITION_EASE,
      fill: 'both',
    }
    const animations = [
      mainElement.animate(
        [
          {
            transform: `translate3d(${before.main.left - after.left}px, ${before.main.top - after.top}px, 0) scaleX(${scaleX})`,
            transformOrigin: 'left center',
          },
          { transform: 'translate3d(0, 0, 0) scaleX(1)', transformOrigin: 'left center' },
        ],
        timing,
      ),
    ]

    if (forkOpen) {
      animations.push(
        forkElement.animate(
          [
            { transform: 'translate3d(100%, 0, 0)', opacity: 0 },
            { transform: 'translate3d(0, 0, 0)', opacity: 1 },
          ],
          timing,
        ),
      )
    } else if (before.fork.width > 0) {
      const right = window.innerWidth - before.fork.right
      const bottom = window.innerHeight - before.fork.bottom
      forkElement.style.position = 'fixed'
      forkElement.style.inset = `${before.fork.top}px ${right}px ${bottom}px auto`
      forkElement.style.width = `${before.fork.width}px`
      forkElement.style.zIndex = '24'
      animations.push(
        forkElement.animate(
          [
            { transform: 'translate3d(0, 0, 0)', opacity: 1 },
            { transform: 'translate3d(100%, 0, 0)', opacity: 0 },
          ],
          { ...timing, duration: 280 },
        ),
      )
    }

    const settle = () => {
      if (forkAnimations.current !== animations) return
      forkAnimations.current = []
      animations.forEach((animation) => animation.cancel())
      forkElement.style.removeProperty('position')
      forkElement.style.removeProperty('inset')
      forkElement.style.removeProperty('width')
      forkElement.style.removeProperty('z-index')
    }

    forkAnimations.current = animations
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(settle)
  }, [forkOpen])

  const clearSidebarPeekTimers = () => {
    if (sidebarPeekOpenTimer.current) clearTimeout(sidebarPeekOpenTimer.current)
    if (sidebarPeekCloseTimer.current) clearTimeout(sidebarPeekCloseTimer.current)
    sidebarPeekOpenTimer.current = null
    sidebarPeekCloseTimer.current = null
  }

  const closeSidebarPeek = () => {
    clearSidebarPeekTimers()
    setSidebarPeeking(false)
  }

  const scheduleSidebarPeekOpen = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse' || !sidebarCollapsed || sidebarTransitionActive.current) return
    if (sidebarPeekCloseTimer.current) clearTimeout(sidebarPeekCloseTimer.current)
    sidebarPeekCloseTimer.current = null
    if (sidebarPeeking || sidebarPeekOpenTimer.current) return

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduceMotion) {
      setSidebarPeeking(true)
      return
    }

    sidebarPeekOpenTimer.current = setTimeout(() => {
      sidebarPeekOpenTimer.current = null
      setSidebarPeeking(true)
    }, SIDEBAR_PEEK_DELAY_MS)
  }

  const cancelSidebarPeekOpen = () => {
    if (!sidebarPeekOpenTimer.current) return
    clearTimeout(sidebarPeekOpenTimer.current)
    sidebarPeekOpenTimer.current = null
  }

  const keepSidebarPeekOpen = () => {
    if (!sidebarPeekCloseTimer.current) return
    clearTimeout(sidebarPeekCloseTimer.current)
    sidebarPeekCloseTimer.current = null
  }

  const scheduleSidebarPeekClose = () => {
    cancelSidebarPeekOpen()
    if (!sidebarPeeking || sidebarPeekCloseTimer.current) return
    sidebarPeekCloseTimer.current = setTimeout(() => {
      sidebarPeekCloseTimer.current = null
      setSidebarPeeking(false)
    }, SIDEBAR_PEEK_CLOSE_DELAY_MS)
  }

  const setDesktopSidebarCollapsed = (collapsed: boolean) => {
    if (collapsed === sidebarCollapsed || sidebarTransitionActive.current) return

    const wasPeeking = sidebarPeeking
    clearSidebarPeekTimers()

    const persist = () => {
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed))
      } catch {
        /* private mode — the choice lasts for this session */
      }
    }

    const shell = shellRef.current
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const useFlip =
      document.documentElement.dataset.desktop === 'electron' &&
      !reduceMotion &&
      shell !== null &&
      typeof Element.prototype.animate === 'function'

    if (!useFlip) {
      setSidebarPeeking(false)
      setSidebarCollapsed(collapsed)
      persist()
      return
    }

    /* Animating the grid track itself re-laid out the entire main column on
     * every frame — and in document mode it made the generated page reflow
     * across its own breakpoints, a visible follow-then-snap. Instead the grid
     * commits its final geometry once and the surfaces below FLIP from the
     * bounds they just left. The column reflows exactly once, before paint. */
    const query = (selectors: string[]) =>
      selectors
        .map((selector) => shell.querySelector<HTMLElement>(selector))
        .filter((element): element is HTMLElement => element !== null)

    const translated = query(SIDEBAR_FLIP_SURFACES[documentMode ? 'document' : 'chat'])
    const before = new Map<HTMLElement, DOMRect>(
      translated.map((element) => [element, element.getBoundingClientRect()] as const),
    )

    sidebarTransitionActive.current = true
    flushSync(() => {
      setSidebarPeeking(false)
      setSidebarAnimating(true)
      setSidebarCollapsed(collapsed)
    })
    persist()

    const after = new Map<HTMLElement, DOMRect>(
      translated.map((element) => [element, element.getBoundingClientRect()] as const),
    )

    const timing: KeyframeAnimationOptions = {
      duration: SIDEBAR_TRANSITION_MS,
      easing: SIDEBAR_TRANSITION_EASE,
      fill: 'both',
    }
    const animations: Animation[] = []

    const mainElement = documentMode
      ? shell.querySelector<HTMLElement>('.rml-shell__main')
      : null
    const mainFirst = mainElement ? before.get(mainElement) : undefined
    const mainLast = mainElement ? after.get(mainElement) : undefined
    const mainScaleX = mainFirst && mainLast && mainLast.width > 0
      ? mainFirst.width / mainLast.width
      : 1

    for (const element of translated) {
      const first = before.get(element)
      const last = after.get(element)
      if (!first || !last) continue

      let targetLeft = first.left
      let targetTop = first.top
      let targetWidth = first.width

      /* The header changes its own sidebar-aware margin inside the animated
       * main column. Convert its previous global box through the inverse parent
       * FLIP so the nested transforms compose to the exact same pixels instead
       * of producing a one-frame seam. */
      if (
        mainElement &&
        element !== mainElement &&
        mainElement.contains(element) &&
        mainFirst &&
        mainLast &&
        mainScaleX > 0
      ) {
        targetLeft = mainLast.left + (first.left - mainFirst.left) / mainScaleX
        targetTop = mainLast.top + first.top - mainFirst.top
        targetWidth = first.width / mainScaleX
      }

      const deltaX = targetLeft - last.left
      const deltaY = targetTop - last.top
      const scales = [...SIDEBAR_SCALE_SURFACES].some((selector) => element.matches(selector))
      const scaleX = scales && last.width > 0 ? targetWidth / last.width : 1
      if (Math.abs(deltaX) < 0.01 && Math.abs(deltaY) < 0.01 && Math.abs(scaleX - 1) < 0.0001) continue

      /* A left-origin translation plus scale maps the committed final box onto
       * its exact previous bounds. The iframe reflows once at commit, while the
       * compositor carries its pixels through the transition without repainting
       * the whole generated page on every frame. */
      animations.push(
        element.animate(
          [
            {
              transform: `translate3d(${deltaX}px, ${deltaY}px, 0) scaleX(${scaleX})`,
              transformOrigin: 'left center',
            },
            { transform: 'translate3d(0, 0, 0) scaleX(1)', transformOrigin: 'left center' },
          ],
          timing,
        ),
      )
    }

    const sidebarElement = sidebarRef.current
    /* Pinning an already-visible preview should move the workspace underneath
     * it, not replay the panel's entrance from off-screen. */
    if (sidebarElement && !(wasPeeking && !collapsed)) {
      animations.push(
        sidebarElement.animate(
          collapsed
            ? [
                { transform: 'translate3d(0, 0, 0)', opacity: 1 },
                { transform: 'translate3d(-100%, 0, 0)', opacity: 0 },
              ]
            : [
                { transform: 'translate3d(-100%, 0, 0)', opacity: 0 },
                { transform: 'translate3d(0, 0, 0)', opacity: 1 },
              ],
          timing,
        ),
      )
    }

    const settle = () => {
      if (sidebarAnimations.current !== animations) return
      sidebarAnimations.current = []
      sidebarTransitionActive.current = false
      /* Leave the animating state first, in this same task. Cancelling while
       * the class is still applied paints one frame of the sidebar back at its
       * starting position — the flash the transition used to end on. */
      flushSync(() => setSidebarAnimating(false))
      animations.forEach((animation) => animation.cancel())
    }

    sidebarAnimations.current = animations
    if (animations.length === 0) {
      settle()
      return
    }
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(settle)
  }

  const setDesktopSidebarWidth = (width: number, persist = false) => {
    const next = clampSidebarWidth(width, sidebarWidthBounds)
    sidebarWidthRef.current = next
    setSidebarWidth(next)
    if (!persist) return
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next))
    } catch {
      /* private mode — the width lasts for this session */
    }
  }

  /* Drag frames run on rAF and never touch React state. The grid track holds
   * the width the drag started on, so the main column — and in document mode
   * the generated page's iframe — does not re-lay out per pointermove. Instead
   * the sidebar panel stretches over its committed track while the main
   * surface rides a left-origin translate+scale, the same transform family the
   * collapse FLIP uses. The track commits exactly once, on pointer-up. */
  const applySidebarResizeFrame = () => {
    sidebarResizeRaf.current = null
    if (!sidebarResizeActive.current) return
    const shell = shellRef.current
    if (!shell) return
    const next = clampSidebarWidth(sidebarResizePendingX.current, sidebarWidthBounds)
    sidebarWidthRef.current = next
    const delta = next - sidebarResizeOrigin.current

    const sidebar = sidebarRef.current
    if (sidebar) sidebar.style.width = `${next}px`
    shell.style.setProperty('--sidebar-drag-x', `${next}px`)

    const main = shell.querySelector<HTMLElement>('.rml-shell__main')
    if (main) {
      /* offsetWidth reads the committed box, ignoring the transform already on
       * it — the scale must not compound across frames. */
      const committed = main.offsetWidth
      const scaleX = committed > 0 ? (committed - delta) / committed : 1
      main.style.transformOrigin = 'left center'
      main.style.transform = `translate3d(${delta}px, 0, 0) scaleX(${scaleX})`
    }

    const resizer = sidebarResizerRef.current
    if (resizer) {
      const rounded = String(Math.round(next))
      resizer.setAttribute('aria-valuenow', rounded)
      resizer.setAttribute('aria-valuetext', `${rounded} pixels`)
    }
  }

  const clearSidebarDragGeometry = () => {
    const shell = shellRef.current
    const sidebar = sidebarRef.current
    const main = shell?.querySelector<HTMLElement>('.rml-shell__main')
    if (sidebar) sidebar.style.removeProperty('width')
    if (shell) shell.style.removeProperty('--sidebar-drag-x')
    if (main) {
      main.style.removeProperty('transform')
      main.style.removeProperty('transform-origin')
    }
  }

  const finishSidebarResize = (target: HTMLDivElement, pointerId: number) => {
    if (!sidebarResizeActive.current) return
    sidebarResizeActive.current = false
    if (sidebarResizeRaf.current !== null) {
      window.cancelAnimationFrame(sidebarResizeRaf.current)
      sidebarResizeRaf.current = null
    }
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
    /* Swap the drag's stand-in geometry for the real track in one synchronous
     * commit — still under is-sidebar-resizing, so the track change cannot
     * animate. The resizing class only drops after the commit has landed. */
    clearSidebarDragGeometry()
    flushSync(() => setDesktopSidebarWidth(sidebarWidthRef.current, true))
    setSidebarResizing(false)
  }

  const onSidebarResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || sidebarCollapsed || sidebarTransitionActive.current) return
    event.preventDefault()
    sidebarResizeActive.current = true
    sidebarResizeOrigin.current = sidebarWidthRef.current
    sidebarResizePendingX.current = sidebarWidthRef.current
    setSidebarResizing(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onSidebarResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!sidebarResizeActive.current) return
    const shell = shellRef.current
    if (!shell) return
    const bounds = shell.getBoundingClientRect()
    const pointerX = event.clientX - bounds.left

    /* Once the pointer crosses halfway through the minimum-width sidebar, the
     * drag becomes an intentional collapse gesture rather than a resize. */
    if (pointerX <= sidebarWidthBounds.min * SIDEBAR_COLLAPSE_RATIO) {
      finishSidebarResize(event.currentTarget, event.pointerId)
      setDesktopSidebarCollapsed(true)
      return
    }

    sidebarResizePendingX.current = pointerX
    if (sidebarResizeRaf.current !== null) return
    sidebarResizeRaf.current = window.requestAnimationFrame(applySidebarResizeFrame)
  }

  const onSidebarResizeEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    finishSidebarResize(event.currentTarget, event.pointerId)
  }

  const onSidebarResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (sidebarCollapsed) return
    const step = event.shiftKey ? 40 : 8
    let next: number | null = null
    if (event.key === 'ArrowLeft') next = sidebarWidthRef.current - step
    if (event.key === 'ArrowRight') next = sidebarWidthRef.current + step
    if (event.key === 'Home') next = sidebarWidthBounds.min
    if (event.key === 'End') next = sidebarWidthBounds.max
    if (next === null) return
    event.preventDefault()
    setDesktopSidebarWidth(next, true)
  }

  /* Small screens collapse the sidebar into an off-canvas drawer. The state is
   * harmless on desktop: the drawer classes only take effect under 640px. */
  const [navOpen, setNavOpen] = useState(false)
  const chatId = chat?.id
  useEffect(() => {
    setNavOpen(false)
  }, [chatId])
  useEffect(() => {
    if (!navOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNavOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navOpen])
  useEffect(() => {
    if (!sidebarPeeking) return
    const dismissPeek = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeSidebarPeek()
    }
    window.addEventListener('keydown', dismissPeek)
    window.addEventListener('blur', closeSidebarPeek)
    return () => {
      window.removeEventListener('keydown', dismissPeek)
      window.removeEventListener('blur', closeSidebarPeek)
    }
  }, [sidebarPeeking])
  useEffect(
    () => () => {
      sidebarAnimations.current.forEach((animation) => animation.cancel())
      sidebarAnimations.current = []
      sidebarTransitionActive.current = false
      forkAnimations.current.forEach((animation) => animation.cancel())
      forkAnimations.current = []
      if (sidebarResizeRaf.current !== null) window.cancelAnimationFrame(sidebarResizeRaf.current)
      clearSidebarPeekTimers()
    },
    [],
  )
  const sidebarVisible = !sidebarCollapsed || sidebarPeeking
  /* Electron closes the track completely, so keep the off-screen panel's
   * contents fully laid out. The edge preview can then reveal a finished list
   * instead of expanding rows after the panel has arrived. Web keeps its 52px
   * compact rail and still needs the collapsed content treatment. */
  const sidebarContentCollapsed =
    sidebarCollapsed &&
    !sidebarPeeking &&
    !sidebarAnimating &&
    document.documentElement.dataset.desktop !== 'electron'

  return (
    <div
      ref={shellRef}
      className={cx(
        'rml-shell',
        forkOpen && 'is-fork-open',
        documentMode && 'is-document',
        navOpen && 'is-nav-open',
        sidebarCollapsed && 'is-sidebar-collapsed',
        sidebarPeeking && 'is-sidebar-peeking',
        sidebarAnimating && 'is-sidebar-animating',
        sidebarResizing && 'is-sidebar-resizing',
        settingsOpen && 'is-settings-open',
        className,
      )}
      style={{ '--sidebar-w': `${sidebarWidth}px` } as ShellStyle}
    >
      <div className="rml-desktop-drag" aria-hidden="true" />
      {/* Sits in the titlebar strip beside the traffic lights and stays there in
          both states — the toggle used to teleport between here and the panel's
          own head. Only the new-chat shortcut is conditional: it stands in for
          the panel's button while the panel is away. */}
      <nav
        className="rml-titlebar-controls"
        aria-label="Conversation controls"
        onPointerEnter={keepSidebarPeekOpen}
        onPointerLeave={scheduleSidebarPeekClose}
      >
        <button
          type="button"
          aria-label={sidebarPeeking ? 'Keep sidebar open' : sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={sidebarVisible}
          aria-controls="rautml-conversation-list"
          title={sidebarPeeking ? 'Keep sidebar open' : sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={() => setDesktopSidebarCollapsed(sidebarPeeking ? false : !sidebarCollapsed)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3.5" y="4" width="17" height="16" rx="3" />
            <path d="M9 4v16" />
            <path d={sidebarCollapsed ? 'm14 9 3 3-3 3' : 'm16 9-3 3 3 3'} />
          </svg>
        </button>
        <AnimatePresence>
          {sidebarCollapsed && !sidebarPeeking && !sidebarAnimating ? (
            /* the wrapper carries the entry, not the button: framer writes its
               values as inline styles, which would outrank the group's own
               :disabled and :active rules */
            <motion.div
              className="rml-titlebar-controls__slot"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18, ease: EASE }}
            >
              <button
                type="button"
                aria-label="New chat"
                title={onBlankChat ? "You're already in a new chat" : 'New chat'}
                disabled={onBlankChat}
                onClick={() => void newChat()}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M13.5 5H6.4A2.4 2.4 0 0 0 4 7.4v10.2A2.4 2.4 0 0 0 6.4 20h10.2a2.4 2.4 0 0 0 2.4-2.4v-7.1" />
                  <path d="m12 14 1-.2 6.4-6.4a2 2 0 0 0-2.8-2.8L10.2 11l-.2 3z" />
                </svg>
              </button>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </nav>
      <div
        className="rml-shell__sidebar-peek-trigger"
        aria-hidden="true"
        onPointerEnter={scheduleSidebarPeekOpen}
        onPointerLeave={() => {
          cancelSidebarPeekOpen()
          scheduleSidebarPeekClose()
        }}
      />
      <aside
        id="rautml-sidebar"
        ref={sidebarRef}
        className="rml-shell__sidebar"
        onPointerEnter={keepSidebarPeekOpen}
        onPointerLeave={scheduleSidebarPeekClose}
      >
        {sidebar ?? (
          <ChatListSidebar
            collapsed={sidebarContentCollapsed}
            onCollapsedChange={setDesktopSidebarCollapsed}
          />
        )}
      </aside>
      <div
        ref={sidebarResizerRef}
        className="rml-shell__sidebar-resizer"
        role="separator"
        aria-label="Resize conversation sidebar"
        aria-controls="rautml-sidebar"
        aria-orientation="vertical"
        aria-valuemin={sidebarWidthBounds.min}
        aria-valuemax={sidebarWidthBounds.max}
        aria-valuenow={Math.round(sidebarWidth)}
        aria-valuetext={`${Math.round(sidebarWidth)} pixels`}
        tabIndex={0}
        title="Drag to resize. Drag halfway across the sidebar to collapse."
        onPointerDown={onSidebarResizeStart}
        onPointerMove={onSidebarResizeMove}
        onPointerUp={onSidebarResizeEnd}
        onPointerCancel={onSidebarResizeEnd}
        onLostPointerCapture={onSidebarResizeEnd}
        onKeyDown={onSidebarResizeKeyDown}
      />

      {navOpen ? (
        <button
          type="button"
          className="rml-shell__scrim"
          aria-label="Close the conversation list"
          onClick={() => setNavOpen(false)}
        />
      ) : null}

      <main className="rml-shell__main">
        {documentMode ? (
          <button
            type="button"
            className="rml-shell__nav-fab"
            aria-label="Show conversations"
            aria-expanded={navOpen}
            onClick={() => setNavOpen(true)}
          >
            <Icon name="menu" size={16} />
          </button>
        ) : (
        <header className="rml-topbar">
          <div className="rml-topbar__lead">
            <button
              type="button"
              className="rml-topbar__menu"
              aria-label="Show conversations"
              aria-expanded={navOpen}
              onClick={() => setNavOpen(true)}
            >
              <Icon name="menu" size={16} />
            </button>
            <h1 className="rml-topbar__title" title={chat?.title}>
              <TypewriterText text={chat?.title ?? 'Rautml'} />
            </h1>
            <AnimatePresence>
              {connection === 'reconnecting' ? (
                <motion.span
                  className="rml-topbar__status"
                  initial={{ opacity: 0, y: -3 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -3 }}
                  transition={{ duration: 0.24, ease: EASE }}
                >
                  <span className="rml-topbar__dot" />
                  Reconnecting…
                </motion.span>
              ) : null}
            </AnimatePresence>
          </div>
          <div className="rml-topbar__actions">
            <LocalSources />
            {header}
            <ThemeToggle />
          </div>
        </header>
        )}

        <div className="rml-shell__body">
          <div className="rml-shell__scroll">{children}</div>
          {floating}
        </div>

        <div className="rml-shell__dock">{composer ?? <Composer thread="main" autoFocus />}</div>
      </main>

      <aside className="rml-shell__fork" aria-hidden={!forkOpen}>
        <div className="rml-shell__fork-inner">{fork}</div>
      </aside>

      <AnimatePresence>
        {providerAlert ? (
          <motion.div
            className="rml-provider-warning"
            role="alert"
            initial={{ opacity: 0, x: '-50%', y: -18, scale: 0.98 }}
            animate={{ opacity: 1, x: '-50%', y: 0, scale: 1 }}
            exit={{ opacity: 0, x: '-50%', y: -12, scale: 0.98 }}
            transition={{ duration: 0.3, ease: EASE }}
          >
            <span className="rml-provider-warning__icon" aria-hidden="true">!</span>
            <span className="rml-provider-warning__copy">
              <strong>Provider connection stopped the run</strong>
              <small>{providerAlert.message}</small>
            </span>
            <button type="button" onClick={() => void reconnectProvider(providerAlert.providerId)}>Reconnect</button>
            <button type="button" onClick={() => {
              openSettings('models')
              dismissProviderAlert()
            }}>Change provider</button>
            <button className="rml-provider-warning__close" type="button" aria-label="Dismiss" onClick={dismissProviderAlert}>×</button>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {error ? (
          /* The store's error channel only carries errors, so the toast is an
           * assertive alert rather than a polite status. */
          <motion.div
            className="rml-toast"
            role="alert"
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.28, ease: EASE }}
          >
            <span className="rml-toast__text">{error}</span>
            <button type="button" className="rml-toast__close" onClick={dismissError}>
              Dismiss
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

export default Layout
