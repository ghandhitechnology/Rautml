import { useStore } from '../../state/store'
import { cx } from '../../lib/utils'
import './SettingsButton.css'

export interface SettingsButtonProps {
  className?: string
  /**
   * `sidebar` — the pill in the chat-list footer, the primary entry.
   * `topbar`  — an icon-only twin, so settings stays reachable when the
   *             sidebar is collapsed (its track is 0px wide on desktop).
   */
  variant?: 'sidebar' | 'topbar'
  /** Sidebar rail state: drop the label, keep the gear. */
  collapsed?: boolean
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3.1" />
      <path d="M19.4 14.4a1.5 1.5 0 0 0 .3 1.66l.06.06a1.82 1.82 0 1 1-2.58 2.58l-.06-.06a1.5 1.5 0 0 0-1.66-.3 1.5 1.5 0 0 0-.91 1.38v.17a1.82 1.82 0 1 1-3.64 0v-.09a1.5 1.5 0 0 0-.98-1.37 1.5 1.5 0 0 0-1.66.3l-.06.06a1.82 1.82 0 1 1-2.58-2.58l.06-.06a1.5 1.5 0 0 0 .3-1.66 1.5 1.5 0 0 0-1.38-.91h-.17a1.82 1.82 0 1 1 0-3.64h.09a1.5 1.5 0 0 0 1.37-.98 1.5 1.5 0 0 0-.3-1.66l-.06-.06a1.82 1.82 0 1 1 2.58-2.58l.06.06a1.5 1.5 0 0 0 1.66.3h.07a1.5 1.5 0 0 0 .91-1.38v-.17a1.82 1.82 0 1 1 3.64 0v.09a1.5 1.5 0 0 0 .91 1.37 1.5 1.5 0 0 0 1.66-.3l.06-.06a1.82 1.82 0 1 1 2.58 2.58l-.06.06a1.5 1.5 0 0 0-.3 1.66v.07a1.5 1.5 0 0 0 1.38.91h.17a1.82 1.82 0 1 1 0 3.64h-.09a1.5 1.5 0 0 0-1.37.91Z" />
    </svg>
  )
}

/** Compact entry into the settings page. Replaced the ProviderBar panel that
 *  used to occupy the sidebar footer — model choice now lives inside Settings. */
export function SettingsButton({ className, variant = 'sidebar', collapsed = false }: SettingsButtonProps) {
  const openSettings = useStore((s) => s.openSettings)

  return (
    <button
      type="button"
      className={cx('rml-settings-btn', `is-${variant}`, collapsed && 'is-collapsed', className)}
      onClick={() => openSettings()}
      aria-label="Settings"
      title="Settings"
      data-settings-button
    >
      <span className="rml-settings-btn__icon" aria-hidden="true">
        <GearIcon />
      </span>
      {variant === 'sidebar' && !collapsed ? (
        <span className="rml-settings-btn__label">Settings</span>
      ) : null}
    </button>
  )
}

export default SettingsButton
