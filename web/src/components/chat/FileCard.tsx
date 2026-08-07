/* Download cards for `present_files` (files.presented). One row per file:
 * extension glyph, name, size, and a download affordance. */

import { memo } from 'react'
import { motion } from 'framer-motion'
import { EASE } from '../../lib/motion'
import { cx, formatBytes } from '../../lib/utils'
import type { PresentedFile } from '../../lib/types'
import { Icon, fileIcon } from './icons'
import './FileCard.css'

/** Workspace file URL. Mirrors the asset route shape: /api/chats/:id/files/<relPath>. */
export function presentedFileUrl(chatId: string, relPath: string): string {
  const path = relPath
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/')
  return `/api/chats/${encodeURIComponent(chatId)}/files/${path}`
}

export interface FileCardProps {
  file: PresentedFile
  /** Used to build the download URL when `href` is not supplied. */
  chatId?: string
  /** Explicit download URL, overriding the derived one. */
  href?: string
  /** Stagger index for the entrance animation. */
  index?: number
  compact?: boolean
  className?: string
}

export function FileCard({ file, chatId, href, index = 0, compact = false, className }: FileCardProps) {
  const url = href ?? (chatId ? presentedFileUrl(chatId, file.relPath) : undefined)

  return (
    <motion.a
      className={cx('rml-file', compact && 'rml-file--compact', className)}
      href={url}
      download={file.name}
      target="_blank"
      rel="noreferrer"
      title={file.relPath}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: EASE, delay: Math.min(index, 6) * 0.045 }}
    >
      <span className="rml-file__glyph" aria-hidden="true">
        <Icon name={fileIcon(file.name)} size={16} />
      </span>
      <span className="rml-file__meta">
        <span className="rml-file__name">{file.name}</span>
        <span className="rml-file__sub">{formatBytes(file.size)}</span>
      </span>
      <span className="rml-file__action" aria-hidden="true">
        <Icon name="download" size={15} />
      </span>
    </motion.a>
  )
}

export interface FileCardsProps {
  files: PresentedFile[]
  chatId?: string
  compact?: boolean
  className?: string
}

/** Responsive grid of FileCards — what ChatThread renders for one files.presented event.
 * Memoized: the files array keeps identity across stream flushes. */
export const FileCards = memo(function FileCards({ files, chatId, compact, className }: FileCardsProps) {
  if (!files.length) return null
  return (
    <div className={cx('rml-files', compact && 'rml-files--compact', className)}>
      {files.map((file, i) => (
        <FileCard key={file.relPath} file={file} chatId={chatId} index={i} compact={compact} />
      ))}
    </div>
  )
})

export default FileCard
