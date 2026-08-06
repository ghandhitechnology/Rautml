import { useEffect, useRef, useState } from 'react'
import { usePersonalization, useStore } from '../../state/store'
import type { Personalization } from '../../lib/types'
import './PersonalizationSettings.css'

/** Matches PERSONALIZATION_MAX_CHARS on the server, which truncates past it. */
const MAX_CHARS = 4000

/**
 * Two standing instructions, injected at two different moments:
 *
 *   Design choices → the asset design constitution, returned by the
 *     `visualize_read_me` tool right before the first asset is built.
 *   More about me  → the system prompt, on every run in both threads.
 *
 * Each field saves when it loses focus, so a half-typed sentence never reaches
 * the model and no keystroke turns into a request.
 */
export function PersonalizationSettings() {
  const personalization = usePersonalization()
  const loadSettings = useStore((s) => s.loadSettings)

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  return (
    <section className="rml-personal">
      <header className="rml-settings-section__head">
        <h2>Personalization</h2>
        <p>
          Standing instructions that ride along with every conversation, so you do not have to
          repeat them. Anything you ask for inside a chat still wins over what you write here.
        </p>
      </header>

      <PersonalizationField
        field="designPreferences"
        title="Design choices"
        blurb="How generated pages should look, applied whenever Rautml builds one."
        placeholder={'e.g. Keep it simple.\nI like diagrams — draw one wherever it helps.\nNo big colour blocks.'}
        value={personalization.designPreferences}
      />

      <PersonalizationField
        field="aboutMe"
        title="More about me"
        blurb="Your profession, your interests, and the voice you want back."
        placeholder={
          'e.g. I am a materials engineer.\nInterested in batteries and manufacturing.\nWrite plainly — no hype, and do not over-explain the basics.'
        }
        value={personalization.aboutMe}
      />
    </section>
  )
}

function PersonalizationField({
  field,
  title,
  blurb,
  placeholder,
  value,
}: {
  field: keyof Personalization
  title: string
  blurb: string
  placeholder: string
  value: string
}) {
  const savePersonalization = useStore((s) => s.savePersonalization)
  const saving = useStore((s) => Boolean(s.settingsSaving[field]))
  const [draft, setDraft] = useState(value)
  const [justSaved, setJustSaved] = useState(false)
  // What the server last confirmed — the baseline a blur compares against.
  const committed = useRef(value)

  // Adopt the server value once it arrives, but never clobber live typing.
  useEffect(() => {
    if (value === committed.current) return
    committed.current = value
    setDraft((current) => (current === '' || current === committed.current ? value : current))
  }, [value])

  useEffect(() => {
    if (!justSaved) return
    const timer = setTimeout(() => setJustSaved(false), 2200)
    return () => clearTimeout(timer)
  }, [justSaved])

  const commit = async () => {
    const next = draft.trim()
    if (next === committed.current) return
    committed.current = next
    await savePersonalization({ [field]: next })
    setJustSaved(true)
  }

  const dirty = draft.trim() !== committed.current

  return (
    <article className="rml-settings-card rml-personal__field">
      <div className="rml-personal__label">
        <h3>{title}</h3>
        <p>{blurb}</p>
      </div>

      <textarea
        value={draft}
        rows={5}
        maxLength={MAX_CHARS}
        spellCheck
        placeholder={placeholder}
        aria-label={title}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
      />

      <footer className="rml-personal__foot">
        <span className="rml-personal__state" role="status">
          {saving ? 'Saving…' : justSaved ? <span className="is-saved">Saved</span> : dirty ? 'Unsaved' : ''}
        </span>
        <span className="rml-personal__count">
          {draft.length}/{MAX_CHARS}
        </span>
      </footer>
    </article>
  )
}

export default PersonalizationSettings
