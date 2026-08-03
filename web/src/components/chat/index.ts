/* components/chat — the conversation surface.
 * ChatThread is the single mount point; the rest are exported for the fork panel
 * and the assembler. */

export { default as ChatThread, type ChatThreadProps } from './ChatThread'
export { default as MessageBubble, type MessageBubbleProps } from './MessageBubble'
export { default as Markdown, type MarkdownProps, CopyButton } from './Markdown'
export { default as ActivityTimeline, type ActivityTimelineProps } from './ActivityTimeline'
export { default as InputChips, type InputChipsProps } from './InputChips'
export {
  default as FileCard,
  FileCards,
  presentedFileUrl,
  type FileCardProps,
  type FileCardsProps,
} from './FileCard'
export { default as WidgetCard, type WidgetCardProps } from './WidgetCard'
export { Icon, toolIcon, fileIcon, type IconName, type IconProps } from './icons'

export { default } from './ChatThread'
