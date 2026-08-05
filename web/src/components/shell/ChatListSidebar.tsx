import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useActiveChatId, useChats, useOnBlankChat, useStore } from '../../state/store'
import { absoluteTime, cx, relativeTime } from '../../lib/utils'
import { EASE } from '../../lib/motion'
import TypewriterText from './TypewriterText'
import ProviderBar from './ProviderBar'
import rautmlMark from '../../assets/rautml-mark.png'
import './ChatListSidebar.css'

export interface ChatListSidebarProps {
  className?: string
  /** Desktop compact-rail state. Mobile always renders the full drawer. */
  collapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
}

export function ChatListSidebar({
  className,
  collapsed = false,
  onCollapsedChange,
}: ChatListSidebarProps) {
  const chats = useChats()
  const reduceMotion = useReducedMotion()
  const activeChatId = useActiveChatId()
  const chatsLoading = useStore((s) => s.chatsLoading)
  const openChat = useStore((s) => s.openChat)
  const newChat = useStore((s) => s.newChat)
  const removeChat = useStore((s) => s.removeChat)
  // A blank chat is already open — creating another would just stack empty rows.
  const onBlankChat = useOnBlankChat()

  const [armedId, setArmedId] = useState<string | null>(null)
  const [, setTick] = useState(0)
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // keep relative timestamps honest without a per-item timer
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => () => {
    if (disarmTimer.current) clearTimeout(disarmTimer.current)
  }, [])

  const arm = (chatId: string) => {
    setArmedId(chatId)
    if (disarmTimer.current) clearTimeout(disarmTimer.current)
    disarmTimer.current = setTimeout(() => setArmedId(null), 3200)
  }

  const handleDelete = (e: MouseEvent, chatId: string) => {
    e.stopPropagation()
    e.preventDefault()
    if (armedId !== chatId) {
      arm(chatId)
      return
    }
    setArmedId(null)
    void removeChat(chatId)
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

      <nav id="rautml-conversation-list" className="rml-chatlist" aria-label="Conversations">
        {chats.length === 0 && !chatsLoading ? (
          <div className="rml-chatlist__empty">
            <p className="rml-chatlist__empty-title">No conversations yet</p>
            <p className="rml-chatlist__empty-body">
              Start one above — Rautml researches, then builds you something to look at.
            </p>
          </div>
        ) : null}

        <ul>
          <AnimatePresence initial={false} mode="popLayout">
            {chats.map((chat) => {
              const active = chat.id === activeChatId
              const armed = armedId === chat.id
              return (
                <motion.li
                  key={chat.id}
                  layout={reduceMotion ? false : 'position'}
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0, scale: 1, clipPath: 'inset(0% 0% 0% 0%)' }}
                  exit={
                    reduceMotion
                      ? { opacity: 0 }
                      : {
                          opacity: 0,
                          y: -14,
                          scale: 0.98,
                          clipPath: 'inset(0% 0% 100% 0%)',
                        }
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
                >
                  <div
                    className={cx('rml-chatrow', active && 'is-active', armed && 'is-armed')}
                    role="button"
                    tabIndex={0}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => void openChat(chat.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        void openChat(chat.id)
                      }
                    }}
                  >
                    <span className="rml-chatrow__body">
                      <span className="rml-chatrow__title">
                        <TypewriterText text={chat.title || 'New chat'} />
                      </span>
                      <span className="rml-chatrow__time" title={absoluteTime(chat.updatedAt)}>
                        {relativeTime(chat.updatedAt)}
                      </span>
                    </span>

                    <button
                      type="button"
                      className={cx('rml-chatrow__delete', armed && 'is-armed')}
                      onClick={(e) => handleDelete(e, chat.id)}
                      onBlur={() => armed && setArmedId(null)}
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
            })}
          </AnimatePresence>
        </ul>
      </nav>
      <ProviderBar />
    </div>
  )
}

export default ChatListSidebar
