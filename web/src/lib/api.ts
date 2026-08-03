/* Typed fetch wrappers for every route in CONTRACT.md § HTTP API.
 * Dev server proxies /api → http://localhost:5175 (see vite.config.ts). */

import type { Chat, ChatSnapshot, ModelInfo, Thread } from './types'

export const API_BASE = '/api'

export class ApiError extends Error {
  readonly status: number
  readonly body: unknown
  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
  /** A run is already active on that thread (POST /messages). */
  get isConflict(): boolean {
    return this.status === 409
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
      ...init,
    })
  } catch (err) {
    throw new ApiError(0, err instanceof Error ? err.message : 'Network error')
  }

  const text = await res.text()
  let body: unknown = undefined
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }

  if (!res.ok) {
    const message =
      (body && typeof body === 'object' && 'error' in body && typeof (body as any).error === 'string'
        ? (body as any).error
        : typeof body === 'string' && body
          ? body
          : res.statusText) || `Request failed (${res.status})`
    throw new ApiError(res.status, message, body)
  }

  return body as T
}

/** GET /api/chats → Chat[] (desc by updatedAt) */
export function listChats(): Promise<Chat[]> {
  return request<Chat[]>('/chats')
}

/** POST /api/chats → Chat */
export function createChat(): Promise<Chat> {
  return request<Chat>('/chats', { method: 'POST', body: JSON.stringify({}) })
}

/** DELETE /api/chats/:id */
export function deleteChat(chatId: string): Promise<void> {
  return request<void>(`/chats/${encodeURIComponent(chatId)}`, { method: 'DELETE' })
}

/** GET /api/chats/:id → full snapshot */
export function getChat(chatId: string): Promise<ChatSnapshot> {
  return request<ChatSnapshot>(`/chats/${encodeURIComponent(chatId)}`)
}

/** GET /api/models → the selectable model catalog */
export function listModels(): Promise<{ models: ModelInfo[]; defaultModelId: string }> {
  return request<{ models: ModelInfo[]; defaultModelId: string }>('/models')
}

/** POST /api/chats/:id/messages → { runId } (throws ApiError 409 if a run is active) */
export function sendMessage(
  chatId: string,
  content: string,
  thread: Thread,
  selection?: { model?: string; effort?: string },
): Promise<{ runId: string }> {
  return request<{ runId: string }>(`/chats/${encodeURIComponent(chatId)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content, thread, ...selection }),
  })
}

/** POST /api/chats/:id/input → resumes a parked run */
export function resolveInput(
  chatId: string,
  pendingInputId: string,
  value: string,
): Promise<void> {
  return request<void>(`/chats/${encodeURIComponent(chatId)}/input`, {
    method: 'POST',
    body: JSON.stringify({ pendingInputId, value }),
  })
}

/** POST /api/chats/:id/stop → stops active run(s) */
export function stopRun(chatId: string): Promise<void> {
  return request<void>(`/chats/${encodeURIComponent(chatId)}/stop`, { method: 'POST' })
}

/** URL of a rendered asset version: GET /api/assets/:assetId/:version */
export function assetUrl(assetId: string, version: number | 'latest' = 'latest'): string {
  return `${API_BASE}/assets/${encodeURIComponent(assetId)}/${version}`
}

/** SSE endpoint for a chat, resuming after `afterSeq`. */
export function eventsUrl(chatId: string, afterSeq = 0): string {
  return `${API_BASE}/chats/${encodeURIComponent(chatId)}/events?after=${afterSeq}`
}

/** Convenience: fetch an asset version's raw HTML (for copy-html / srcdoc). */
export async function fetchAssetHtml(
  assetId: string,
  version: number | 'latest' = 'latest',
): Promise<string> {
  const res = await fetch(assetUrl(assetId, version))
  if (!res.ok) throw new ApiError(res.status, `Failed to load asset (${res.status})`)
  return res.text()
}
