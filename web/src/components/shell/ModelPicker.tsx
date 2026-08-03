/* ModelPicker — the pill chip left of the send button ("Sol High ⌄") that
 * expands upward into the model list + reasoning-effort slider.
 *
 * The selection lives in the store per thread: main and welcome share the main
 * pair, while the fork panel keeps its own (inheriting main until touched).
 * Each model remembers its own effort dial. Efforts come straight from the
 * provider catalog served by GET /api/models. Open state is per-instance: the
 * document pointerdown listener closes this popover whenever any other chip is
 * clicked.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  useForkSelectedEffort,
  useForkSelectedModel,
  useModels,
  useSelectedEffort,
  useSelectedModel,
  useStore,
} from '../../state/store'
import type { Thread } from '../../lib/types'
import { cx } from '../../lib/utils'
import { EASE } from '../../lib/motion'
import { EffortSlider } from './EffortSlider'
import './ModelPicker.css'

/** 'xhigh' → 'Xhigh' for the chip; the slider itself shows wire values verbatim. */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export interface ModelPickerProps {
  /** Tighter chip + narrower popover — used inside the fork panel. */
  compact?: boolean
  /**
   * Inline hover variant for tight quarters (the fork composer field): a quiet
   * label that opens a model-only menu after a short hover idle. No effort
   * slider — the full picker in the main composer owns that. The menu is
   * right-anchored to the label so it stays inside the panel it lives in.
   */
  inline?: boolean
  /**
   * Which thread's selection this picker reads and writes. The fork keeps its
   * own pair (inheriting main until touched) so switching there never changes
   * the main chat's model.
   */
  thread?: Thread
  className?: string
}

const HOVER_OPEN_MS = 250
const HOVER_CLOSE_MS = 180

export function ModelPicker({
  compact = false,
  inline = false,
  thread = 'main',
  className,
}: ModelPickerProps) {
  const isFork = thread === 'fork'
  const models = useModels()
  const mainModel = useSelectedModel()
  const mainEffort = useSelectedEffort()
  const forkModel = useForkSelectedModel()
  const forkEffort = useForkSelectedEffort()
  const model = isFork ? forkModel : mainModel
  const effort = isFork ? forkEffort : mainEffort
  const setModel = useStore((s) => (isFork ? s.setForkModel : s.setModel))
  const setEffort = useStore((s) => (isFork ? s.setForkEffort : s.setEffort))

  const [open, setOpen] = useState(false)

  const rootRef = useRef<HTMLDivElement>(null)
  const chipRef = useRef<HTMLButtonElement>(null)
  const dialogId = useId()

  const close = useCallback(
    (refocus = false) => {
      setOpen(false)
      if (refocus) chipRef.current?.focus()
    },
    [setOpen],
  )

  // Outside click / Escape.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, close])

  // Hover intent for the inline variant: idle briefly to open, a grace delay on
  // leave so travelling from label to menu never snaps it shut. Mouse only —
  // touch and keyboard use the click/Enter toggle.
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (openTimer.current) window.clearTimeout(openTimer.current)
      if (closeTimer.current) window.clearTimeout(closeTimer.current)
    },
    [],
  )
  const onHoverEnter = (e: ReactPointerEvent) => {
    if (!inline || e.pointerType !== 'mouse') return
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    if (open || openTimer.current) return
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null
      setOpen(true)
    }, HOVER_OPEN_MS)
  }
  const onHoverLeave = (e: ReactPointerEvent) => {
    if (!inline || e.pointerType !== 'mouse') return
    if (openTimer.current) {
      window.clearTimeout(openTimer.current)
      openTimer.current = null
    }
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      setOpen(false)
    }, HOVER_CLOSE_MS)
  }

  // Nothing to pick until the catalog has loaded.
  if (!model || models.length === 0) return null

  if (inline) {
    return (
      <div
        ref={rootRef}
        className={cx('rml-model', 'rml-model--inline', className)}
        onPointerEnter={onHoverEnter}
        onPointerLeave={onHoverLeave}
      >
        <button
          ref={chipRef}
          type="button"
          className={cx('rml-model__inline-chip', open && 'is-open')}
          onClick={() => setOpen(!open)}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={dialogId}
          title="Switch model"
        >
          <span>
            {model.shortName} {effort ? capitalize(effort) : ''}
          </span>
          <svg className="rml-model__chevron" viewBox="0 0 10 6" aria-hidden="true">
            <path d="M1 1l4 4 4-4" />
          </svg>
        </button>

        <AnimatePresence>
          {open && (
            <motion.div
              id={dialogId}
              className="rml-model__menu"
              role="dialog"
              aria-label="Model and reasoning effort"
              initial={{ opacity: 0, scale: 0.96, y: 6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97, y: 5 }}
              transition={{ duration: 0.2, ease: EASE }}
            >
              <ul className="rml-model__menu-list" role="listbox" aria-label="Model">
                {models.map((m) => {
                  const selected = m.id === model.id
                  return (
                    <li key={m.id} role="option" aria-selected={selected}>
                      <button
                        type="button"
                        className={cx('rml-model__menu-option', selected && 'is-selected')}
                        onClick={() => setModel(m.id)}
                      >
                        <span className="rml-model__menu-name">{m.name}</span>
                        {selected ? (
                          <svg className="rml-model__check" viewBox="0 0 14 14" aria-hidden="true">
                            <path d="M2.5 7.5l3 3 6-7" />
                          </svg>
                        ) : (
                          <span className="rml-model__menu-provider">{m.provider}</span>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>

              <div className="rml-model__divider" />

              <div className="rml-model__effort">
                <div className="rml-model__effort-head">
                  <span className="rml-model__effort-title">Reasoning effort</span>
                  <span className="rml-model__effort-value">{effort}</span>
                </div>
                {/* Keyed by model: detent count changes with the provider's scale. */}
                <EffortSlider
                  key={model.id}
                  efforts={model.efforts}
                  value={effort ?? model.defaultEffort}
                  onChange={setEffort}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    )
  }

  return (
    <div ref={rootRef} className={cx('rml-model', compact && 'rml-model--compact', className)}>
      <button
        ref={chipRef}
        type="button"
        className={cx('rml-model__chip', open && 'is-open')}
        onClick={() => setOpen(!open)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={dialogId}
        title="Choose model and reasoning effort"
      >
        <span className="rml-model__chip-label">
          {model.shortName} {effort ? capitalize(effort) : ''}
        </span>
        <svg className="rml-model__chevron" viewBox="0 0 10 6" aria-hidden="true">
          <path d="M1 1l4 4 4-4" />
        </svg>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            id={dialogId}
            className="rml-model__pop"
            role="dialog"
            aria-label="Model and reasoning effort"
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 6 }}
            transition={{ duration: 0.22, ease: EASE }}
          >
            <ul className="rml-model__list" role="listbox" aria-label="Model">
              {models.map((m) => {
                const selected = m.id === model.id
                return (
                  <li key={m.id} role="option" aria-selected={selected}>
                    <button
                      type="button"
                      className={cx('rml-model__option', selected && 'is-selected')}
                      onClick={() => setModel(m.id)}
                    >
                      <span className="rml-model__option-main">
                        <span className="rml-model__option-name">{m.name}</span>
                        <span className="rml-model__option-desc">{m.description}</span>
                      </span>
                      <span className="rml-model__option-side">
                        <span className="rml-model__option-provider">{m.provider}</span>
                        {selected && (
                          <svg className="rml-model__check" viewBox="0 0 14 14" aria-hidden="true">
                            <path d="M2.5 7.5l3 3 6-7" />
                          </svg>
                        )}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>

            <div className="rml-model__divider" />

            <div className="rml-model__effort">
              <div className="rml-model__effort-head">
                <span className="rml-model__effort-title">Reasoning effort</span>
                <span className="rml-model__effort-value">{effort}</span>
              </div>
              {/* Keyed by model: detent count changes with the provider's scale. */}
              <EffortSlider
                key={model.id}
                efforts={model.efforts}
                value={effort ?? model.defaultEffort}
                onChange={setEffort}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default ModelPicker
