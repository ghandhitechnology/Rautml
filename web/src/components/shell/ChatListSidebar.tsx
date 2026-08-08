import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type FormEvent,
  type MouseEvent,
} from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
  useActiveChatId,
  useChats,
  useOnBlankChat,
  useProjects,
  useStore,
} from '../../state/store'
import type { Chat, Project } from '../../lib/types'
import { absoluteTime, cx, relativeTime } from '../../lib/utils'
import { EASE, SIDEBAR_TRANSITION_MS } from '../../lib/motion'
import TypewriterText from './TypewriterText'
import SettingsButton from '../settings/SettingsButton'
import rautmlMark from '../../assets/rautml-mark.png'
import './ChatListSidebar.css'

export interface ChatListSidebarProps {
  className?: string
  /** Desktop compact-rail state. Mobile always renders the full drawer. */
  collapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
}

function HoverScrollTitle({ text }: { text: string }) {
  const viewportRef = useRef<HTMLSpanElement>(null)
  const titleRef = useRef<HTMLSpanElement>(null)
  const [overflow, setOverflow] = useState(0)
  const [cycleDistance, setCycleDistance] = useState(0)

  useEffect(() => {
    const viewport = viewportRef.current
    const title = titleRef.current
    if (!viewport || !title) return

    const measure = () => {
      const titleWidth = Math.ceil(title.scrollWidth)
      const nextOverflow = Math.max(0, titleWidth - viewport.clientWidth)
      setOverflow((current) => (current === nextOverflow ? current : nextOverflow))
      setCycleDistance((current) => (current === titleWidth ? current : titleWidth))
    }
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    observer.observe(title)
    measure()
    return () => observer.disconnect()
  }, [text])

  const style = {
    '--rml-chat-title-distance': `calc(-${cycleDistance}px - var(--rml-chat-title-gap))`,
    '--rml-chat-title-duration': `${Math.min(14, Math.max(5, cycleDistance / 32))}s`,
  } as CSSProperties

  return (
    <span ref={viewportRef} className={cx('rml-chatrow__title', overflow > 0 && 'is-overflowing')}>
      <span className="rml-chatrow__title-track" style={style}>
        <span ref={titleRef} className="rml-chatrow__title-copy">
          <TypewriterText text={text} />
        </span>
        {overflow > 0 ? (
          <span className="rml-chatrow__title-copy" aria-hidden="true">
            {text}
          </span>
        ) : null}
      </span>
    </span>
  )
}

interface ChatRowProps {
  chat: Chat
  projects: Project[]
  active: boolean
  armed: boolean
  dragging: boolean
  nested?: boolean
  rowMotion: boolean
  reduceMotion: boolean | null
  onOpen: (chatId: string) => void
  onDelete: (event: MouseEvent, chatId: string) => void
  onMove: (chatId: string, projectId: string | null) => void
  onDragStart: (event: DragEvent, chat: Chat) => void
  onDragEnd: () => void
}

function ChatRow({
  chat,
  projects,
  active,
  armed,
  dragging,
  nested = false,
  rowMotion,
  reduceMotion,
  onOpen,
  onDelete,
  onMove,
  onDragStart,
  onDragEnd,
}: ChatRowProps) {
  return (
    <motion.li
      layout={rowMotion ? 'position' : false}
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: dragging ? 0.82 : 1, y: 0, scale: 1, clipPath: 'inset(0% 0% 0% 0%)' }}
      exit={
        reduceMotion
          ? { opacity: 0 }
          : { opacity: 0, y: -14, scale: 0.98, clipPath: 'inset(0% 0% 100% 0%)' }
      }
      transition={
        reduceMotion
          ? { duration: 0.01 }
          : {
              layout: { duration: 0.32, ease: EASE },
              opacity: { duration: 0.18, ease: EASE },
              y: { duration: 0.24, ease: EASE },
              scale: { duration: 0.24, ease: EASE },
              clipPath: { duration: 0.24, ease: EASE },
            }
      }
      style={{ transformOrigin: 'top center' }}
      className={cx(nested && 'rml-chatrow-wrap--nested')}
    >
      <div
        className={cx(
          'rml-chatrow',
          active && 'is-active',
          armed && 'is-armed',
          dragging && 'is-dragging',
        )}
        draggable
        onDragStart={(event) => onDragStart(event, chat)}
        onDragEnd={onDragEnd}
      >
        <button
          type="button"
          className="rml-chatrow__open"
          aria-current={active ? 'page' : undefined}
          aria-label={`${chat.title || 'New chat'}. Drag to move into a project.`}
          onClick={() => onOpen(chat.id)}
        >
          <span className="rml-chatrow__drag" aria-hidden="true">
            <svg viewBox="0 0 16 16">
              <circle cx="5" cy="5" r="1" />
              <circle cx="11" cy="5" r="1" />
              <circle cx="5" cy="11" r="1" />
              <circle cx="11" cy="11" r="1" />
            </svg>
          </span>
          <span className="rml-chatrow__body">
            <HoverScrollTitle text={chat.title || 'New chat'} />
            <span className="rml-chatrow__time" title={absoluteTime(chat.updatedAt)}>
              {relativeTime(chat.updatedAt)}
            </span>
          </span>
        </button>

        <label className="rml-chatrow__move" title="Move chat">
          <span className="rml-sr-only">Move {chat.title || 'New chat'} to</span>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M2.7 5.4h5l1.5 1.7h8.1v7.6a1.6 1.6 0 0 1-1.6 1.6H4.3a1.6 1.6 0 0 1-1.6-1.6V5.4Z" />
            <path d="m7.6 11.5 1.7 1.7 3.3-3.5" />
          </svg>
          <select
            value={chat.projectId ?? ''}
            onChange={(event) => onMove(chat.id, event.target.value || null)}
            aria-label={`Move ${chat.title || 'New chat'} to`}
          >
            <option value="">Chats (unfiled)</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className={cx('rml-chatrow__delete', armed && 'is-armed')}
          onClick={(event) => onDelete(event, chat.id)}
          aria-label={armed ? `Confirm delete ${chat.title}` : `Delete ${chat.title}`}
          title={armed ? 'Click again to delete' : 'Delete chat'}
        >
          {armed ? (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m5 12.6 4.4 4.4L19 7.4" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4.8 7.2h14.4M9.6 7.2V5.4h4.8v1.8M6.6 7.2l.8 11.1h9.2l.8-11.1" />
            </svg>
          )}
        </button>

        {active ? <span className="rml-chatrow__rail" aria-hidden="true" /> : null}
      </div>
    </motion.li>
  )
}

export function ChatListSidebar({
  className,
  collapsed = false,
  onCollapsedChange,
}: ChatListSidebarProps) {
  const chats = useChats()
  const projects = useProjects()
  const reduceMotion = useReducedMotion()
  const activeChatId = useActiveChatId()
  const chatsLoading = useStore((s) => s.chatsLoading)
  const openChat = useStore((s) => s.openChat)
  const newChat = useStore((s) => s.newChat)
  const createProject = useStore((s) => s.createProject)
  const moveChatToProject = useStore((s) => s.moveChatToProject)
  const removeChat = useStore((s) => s.removeChat)
  const onBlankChat = useOnBlankChat()

  const [armedId, setArmedId] = useState<string | null>(null)
  const [projectComposerOpen, setProjectComposerOpen] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [projectSaving, setProjectSaving] = useState(false)
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set())
  const [draggingChatId, setDraggingChatId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [, setTick] = useState(0)
  const projectInputRef = useRef<HTMLInputElement>(null)
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [rowsStill, setRowsStill] = useState(false)
  const [stillToken, setStillToken] = useState(0)
  const prevCollapsed = useRef(collapsed)
  if (prevCollapsed.current !== collapsed) {
    prevCollapsed.current = collapsed
    setRowsStill(true)
    setStillToken((n) => n + 1)
  }
  useEffect(() => {
    if (!stillToken) return
    const timer = setTimeout(() => setRowsStill(false), SIDEBAR_TRANSITION_MS)
    return () => clearTimeout(timer)
  }, [stillToken])
  const rowMotion = !reduceMotion && !rowsStill

  useEffect(() => {
    const id = setInterval(() => setTick((tick) => tick + 1), 30_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => () => {
    if (disarmTimer.current) clearTimeout(disarmTimer.current)
  }, [])

  useEffect(() => {
    if (projectComposerOpen) projectInputRef.current?.focus()
  }, [projectComposerOpen])

  const arm = (chatId: string) => {
    setArmedId(chatId)
    if (disarmTimer.current) clearTimeout(disarmTimer.current)
    disarmTimer.current = setTimeout(() => setArmedId(null), 3200)
  }

  const handleDelete = (event: MouseEvent, chatId: string) => {
    event.stopPropagation()
    event.preventDefault()
    if (armedId !== chatId) {
      arm(chatId)
      return
    }
    setArmedId(null)
    void removeChat(chatId)
  }

  const handleCreateProject = async (event: FormEvent) => {
    event.preventDefault()
    const name = projectName.trim()
    if (!name || projectSaving) return
    setProjectSaving(true)
    const project = await createProject(name)
    setProjectSaving(false)
    if (!project) return
    setProjectName('')
    setProjectComposerOpen(false)
    setCollapsedProjectIds((current) => {
      const next = new Set(current)
      next.delete(project.id)
      return next
    })
  }

  const handleDragStart = (event: DragEvent, chat: Chat) => {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', chat.id)
    setDraggingChatId(chat.id)
  }

  const clearDrag = () => {
    setDraggingChatId(null)
    setDropTargetId(null)
  }

  const dropChat = (event: DragEvent, projectId: string | null) => {
    event.preventDefault()
    const chatId = event.dataTransfer.getData('text/plain') || draggingChatId
    clearDrag()
    if (!chatId) return
    if (projectId) {
      setCollapsedProjectIds((current) => {
        const next = new Set(current)
        next.delete(projectId)
        return next
      })
    }
    void moveChatToProject(chatId, projectId)
  }

  const toggleProject = (projectId: string) => {
    setCollapsedProjectIds((current) => {
      const next = new Set(current)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    })
  }

  const unfiledChats = chats.filter((chat) => !chat.projectId)
  const activeChat = chats.find((chat) => chat.id === activeChatId)
  const renderChat = (chat: Chat, nested = false) => (
    <ChatRow
      key={chat.id}
      chat={chat}
      projects={projects}
      active={chat.id === activeChatId}
      armed={armedId === chat.id}
      dragging={draggingChatId === chat.id}
      nested={nested}
      rowMotion={rowMotion}
      reduceMotion={reduceMotion}
      onOpen={(chatId) => void openChat(chatId)}
      onDelete={handleDelete}
      onMove={(chatId, projectId) => void moveChatToProject(chatId, projectId)}
      onDragStart={handleDragStart}
      onDragEnd={clearDrag}
    />
  )

  const projectGroup = (project: Project) => {
    const projectChats = chats.filter((chat) => chat.projectId === project.id)
    const expanded = !collapsedProjectIds.has(project.id)
    const dropActive = dropTargetId === project.id
    return (
      <li
        key={project.id}
        className="rml-project"
        onDragEnter={(event) => {
          event.preventDefault()
          setDropTargetId(project.id)
        }}
        onDragOver={(event) => {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTargetId(null)
        }}
        onDrop={(event) => dropChat(event, project.id)}
      >
        <div className={cx('rml-project__head', dropActive && 'is-drop-target')}>
          <button
            type="button"
            className="rml-project__toggle"
            aria-expanded={expanded}
            aria-controls={`rautml-project-${project.id}`}
            onClick={() => toggleProject(project.id)}
          >
            <svg className="rml-project__chevron" viewBox="0 0 16 16" aria-hidden="true">
              <path d="m6 4 4 4-4 4" />
            </svg>
            <svg className="rml-project__folder" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M2.7 5.4h5l1.5 1.7h8.1v7.6a1.6 1.6 0 0 1-1.6 1.6H4.3a1.6 1.6 0 0 1-1.6-1.6V5.4Z" />
              <path d="M2.7 7.1h14.6" />
            </svg>
            <span className="rml-project__name">{project.name}</span>
            <span className="rml-project__count">{projectChats.length}</span>
          </button>
          <button
            type="button"
            className="rml-project__newchat"
            aria-label={`New chat in ${project.name}`}
            title={`New chat in ${project.name}`}
            disabled={onBlankChat && activeChat?.projectId === project.id}
            onClick={() => void newChat(project.id)}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 3.5v9M3.5 8h9" />
            </svg>
          </button>
        </div>
        <AnimatePresence initial={false}>
          {expanded ? (
            <motion.div
              id={`rautml-project-${project.id}`}
              className="rml-project__body"
              initial={reduceMotion ? false : { height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={reduceMotion ? { display: 'none' } : { height: 0, opacity: 0 }}
              transition={{ duration: reduceMotion ? 0.01 : 0.22, ease: EASE }}
            >
              {projectChats.length ? (
                <ul>{projectChats.map((chat) => renderChat(chat, true))}</ul>
              ) : (
                <button
                  type="button"
                  className={cx('rml-project__empty', dropActive && 'is-drop-target')}
                  onClick={() => void newChat(project.id)}
                >
                  Drop a chat here, or start one
                </button>
              )}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </li>
    )
  }

  return (
    <div className={cx('rml-sidebar', collapsed && 'is-collapsed', className)}>
      <div className="rml-sidebar__head">
        <div className="rml-brand">
          <img className="rml-brand__mark" src={rautmlMark} alt="" />
          <span className="rml-brand__word">Rautml</span>
        </div>
        {onCollapsedChange ? (
          <button
            type="button"
            className="rml-sidebar__toggle"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            aria-controls="rautml-conversation-list"
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={() => onCollapsedChange(!collapsed)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3.5" y="4" width="17" height="16" rx="3" />
              <path d="M9 4v16" />
              <path d={collapsed ? 'm14 9 3 3-3 3' : 'm16 9-3 3 3 3'} />
            </svg>
          </button>
        ) : null}
      </div>

      <div className="rml-sidebar__actions">
        <button
          type="button"
          className="rml-newchat"
          onClick={() => void newChat()}
          disabled={onBlankChat}
          title={onBlankChat ? "You're already in a new chat" : 'New chat'}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5.5v13M5.5 12h13" />
          </svg>
          <span>New chat</span>
        </button>
        <button
          type="button"
          className="rml-newproject"
          aria-expanded={projectComposerOpen}
          aria-controls="rautml-new-project"
          onClick={() => setProjectComposerOpen((open) => !open)}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M2.7 5.4h5l1.5 1.7h8.1v7.6a1.6 1.6 0 0 1-1.6 1.6H4.3a1.6 1.6 0 0 1-1.6-1.6V5.4Z" />
            <path d="M10 9.2v4.3M7.85 11.35h4.3" />
          </svg>
          <span>New project</span>
        </button>
        <AnimatePresence initial={false}>
          {projectComposerOpen ? (
            <motion.form
              id="rautml-new-project"
              className="rml-project-composer"
              initial={reduceMotion ? false : { opacity: 0, y: -5, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98 }}
              transition={{ duration: reduceMotion ? 0.01 : 0.2, ease: EASE }}
              onSubmit={handleCreateProject}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setProjectComposerOpen(false)
                  setProjectName('')
                }
              }}
            >
              <input
                ref={projectInputRef}
                value={projectName}
                maxLength={80}
                aria-label="Name project"
                placeholder="Name project"
                onChange={(event) => setProjectName(event.target.value)}
              />
              <button
                type="submit"
                disabled={!projectName.trim() || projectSaving}
                aria-label={projectSaving ? 'Creating project' : 'Create project'}
              >
                {projectSaving ? (
                  <span className="rml-project-composer__spinner" aria-hidden="true" />
                ) : (
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="m3.5 8.2 2.8 2.8 6.2-6.2" />
                  </svg>
                )}
              </button>
            </motion.form>
          ) : null}
        </AnimatePresence>
      </div>

      <nav id="rautml-conversation-list" className="rml-chatlist" aria-label="Conversations">
        {chats.length === 0 && projects.length === 0 && !chatsLoading ? (
          <div className="rml-chatlist__empty">
            <p className="rml-chatlist__empty-title">No conversations yet</p>
            <p className="rml-chatlist__empty-body">
              Start one above — Rautml researches, then builds you something to look at.
            </p>
          </div>
        ) : null}

        {projects.length ? (
          <section className="rml-chatlist__section" aria-labelledby="rautml-projects-label">
            <p id="rautml-projects-label" className="rml-chatlist__label">Projects</p>
            <ul className="rml-project-list">{projects.map(projectGroup)}</ul>
          </section>
        ) : null}

        {unfiledChats.length ? (
          <section
            className={cx(
              'rml-chatlist__section',
              projects.length > 0 && 'rml-chatlist__section--unfiled',
              dropTargetId === 'unfiled' && 'is-drop-target',
            )}
            aria-labelledby="rautml-chats-label"
            onDragEnter={(event) => {
              event.preventDefault()
              setDropTargetId('unfiled')
            }}
            onDragOver={(event) => {
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTargetId(null)
            }}
            onDrop={(event) => dropChat(event, null)}
          >
            <p id="rautml-chats-label" className={cx('rml-chatlist__label', !projects.length && 'rml-sr-only')}>Chats</p>
            <ul>
              <AnimatePresence initial={false} mode="popLayout">
                {unfiledChats.map((chat) => renderChat(chat))}
              </AnimatePresence>
            </ul>
          </section>
        ) : null}

        {draggingChatId && unfiledChats.length === 0 ? (
          <button
            type="button"
            className={cx('rml-unfiled-drop', dropTargetId === 'unfiled' && 'is-drop-target')}
            onDragEnter={(event) => {
              event.preventDefault()
              setDropTargetId('unfiled')
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => dropChat(event, null)}
          >
            Move out of project
          </button>
        ) : null}
      </nav>
      <SettingsButton collapsed={collapsed} />
    </div>
  )
}

export default ChatListSidebar
