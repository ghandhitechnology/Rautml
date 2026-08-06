import { useEffect, useState } from 'react'
import { cx } from '../../lib/utils'
import { useApiKeys, useStore } from '../../state/store'
import type { ApiKeyStatus } from '../../lib/types'
import './KeySettings.css'

/**
 * Keys are written to the .env file the engine boots from and applied to the
 * running process at the same time, so a saved key works on the next message —
 * no restart. The server only ever returns a masked value, so an already-set key
 * shows as `••••4f2a` and the field starts empty.
 */
export function KeySettings() {
  const keys = useApiKeys()
  const loadSettings = useStore((s) => s.loadSettings)

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  return (
    <section className="rml-keyset">
      <header className="rml-settings-section__head">
        <h2>API keys</h2>
        <p>
          Your own keys for the services Rautml calls. They are stored in this app's private
          configuration file on this machine and are never sent anywhere but the service they belong
          to. Saving one takes effect immediately.
        </p>
      </header>

      {keys.map((key) => (
        <KeyField key={key.name} field={key} />
      ))}
    </section>
  )
}

function KeyField({ field }: { field: ApiKeyStatus }) {
  const saveApiKey = useStore((s) => s.saveApiKey)
  const saving = useStore((s) => Boolean(s.settingsSaving[field.name]))
  const [value, setValue] = useState('')
  const [reveal, setReveal] = useState(false)
  const [justSaved, setJustSaved] = useState(false)

  useEffect(() => {
    if (!justSaved) return
    const timer = setTimeout(() => setJustSaved(false), 2200)
    return () => clearTimeout(timer)
  }, [justSaved])

  const save = async (next: string) => {
    await saveApiKey(field.name, next)
    setValue('')
    setReveal(false)
    setJustSaved(true)
  }

  return (
    <article className={cx('rml-settings-card', 'rml-keyset__field', field.set && 'is-set')}>
      <div className="rml-keyset__label">
        <h3>
          {field.label}
          {field.optional ? <span className="rml-keyset__optional">optional</span> : null}
        </h3>
        <p>{field.hint}</p>
      </div>

      <div className="rml-keyset__row">
        <div className="rml-keyset__input">
          <input
            type={reveal ? 'text' : 'password'}
            value={value}
            spellCheck={false}
            autoComplete="off"
            placeholder={field.set ? field.masked : 'Not set'}
            aria-label={`${field.label} API key`}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && value.trim()) void save(value)
            }}
          />
          {value ? (
            <button
              type="button"
              className="rml-keyset__reveal"
              onClick={() => setReveal((r) => !r)}
              aria-label={reveal ? 'Hide the key' : 'Show the key'}
              title={reveal ? 'Hide' : 'Show'}
            >
              {reveal ? (
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M3 10s2.6-4.4 7-4.4S17 10 17 10s-2.6 4.4-7 4.4S3 10 3 10Z" />
                  <circle cx="10" cy="10" r="1.9" />
                  <path d="m4 16 12-12" />
                </svg>
              ) : (
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M3 10s2.6-4.4 7-4.4S17 10 17 10s-2.6 4.4-7 4.4S3 10 3 10Z" />
                  <circle cx="10" cy="10" r="1.9" />
                </svg>
              )}
            </button>
          ) : null}
        </div>

        <button
          type="button"
          className="rml-keyset__save"
          disabled={saving || !value.trim()}
          onClick={() => void save(value)}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>

        {field.set ? (
          <button
            type="button"
            className="rml-keyset__remove"
            disabled={saving}
            onClick={() => void save('')}
            title={`Remove the ${field.label} key`}
          >
            Remove
          </button>
        ) : null}
      </div>

      <p className="rml-keyset__state" role="status">
        {justSaved ? (
          <span className="is-saved">Saved</span>
        ) : field.set ? (
          <>
            Set — <code>{field.masked}</code>
          </>
        ) : (
          'Not set'
        )}
      </p>

      {field.source === 'environment' ? (
        <p className="rml-keyset__shadowed">
          This value is coming from your shell environment, which takes priority when Rautml
          starts. A key saved here works right away, but the shell's value returns on the next
          launch — unexport <code>{field.name}</code> in your shell profile to make this field
          stick.
        </p>
      ) : null}
    </article>
  )
}

export default KeySettings
