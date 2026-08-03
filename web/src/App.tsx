import { useCallback, useEffect, useRef } from 'react'
import { Composer, Layout, Welcome } from './components/shell'
import { ChatThread } from './components/chat'
import { AssetCard } from './components/asset'
import { DocumentDock, DocumentView } from './components/document'
import { ForkBall, ForkPanel } from './components/fork'
import {
  useActiveChatId,
  useAsset,
  useAssetIdsForMessage,
  useChats,
  useDocumentMode,
  useStore,
} from './state/store'
import './App.css'

/**
 * Shell composition. Feature agents mount into the marked slots:
 *   [data-slot="chat-thread"]  → components/chat  (ChatThread: bubbles, timeline, assets, chips)
 *   [data-slot="document"]     → components/document (DocumentView: the asset takeover)
 *   [data-slot="fork"]         → components/fork  (ForkPanel)
 *   [data-slot="fork-ball"]    → components/fork  (ForkBall, floating over the main column)
 *
 * Two modes for the main column:
 *   • no assets yet → the conversation, docked composer, unchanged.
 *   • ≥1 asset      → document takeover: the newest asset fills the column, the conversation
 *     becomes an overlay you pull back over it, and the composer floats on top of the page.
 *
 * ChatThread never imports components/asset itself (ownership boundary) — it exposes
 * `renderAssets(messageId)` and the assembler (this file) bridges to AssetCard.
 */

function AssetForId({ assetId }: { assetId: string }) {
  const asset = useAsset(assetId)
  if (!asset) return null
  return <AssetCard asset={asset} />
}

function AssetsForMessage({ messageId }: { messageId: string }) {
  const assetIds = useAssetIdsForMessage(messageId)
  if (!assetIds.length) return null
  return (
    <>
      {assetIds.map((id) => (
        <AssetForId key={id} assetId={id} />
      ))}
    </>
  )
}

export default function App() {
  const chats = useChats()
  const activeChatId = useActiveChatId()
  const documentMode = useDocumentMode()
  const loadChats = useStore((s) => s.loadChats)
  const loadModels = useStore((s) => s.loadModels)
  const openChat = useStore((s) => s.openChat)
  const newChat = useStore((s) => s.newChat)
  const sendMessage = useStore((s) => s.sendMessage)
  const autoOpened = useRef(false)

  useEffect(() => {
    void loadChats()
    void loadModels()
  }, [loadChats, loadModels])

  // Land in the most recent conversation on first load.
  useEffect(() => {
    if (autoOpened.current || activeChatId || chats.length === 0) return
    autoOpened.current = true
    void openChat(chats[0]!.id)
  }, [chats, activeChatId, openChat])

  // With no chat open, the first message creates one and sends into it.
  const sendIntoNewChat = useCallback(
    async (content: string) => {
      const chat = await newChat()
      if (!chat) return
      await sendMessage('main', content)
    },
    [newChat, sendMessage],
  )

  return (
    <Layout
      documentMode={documentMode}
      composer={
        documentMode ? (
          <DocumentDock />
        ) : activeChatId ? (
          <Composer thread="main" autoFocus />
        ) : (
          <Composer thread="main" autoFocus onSend={sendIntoNewChat} running={false} />
        )
      }
      floating={
        <div data-slot="fork-ball" className="rml-slot rml-slot--ball">
          <ForkBall />
        </div>
      }
      fork={
        <div data-slot="fork" className="rml-slot rml-slot--fork">
          <ForkPanel />
        </div>
      }
    >
      {documentMode ? (
        <div data-slot="document" className="rml-slot rml-slot--document">
          <DocumentView key={activeChatId ?? 'none'} />
        </div>
      ) : (
        <div data-slot="chat-thread" className="rml-slot rml-slot--thread">
          {activeChatId ? (
            <ChatThread renderAssets={(messageId) => <AssetsForMessage messageId={messageId} />} />
          ) : (
            <Welcome />
          )}
        </div>
      )}
    </Layout>
  )
}
