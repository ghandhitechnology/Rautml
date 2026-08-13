import { useEffect, useMemo } from 'react'
import { cx } from '../../lib/utils'
import { useProviders, useStore, useUsage } from '../../state/store'
import type { ProviderBalance, ProviderUsage, UsageWindow } from '../../lib/types'
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
  const usage = useUsage()
  const enabledModelIds = useStore((s) => s.enabledModelIds)
  const toggleModel = useStore((s) => s.toggleModelEnabled)
  const refresh = useStore((s) => s.refreshProviders)
  const loadUsage = useStore((s) => s.loadUsage)
  const reconnect = useStore((s) => s.reconnectProvider)
  const usageById = useMemo(() => {
    const map = new Map<string, ProviderUsage>()
    for (const item of usage.providers) map.set(item.id, item)
    return map
  }, [usage.providers])
  const extraUsage = useMemo(() => {
    const known = new Set(providers.map((provider) => provider.id))
    return usage.providers.filter(
      (item) => !known.has(item.id) && (item.fiveHour || item.weekly || item.balance),
    )
  }, [providers, usage.providers])

  // CLI logins leave the app for Terminal and a browser; re-read on return so a
  // completed sign-in shows up without a manual Refresh.
  useEffect(() => {
    const syncAfterLogin = () => {
      void refresh()
      void loadUsage()
    }
    syncAfterLogin()
    window.addEventListener('focus', syncAfterLogin)
    return () => window.removeEventListener('focus', syncAfterLogin)
  }, [loadUsage, refresh])

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
        {usage.updatedAt ? (
          <p className="rml-modelset__updated">{formatUpdatedAt(usage.updatedAt)}</p>
        ) : null}
        <button
          type="button"
          className="rml-modelset__refresh"
          onClick={() => {
            void refresh()
            void loadUsage()
          }}
        >
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

            <UsageMeters usage={usageById.get(provider.id)} />

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

      {extraUsage.map((item) => (
        <article key={item.id} className="rml-settings-card rml-modelset__group">
          <header className="rml-modelset__head">
            <div className="rml-modelset__identity">
              <h3>{item.name}</h3>
            </div>
          </header>
          <UsageMeters usage={item} />
        </article>
      ))}
    </section>
  )
}

function UsageMeters({ usage }: { usage?: ProviderUsage }) {
  if (!usage || (!usage.fiveHour && !usage.weekly && !usage.balance)) return null
  return (
    <div className="rml-usage" aria-label={`${usage.name} usage and balance`}>
      {usage.balance ? <Balance balance={usage.balance} /> : null}
      {usage.fiveHour ? <UsageBar label="5 hours" window={usage.fiveHour} /> : null}
      {usage.weekly ? <UsageBar label="This week" window={usage.weekly} /> : null}
    </div>
  )
}

function Balance({ balance }: { balance: ProviderBalance }) {
  const detail =
    balance.used !== undefined && balance.total !== undefined
      ? `${formatUsd(balance.used)} used of ${formatUsd(balance.total)} ${balance.scope === 'account' ? 'purchased' : 'key limit'}`
      : balance.scope === 'account'
        ? 'Account credits'
        : 'API key spending limit'
  return (
    <div className="rml-usage__balance">
      <div>
        <span>{balance.scope === 'account' ? 'Credit balance' : 'Key balance'}</span>
        <small>{detail}</small>
      </div>
      <strong>{formatUsd(balance.remaining)}</strong>
    </div>
  )
}

function UsageBar({ label, window }: { label: string; window: UsageWindow }) {
  const used = Math.min(100, Math.max(0, window.usedPercent))
  return (
    <div className="rml-usage__row">
      <div className="rml-usage__meta">
        <span>{label}</span>
        <strong>{Math.round(used)}%</strong>
      </div>
      <div className="rml-usage__track" aria-hidden="true">
        <span className="rml-usage__fill" style={{ width: `${used}%` }} />
      </div>
      {window.resetAt ? <p className="rml-usage__reset">{formatResetAt(window.resetAt)}</p> : null}
    </div>
  )
}

function formatUpdatedAt(at: number): string {
  const delta = Date.now() - at
  if (delta < 45_000) return 'Provider data just updated'
  if (delta < 90_000) return 'Provider data from a minute ago'
  if (delta < 60 * 60_000) return `Provider data from ${Math.round(delta / 60_000)} minutes ago`
  if (delta < 36 * 60 * 60_000) return `Provider data from ${Math.round(delta / (60 * 60_000))} hours ago`
  return `Provider data from ${new Date(at).toLocaleString()}`
}

function formatResetAt(at: number): string {
  const delta = at - Date.now()
  if (delta <= 0) return 'Reset due'
  if (delta < 90 * 60_000) return `Resets in ${Math.max(1, Math.round(delta / 60_000))} min`
  const when = new Date(at)
  const sameDay = when.toDateString() === new Date().toDateString()
  const time = when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (sameDay) return `Resets ${time}`
  const day = when.toLocaleDateString(undefined, { weekday: 'short' })
  return `Resets ${day} ${time}`
}

function formatUsd(amount: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.abs(amount) < 1 ? 4 : 2,
  }).format(amount)
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
