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
  useMemo,
  useRef,
  useState,
} from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  useForkSelectedEffort,
  useForkSelectedModel,
  useEnabledModels,
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

export function ModelPicker({
  compact = false,
  inline = false,
  thread = 'main',
  className,
}: ModelPickerProps) {
  const isFork = thread === 'fork'
  const models = useEnabledModels()
  const mainModel = useSelectedModel()
  const mainEffort = useSelectedEffort()
  const forkModel = useForkSelectedModel()
  const forkEffort = useForkSelectedEffort()
  const model = isFork ? forkModel : mainModel
  const effort = isFork ? forkEffort : mainEffort
  const setModel = useStore((s) => (isFork ? s.setForkModel : s.setModel))
  const setEffort = useStore((s) => (isFork ? s.setForkEffort : s.setEffort))

  const [open, setOpen] = useState(false)
  const providerGroups = useMemo(() => {
    const groups = new Map<string, { id: string; name: string; models: typeof models }>()
    for (const item of models) {
      const group = groups.get(item.providerId)
      if (group) group.models.push(item)
      else groups.set(item.providerId, { id: item.providerId, name: item.provider, models: [item] })
    }
    return [...groups.values()]
  }, [models])
  const [activeProviderId, setActiveProviderId] = useState(model?.providerId ?? '')
  const activeProvider =
    providerGroups.find((group) => group.id === activeProviderId) ?? providerGroups[0]
  const inlineListHeight = Math.min(Math.max(activeProvider?.models.length ?? 1, 1) * 40, 200)
  const fullListHeight = Math.min(Math.max(activeProvider?.models.length ?? 1, 1) * 57, 240)

  useEffect(() => {
    if (open && model?.providerId) setActiveProviderId(model.providerId)
  }, [open, model?.providerId])

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
    const onWindowBlur = () => close()
    // Capture the press itself, even when the eventual target cancels the interaction.
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    // The HTML preview lives in an iframe; entering it blurs this window rather
    // than dispatching a pointer event to the parent document.
    window.addEventListener('blur', onWindowBlur)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', onWindowBlur)
    }
  }, [open, close])

  // Nothing to pick until the catalog has loaded.
  if (!model || models.length === 0) return null

  if (inline) {
    return (
      <div
        ref={rootRef}
        className={cx('rml-model', 'rml-model--inline', className)}
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
              <div className="rml-model__providers" role="tablist" aria-label="Provider">
                {providerGroups.map((provider) => (
                  <button
                    key={provider.id}
                    type="button"
                    role="tab"
                    aria-selected={provider.id === activeProvider?.id}
                    className={cx('rml-model__provider-tab', provider.id === activeProvider?.id && 'is-active')}
                    onClick={() => setActiveProviderId(provider.id)}
                  >
                    {provider.name}
                  </button>
                ))}
              </div>
              <motion.div
                className="rml-model__menu-viewport"
                animate={{ height: inlineListHeight }}
                transition={{ duration: 0.32, ease: EASE }}
              >
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.ul
                    key={activeProvider?.id}
                    className="rml-model__menu-list"
                    role="listbox"
                    aria-label={`${activeProvider?.name ?? ''} models`}
                    initial={{ opacity: 0, x: 10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -10 }}
                    transition={{ duration: 0.2, ease: EASE }}
                  >
                {activeProvider?.models.map((m) => {
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
                  </motion.ul>
                </AnimatePresence>
              </motion.div>

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
            <div className="rml-model__providers" role="tablist" aria-label="Provider">
              {providerGroups.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  role="tab"
                  aria-selected={provider.id === activeProvider?.id}
                  className={cx('rml-model__provider-tab', provider.id === activeProvider?.id && 'is-active')}
                  onClick={() => setActiveProviderId(provider.id)}
                >
                  {provider.name}
                </button>
              ))}
            </div>

            <motion.div
              className="rml-model__list-viewport"
              animate={{ height: fullListHeight }}
              transition={{ duration: 0.32, ease: EASE }}
            >
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.ul
                  key={activeProvider?.id}
                  className="rml-model__list"
                  role="listbox"
                  aria-label={`${activeProvider?.name ?? ''} models`}
                  initial={{ opacity: 0, x: 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -12 }}
                  transition={{ duration: 0.22, ease: EASE }}
                >
              {activeProvider?.models.map((m) => {
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
                </motion.ul>
              </AnimatePresence>
            </motion.div>

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
