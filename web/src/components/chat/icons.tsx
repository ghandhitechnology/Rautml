/* Hand-drawn 24×24 stroke icons used across the chat surface.
 * One sprite-less component, currentColor everywhere, no icon library. */

import type { ReactNode, SVGProps } from 'react'

export type IconName =
  | 'search'
  | 'globe'
  | 'image'
  | 'terminal'
  | 'file'
  | 'sparkle'
  | 'pencil'
  | 'eye'
  | 'question'
  | 'check'
  | 'cross'
  | 'chevron'
  | 'copy'
  | 'download'
  | 'external'
  | 'alert'
  | 'arrowDown'
  | 'code'
  | 'chat'
  | 'stack'
  | 'thought'
  | 'menu'
  | 'paperclip'

const PATHS: Record<IconName, ReactNode> = {
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.7-3.7" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3.2 12h17.6" />
      <path d="M12 3a15.5 15.5 0 0 1 0 18a15.5 15.5 0 0 1 0-18" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.6" />
      <circle cx="8.6" cy="9.8" r="1.5" />
      <path d="m4 17.4 4.4-4.3a1.9 1.9 0 0 1 2.7 0L15 17" />
      <path d="m13.8 14.6 1.6-1.6a1.9 1.9 0 0 1 2.7 0L20.4 15" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.6" />
      <path d="m7.6 9.8 2.9 2.4-2.9 2.4" />
      <path d="M13.4 14.8h3.4" />
    </>
  ),
  file: (
    <>
      <path d="M14 3.5H8.4A2.4 2.4 0 0 0 6 5.9v12.2a2.4 2.4 0 0 0 2.4 2.4h7.2a2.4 2.4 0 0 0 2.4-2.4V7.6z" />
      <path d="M13.9 3.6V7.7h4.1" />
    </>
  ),
  sparkle: (
    <>
      <path d="M11.4 3.6 13 8.8l5.2 1.6-5.2 1.6-1.6 5.2-1.6-5.2L4.6 10.4 9.8 8.8z" />
      <path d="m18.4 15.6.7 2.2 2.2.7-2.2.7-.7 2.2-.7-2.2-2.2-.7 2.2-.7z" />
    </>
  ),
  pencil: (
    <>
      <path d="M4.6 19.4h4L19 9a2.1 2.1 0 0 0-3-3L5.6 16.4z" />
      <path d="m14.6 7.4 2 2" />
    </>
  ),
  eye: (
    <>
      <path d="M2.8 12S6.3 5.8 12 5.8 21.2 12 21.2 12 17.7 18.2 12 18.2 2.8 12 2.8 12" />
      <circle cx="12" cy="12" r="2.9" />
    </>
  ),
  question: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.6a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .9-1 1.6v.3" />
      <path d="M12 16.8v.2" />
    </>
  ),
  check: <path d="m5.4 12.6 4.4 4.4L18.8 7.6" />,
  cross: (
    <>
      <path d="M6.8 6.8 17.2 17.2" />
      <path d="M17.2 6.8 6.8 17.2" />
    </>
  ),
  chevron: <path d="m6.4 9.6 5.6 5.6 5.6-5.6" />,
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2.4" />
      <path d="M15 6.6V6.2A2.2 2.2 0 0 0 12.8 4H6.2A2.2 2.2 0 0 0 4 6.2v6.6A2.2 2.2 0 0 0 6.2 15h.4" />
    </>
  ),
  download: (
    <>
      <path d="M12 4.2v10.4" />
      <path d="m7.6 10.6 4.4 4.4 4.4-4.4" />
      <path d="M4.8 19.4h14.4" />
    </>
  ),
  external: (
    <>
      <path d="M14.2 4.6h5.2v5.2" />
      <path d="M19.4 4.6 11.2 12.8" />
      <path d="M18 14.6V18a2.2 2.2 0 0 1-2.2 2.2H6.2A2.2 2.2 0 0 1 4 18V8.4a2.2 2.2 0 0 1 2.2-2.2h3.4" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.6v5.2" />
      <path d="M12 16.2v.2" />
    </>
  ),
  arrowDown: (
    <>
      <path d="M12 4.8v14" />
      <path d="m6.2 13 5.8 5.8 5.8-5.8" />
    </>
  ),
  code: (
    <>
      <path d="m9.2 8.2-4.4 3.8 4.4 3.8" />
      <path d="m14.8 8.2 4.4 3.8-4.4 3.8" />
    </>
  ),
  chat: (
    <>
      <path d="M20.4 12.4a7.6 7.6 0 0 1-8.2 7.6c-.7 0-1.4-.1-2-.3L4.4 21l1.4-3.5a7.3 7.3 0 0 1-1.2-4.1 7.6 7.6 0 0 1 7.6-7.6h.4a7.6 7.6 0 0 1 7.8 6.6z" />
      <path d="M9.4 12.4h5.6" />
    </>
  ),
  stack: (
    <>
      <path d="m12 3.6 8.4 4.2-8.4 4.2-8.4-4.2z" />
      <path d="m3.6 12.4 8.4 4.2 8.4-4.2" />
      <path d="m3.6 16.6 8.4 4.2 8.4-4.2" />
    </>
  ),
  thought: (
    <>
      <path d="M16.8 16.6H7.4a3.8 3.8 0 0 1-1-7.5A5.2 5.2 0 0 1 16.6 7.9a4.4 4.4 0 0 1 .2 8.7z" />
      <circle cx="8.2" cy="19.4" r="1" />
      <circle cx="5.6" cy="21.4" r="0.5" />
    </>
  ),
  menu: (
    <>
      <path d="M4.2 8.4h15.6" />
      <path d="M4.2 15.6h11.2" />
    </>
  ),
  paperclip: (
    <path d="m17.8 11.2-6 6a4.1 4.1 0 0 1-5.8-5.8l7-7a2.75 2.75 0 0 1 3.9 3.9l-6.9 6.9a1.4 1.4 0 0 1-2-2l6-6" />
  ),
}

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName
  size?: number
}

export function Icon({ name, size = 16, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  )
}

/** Tool name → glyph. Exact names from CONTRACT.md § Tools, with soft fallbacks. */
export function toolIcon(name: string): IconName {
  switch (name) {
    case 'web_search':
      return 'search'
    case 'web_fetch':
      return 'globe'
    case 'image_search':
      return 'image'
    case 'bash_tool':
      return 'terminal'
    case 'create_file':
      return 'file'
    case 'str_replace':
      return 'pencil'
    case 'view':
      return 'eye'
    case 'present_files':
      return 'download'
    case 'visualize_read_me':
    case 'visualize_show_widget':
      return 'sparkle'
    case 'ask_user_input_v0':
      return 'question'
    case 'spawn_subagents':
      return 'stack'
    case 'list_sources':
      return 'stack'
    case 'search_sources':
      return 'search'
    case 'read_source':
      return 'file'
    case 'thinking':
      return 'thought'
    default:
      break
  }
  const n = name.toLowerCase()
  if (n.includes('image') || n.includes('photo')) return 'image'
  if (n.includes('search')) return 'search'
  if (n.includes('fetch') || n.includes('web') || n.includes('url')) return 'globe'
  if (n.includes('bash') || n.includes('shell') || n.includes('exec')) return 'terminal'
  if (n.includes('file') || n.includes('write') || n.includes('read')) return 'file'
  if (n.includes('ask') || n.includes('input')) return 'question'
  return 'sparkle'
}

/** File extension → glyph, for FileCard. */
export function fileIcon(name: string): IconName {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'].includes(ext)) return 'image'
  if (['html', 'css', 'js', 'ts', 'tsx', 'jsx', 'json', 'py', 'sh', 'md'].includes(ext)) return 'code'
  return 'file'
}

export default Icon
