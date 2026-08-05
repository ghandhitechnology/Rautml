import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { EASE } from '../../lib/motion'
import { cx } from '../../lib/utils'
import { useProviders, useStore } from '../../state/store'
import './ProviderBar.css'

export function ProviderBar() {
  const providers = useProviders()
  const enabledModelIds = useStore((s) => s.enabledModelIds)
  const toggleModel = useStore((s) => s.toggleModelEnabled)
  const refresh = useStore((s) => s.refreshProviders)
  const reconnect = useStore((s) => s.reconnectProvider)
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const close = useCallback(() => {
    setOpen(false)
    setExpanded(null)
  }, [])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    // Capture the physical press before a target can stop or cancel its interaction.
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    // Clicking the HTML preview moves focus into its iframe instead of emitting
    // a pointer event in this document, so treat that focus transfer as outside.
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', close)
    }
  }, [open, close])

  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener('rautml:open-providers', show)
    return () => window.removeEventListener('rautml:open-providers', show)
  }, [])

  if (!providers.length) return null

  const enabled = new Set(enabledModelIds)
  const totalModels = providers.reduce((sum, provider) => sum + provider.models.length, 0)

  return (
    <div ref={rootRef} className="rml-providerbar">
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            className="rml-providerbar__panel"
            role="dialog"
            aria-label="Choose models shown in the chat picker"
            initial={{ opacity: 0, y: 8, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.985 }}
            transition={{ duration: 0.2, ease: EASE }}
          >
            <div className="rml-providerbar__panel-head">
              <span>
                <strong>Models in chat picker</strong>
                <small>Check the models you want available.</small>
              </span>
              <button type="button" onClick={() => void refresh()} title="Refresh CLI catalogs">
                Refresh
              </button>
            </div>

            <div className="rml-providerbar__groups">
              {providers.map((provider) => {
                const checkedCount = provider.models.filter((model) => enabled.has(model.id)).length
                const isExpanded = provider.id === expanded
                return (
                  <section
                    key={provider.id}
                    className={cx('rml-providerbar__group', checkedCount > 0 && 'has-enabled')}
                  >
                    <button
                      type="button"
                      className="rml-providerbar__provider"
                      aria-expanded={isExpanded}
                      onClick={() => setExpanded(isExpanded ? null : provider.id)}
                    >
                      <span className={cx('rml-providerbar__status', `is-${provider.authStatus}`)} />
                      <span>{provider.name}</span>
                      <small>{checkedCount}/{provider.modelCount}</small>
                      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
                    </button>

                    <AnimatePresence initial={false}>
                      {isExpanded ? (
                        <motion.div
                          className="rml-providerbar__models"
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.22, ease: EASE }}
                        >
                          {provider.authStatus !== 'connected' ? (
                            <button
                              className="rml-providerbar__connect"
                              type="button"
                              onClick={() => void reconnect(provider.id)}
                            >
                              {provider.installed ? 'Connect with CLI' : `${provider.name} CLI not found`}
                            </button>
                          ) : null}

                          {provider.models.map((item) => {
                            const checked = enabled.has(item.id)
                            const unavailable =
                              provider.id !== 'openrouter' && provider.authStatus !== 'connected'
                            const onlyEnabledModel = checked && enabledModelIds.length === 1
                            const disabled = unavailable || onlyEnabledModel
                            return (
                              <label
                                key={item.id}
                                className={cx(
                                  'rml-providerbar__model',
                                  checked && 'is-checked',
                                  onlyEnabledModel && 'is-required',
                                  unavailable && 'is-unavailable',
                                )}
                                title={
                                  unavailable
                                    ? `Connect ${provider.name} CLI to make this model available`
                                    : onlyEnabledModel
                                      ? 'Keep at least one model in the chat picker'
                                      : item.description
                                }
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={disabled}
                                  onChange={() => toggleModel(item.id)}
                                />
                                <span className="rml-providerbar__model-name">{item.name}</span>
                                {unavailable ? (
                                  <span className="rml-providerbar__model-state">Connect CLI</span>
                                ) : null}
                                <span className="rml-providerbar__checkbox" aria-hidden="true">
                                  <svg viewBox="0 0 14 14"><path d="m3 7.2 2.5 2.5L11 4.5" /></svg>
                                </span>
                              </label>
                            )
                          })}
                        </motion.div>
                      ) : null}
                    </AnimatePresence>
                  </section>
                )
              })}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <button
        type="button"
        className="rml-providerbar__trigger"
        aria-expanded={open}
        onClick={() => {
          if (open) close()
          else setOpen(true)
        }}
      >
        <svg className="rml-providerbar__library-icon" viewBox="0 0 18 18" aria-hidden="true">
          <path d="M3 4.5h12M3 9h12M3 13.5h12" />
          <circle cx="6" cy="4.5" r="1.25" />
          <circle cx="12" cy="9" r="1.25" />
          <circle cx="8" cy="13.5" r="1.25" />
        </svg>
        <span className="rml-providerbar__trigger-copy">
          <small>Model picker</small>
          <strong>{enabledModelIds.length} of {totalModels} shown</strong>
        </span>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 9 4-4 4 4" /></svg>
      </button>
    </div>
  )
}

export default ProviderBar
