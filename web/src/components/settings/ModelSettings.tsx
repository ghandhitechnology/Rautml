import { useEffect } from 'react'
import { cx } from '../../lib/utils'
import { useProviders, useStore } from '../../state/store'
import './ModelSettings.css'

const STATUS_LABEL: Record<string, string> = {
  connected: 'Connected',
  disconnected: 'Not signed in',
  unavailable: 'CLI not found',
}

/**
 * The former ProviderBar popover, given a page.
 *
 * Same store bindings and the same two guards it always enforced: the last
 * enabled model cannot be unchecked, and a model behind a disconnected CLI is
 * not selectable. Every provider group is open at once now — there is room.
 */
export function ModelSettings() {
  const providers = useProviders()
  const enabledModelIds = useStore((s) => s.enabledModelIds)
  const toggleModel = useStore((s) => s.toggleModelEnabled)
  const refresh = useStore((s) => s.refreshProviders)
  const reconnect = useStore((s) => s.reconnectProvider)

  // CLI logins leave the app for Terminal and a browser; re-read on return so a
  // completed sign-in shows up without a manual Refresh.
  useEffect(() => {
    const syncAfterLogin = () => void refresh()
    syncAfterLogin()
    window.addEventListener('focus', syncAfterLogin)
    return () => window.removeEventListener('focus', syncAfterLogin)
  }, [refresh])

  const enabled = new Set(enabledModelIds)
  const totalModels = providers.reduce((sum, provider) => sum + provider.models.length, 0)

  return (
    <section className="rml-modelset">
      <header className="rml-settings-section__head">
        <h2>Model selector</h2>
        <p>
          Link a provider, then check the models you want in the composer's picker.{' '}
          {totalModels > 0 ? (
            <strong>
              {enabledModelIds.length} of {totalModels} shown.
            </strong>
          ) : null}
        </p>
      </header>

      <div className="rml-modelset__toolbar">
        <button type="button" className="rml-modelset__refresh" onClick={() => void refresh()}>
          Refresh catalogs
        </button>
      </div>

      {!providers.length ? (
        <p className="rml-modelset__empty">No providers discovered yet.</p>
      ) : null}

      {providers.map((provider) => {
        const checkedCount = provider.models.filter((model) => enabled.has(model.id)).length
        const connected = provider.authStatus === 'connected'
        // OpenRouter authenticates by API key, not by a CLI login.
        const isOpenRouter = provider.id === 'openrouter'
        return (
          <article
            key={provider.id}
            className={cx('rml-settings-card', 'rml-modelset__group', checkedCount > 0 && 'has-enabled')}
          >
            <header className="rml-modelset__head">
              <div className="rml-modelset__identity">
                <h3>
                  <span className={cx('rml-modelset__status', `is-${provider.authStatus}`)} aria-hidden="true" />
                  {provider.name}
                </h3>
                <p>{provider.description}</p>
              </div>
              <span className="rml-modelset__count">
                {checkedCount}/{provider.modelCount}
              </span>
            </header>

            {!connected ? (
              <div className="rml-modelset__connect">
                <div>
                  <strong>{STATUS_LABEL[provider.authStatus] ?? provider.authStatus}</strong>
                  {provider.authHint ? <code>{provider.authHint}</code> : null}
                </div>
                {isOpenRouter ? (
                  <SettingsLink />
                ) : (
                  <button type="button" onClick={() => void reconnect(provider.id)}>
                    {provider.installed ? 'Connect with CLI' : `${provider.name} CLI not found`}
                  </button>
                )}
              </div>
            ) : null}

            {provider.models.length ? (
              <ul className="rml-modelset__models">
                {provider.models.map((item) => {
                  const checked = enabled.has(item.id)
                  const unavailable = !isOpenRouter && !connected
                  const onlyEnabledModel = checked && enabledModelIds.length === 1
                  const disabled = unavailable || onlyEnabledModel
                  return (
                    <li key={item.id}>
                      <label
                        className={cx(
                          'rml-modelset__model',
                          checked && 'is-checked',
                          onlyEnabledModel && 'is-required',
                          unavailable && 'is-unavailable',
                        )}
                        title={
                          unavailable
                            ? `Connect ${provider.name} to make this model available`
                            : onlyEnabledModel
                              ? 'Keep at least one model in the picker'
                              : item.description
                        }
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={disabled}
                          onChange={() => toggleModel(item.id)}
                        />
                        <span className="rml-modelset__checkbox" aria-hidden="true">
                          <svg viewBox="0 0 14 14">
                            <path d="m3 7.2 2.5 2.5L11 4.5" />
                          </svg>
                        </span>
                        <span className="rml-modelset__model-copy">
                          <span className="rml-modelset__model-name">{item.name}</span>
                          {item.description ? <small>{item.description}</small> : null}
                        </span>
                        {unavailable ? <span className="rml-modelset__model-state">Locked</span> : null}
                      </label>
                    </li>
                  )
                })}
              </ul>
            ) : null}
          </article>
        )
      })}
    </section>
  )
}

/** OpenRouter is unlocked by a key, so point at the section that holds it. */
function SettingsLink() {
  const setSection = useStore((s) => s.setSettingsSection)
  return (
    <button type="button" onClick={() => setSection('keys')}>
      Add API key
    </button>
  )
}

export default ModelSettings
