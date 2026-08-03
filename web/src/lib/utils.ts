/* Small shared helpers. No dependencies, no DOM assumptions beyond navigator.language. */

/** Join class names, skipping falsy values. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

const RELATIVE_STEPS: [limit: number, unit: Intl.RelativeTimeFormatUnit, ms: number][] = [
  [60_000, 'second', 1_000],
  [3_600_000, 'minute', 60_000],
  [86_400_000, 'hour', 3_600_000],
  [604_800_000, 'day', 86_400_000],
  [2_592_000_000, 'week', 604_800_000],
  [31_536_000_000, 'month', 2_592_000_000],
  [Infinity, 'year', 31_536_000_000],
]

function locale(): string {
  return typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en'
}

/** "3분 전" / "3 min ago" — localized, tuned for chat-list timestamps. */
export function relativeTime(timestamp: number, now = Date.now()): string {
  const diff = timestamp - now
  const abs = Math.abs(diff)
  if (abs < 45_000) return new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' }).format(0, 'second')

  for (const [limit, unit, ms] of RELATIVE_STEPS) {
    if (abs < limit) {
      const value = Math.round(diff / ms)
      return new Intl.RelativeTimeFormat(locale(), { numeric: 'auto', style: 'narrow' }).format(
        value,
        unit,
      )
    }
  }
  return ''
}

/** Absolute timestamp for tooltips. */
export function absoluteTime(timestamp: number): string {
  return new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(timestamp),
  )
}

/** "1.4s" / "38s" / "2m 05s" — run durations. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s'
  if (ms < 1000) return `${Math.max(1, Math.round(ms / 100)) / 10}s`
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}m ${String(s).padStart(2, '0')}s`
}

/** 12.4 KB / 1.1 MB */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** i
  return `${i === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`
}

/** Crypto-backed id with a graceful fallback (used for optimistic messages). */
export function uid(prefix = ''): string {
  const raw =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36)
  return prefix ? `${prefix}${raw}` : raw
}
