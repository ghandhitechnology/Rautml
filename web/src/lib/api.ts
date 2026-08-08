/* Typed fetch wrappers for every route in CONTRACT.md § HTTP API.
 * Dev server proxies /api → http://localhost:5175 (see vite.config.ts). */

import type {
  ApiKeyStatus,
  Chat,
  ChatSnapshot,
  FollowUpAttachment,
  ModelInfo,
  Personalization,
  Project,
  ProviderInfo,
  SettingsPayload,
  Source,
  Thread,
} from './types'

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

/** GET /api/projects → Project[] (newest first) */
export function listProjects(): Promise<Project[]> {
  return request<Project[]>('/projects')
}

/** POST /api/projects → Project */
export function createProject(name: string): Promise<Project> {
  return request<Project>('/projects', { method: 'POST', body: JSON.stringify({ name }) })
}

/** POST /api/chats → Chat */
export function createChat(projectId: string | null = null): Promise<Chat> {
  return request<Chat>('/chats', { method: 'POST', body: JSON.stringify({ projectId }) })
}

/** PATCH /api/chats/:id/project → Chat */
export function moveChatToProject(chatId: string, projectId: string | null): Promise<Chat> {
  return request<Chat>(`/chats/${encodeURIComponent(chatId)}/project`, {
    method: 'PATCH',
    body: JSON.stringify({ projectId }),
  })
}

/** DELETE /api/chats/:id */
export function deleteChat(chatId: string): Promise<void> {
  return request<void>(`/chats/${encodeURIComponent(chatId)}`, { method: 'DELETE' })
}

/** GET /api/chats/:id → full snapshot */
export function getChat(chatId: string): Promise<ChatSnapshot> {
  return request<ChatSnapshot>(`/chats/${encodeURIComponent(chatId)}`)
}

/** POST /api/chats/:id/retitle → refreshes the title with GPT-5.6 Luna. */
export function retitleChat(
  chatId: string,
  keepalive = false,
): Promise<{ title: string; changed: boolean }> {
  return request<{ title: string; changed: boolean }>(
    `/chats/${encodeURIComponent(chatId)}/retitle`,
    { method: 'POST', keepalive },
  )
}

/** GET /api/models → the selectable model catalog */
export function listModels(refresh = false): Promise<{ models: ModelInfo[]; providers: ProviderInfo[]; defaultModelId: string }> {
  return request<{ models: ModelInfo[]; providers: ProviderInfo[]; defaultModelId: string }>(`/models${refresh ? '?refresh=1' : ''}`)
}

export function reconnectProvider(providerId: string): Promise<{ launched: boolean; command: string }> {
  return request(`/providers/${encodeURIComponent(providerId)}/reconnect`, { method: 'POST', body: JSON.stringify({}) })
}

/** POST /api/chats/:id/messages → { runId } (throws ApiError 409 if a run is active) */
export function sendMessage(
  chatId: string,
  content: string,
  thread: Thread,
  selection?: { model?: string; effort?: string; elaboration?: string },
  attachments?: FollowUpAttachment[],
  sourceIds?: string[],
): Promise<{ runId: string }> {
  return request<{ runId: string }>(`/chats/${encodeURIComponent(chatId)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content, thread, ...selection, attachments, sourceIds }),
  })
}

/* ----------------------------------------------------------------- settings */

/** GET /api/settings → API key status (masked) + personalization */
export function getSettings(): Promise<SettingsPayload> {
  return request<SettingsPayload>('/settings')
}

/** PUT /api/settings/keys — an empty value clears that key. Takes effect on the
 *  running engine immediately; no restart. */
export function saveApiKeys(patch: Record<string, string>): Promise<{ keys: ApiKeyStatus[] }> {
  return request<{ keys: ApiKeyStatus[] }>('/settings/keys', {
    method: 'PUT',
    body: JSON.stringify(patch),
  })
}

/** PUT /api/settings/personalization — omitted fields are left untouched. */
export function savePersonalization(
  patch: Partial<Personalization>,
): Promise<{ personalization: Personalization }> {
  return request<{ personalization: Personalization }>('/settings/personalization', {
    method: 'PUT',
    body: JSON.stringify(patch),
  })
}

/* ------------------------------------------------------------ local sources */

export interface UploadSourcesResult {
  sources: Source[]
  rejected: { name: string; error: string }[]
}

/**
 * POST /api/chats/:id/sources — multipart upload into the chat's local
 * sources. XHR instead of fetch so a 300MB file can report progress.
 */
export function uploadSources(
  chatId: string,
  files: File[],
  onProgress?: (fraction: number) => void,
): Promise<UploadSourcesResult> {
  return new Promise((resolve, reject) => {
    const form = new FormData()
    for (const file of files) form.append('files', file, file.name)

    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${API_BASE}/chats/${encodeURIComponent(chatId)}/sources`)
    xhr.responseType = 'json'
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total)
      }
    }
    xhr.onload = () => {
      const body = xhr.response as unknown
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as UploadSourcesResult)
      } else {
        const message =
          (body && typeof body === 'object' && typeof (body as any).error === 'string'
            ? (body as any).error
            : '') || `Upload failed (${xhr.status})`
        reject(new ApiError(xhr.status, message, body))
      }
    }
    xhr.onerror = () => reject(new ApiError(0, 'Cannot reach the server.'))
    xhr.onabort = () => reject(new ApiError(0, 'Upload cancelled.'))
    xhr.send(form)
  })
}

/** GET /api/chats/:id/sources → Source[] */
export function listSources(chatId: string): Promise<Source[]> {
  return request<Source[]>(`/chats/${encodeURIComponent(chatId)}/sources`)
}

/** DELETE /api/sources/:sourceId */
export function deleteSource(sourceId: string): Promise<void> {
  return request<void>(`/sources/${encodeURIComponent(sourceId)}`, { method: 'DELETE' })
}

/** Download URL for a source's raw file. */
export function sourceFileUrl(sourceId: string): string {
  return `${API_BASE}/sources/${encodeURIComponent(sourceId)}/file`
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

/** Convenience: fetch an asset version's raw HTML (for download / srcdoc). */
export async function fetchAssetHtml(
  assetId: string,
  version: number | 'latest' = 'latest',
): Promise<string> {
  const res = await fetch(assetUrl(assetId, version))
  if (!res.ok) throw new ApiError(res.status, `Failed to load asset (${res.status})`)
  return res.text()
}
