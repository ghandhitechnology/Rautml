# Rautml — Build Contract

Single source of truth for all agents. Do not deviate from names/shapes defined here.
Product: chat UI where GPT-5.6-sol researches and generates rich HTML "assets" inline,
with a forked Q&A sidebar ("ball"), live activity timeline, versioned in-place asset edits.

## Repo layout

```
Rautml/
  package.json            # npm workspaces: server, web. scripts: dev (concurrently), dev:server, dev:web
  .env                    # OPENROUTER_API_KEY, FIRECRAWL_API_KEY (gitignored, already created)
  server/                 # Express + TS + node:sqlite built-in (port 5175)
    src/index.ts          # bootstrap: dotenv, db init, routes, listen
    src/db.ts             # schema DDL + migration on boot
    src/repo.ts           # typed persistence layer (all SQL lives here)
    src/types.ts          # shared server types (mirror of web/src/lib/types.ts)
    src/sse.ts            # SSE hub: subscribe(chatId, res), publish(chatId, event) + persistence to tool_events
    src/agent/openrouter.ts  # chat.completions call w/ streaming, retry/backoff on 429/5xx
    src/agent/engine.ts   # agentic run loop (see Engine)
    src/agent/prompts.ts  # system prompt + DESIGN_README (visualize_read_me content)
    src/tools/index.ts    # ToolDef registry: { name, description, parameters(JSONSchema), execute(args, ctx) }
    src/tools/research.ts # web_search, image_search, web_fetch (Firecrawl)
    src/tools/workspace.ts# bash_tool, create_file, str_replace, view, present_files
    src/tools/ux.ts       # visualize_read_me, visualize_show_widget, ask_user_input_v0
    src/tools/sources.ts  # list_sources, search_sources, read_source (local sources)
    src/sources/extract.ts   # per-type text extraction (pdf/csv/docx/pptx/md/tex/hwp/hwpx)
    src/sources/embeddings.ts# local transformers.js embeddings (multilingual-e5-small, q8)
    src/sources/indexer.ts   # chunking + background index queue + semantic search
    src/routes/api.ts     # all HTTP routes
    data/                 # rautml.db, workspaces/<chatId>/, sources/<chatId>/<sourceId>/ (gitignored)
  web/                    # Vite + React 18 + TS (port 5174, proxies /api → 5175)
    src/main.tsx
    src/App.tsx           # layout: ChatListSidebar | ChatView | ForkPanel
    src/theme/tokens.css  # design tokens (below), light/dark via [data-theme]
    src/theme/fonts.css   # Pretendard Variable + Lora
    src/lib/types.ts      # shared types (mirror of server/src/types.ts)
    src/lib/api.ts        # fetch wrappers for routes below
    src/lib/sse.ts        # EventSource client w/ auto-reconnect + ?after=seq replay
    src/state/store.ts    # zustand store: chats, messages, events, assets, forkOpen, theme
    src/components/shell/   # ChatListSidebar, Composer, ThemeToggle, Layout
    src/components/chat/    # MessageBubble, Markdown, ActivityTimeline, InputChips, FileCard, WidgetCard
    src/components/asset/   # AssetCard, AssetFrame (iframe), VersionPicker
    src/components/fork/    # ForkBall, ForkPanel, ForkThread
```

Ownership boundaries (parallel agents MUST stay in their dirs; App.tsx wiring is done by the assembler):
shell→components/shell+theme+state+lib, chat→components/chat, asset→components/asset, fork→components/fork.

## Environment

- `OPENROUTER_API_KEY`, `FIRECRAWL_API_KEY` in `/Users/pyu/projects/hobbies/Rautml/.env` (already present).
- Optional overrides: `PORT` (server, default 5175), `WEB_PORT` / `API_PORT` (vite dev + its /api proxy),
  `OPENROUTER_BASE_URL` and `CODEX_RESPONSES_URL` (point a provider at a proxy or a local mock). These let a
  second checkout — or a test harness driving the app against a fake provider — run without port conflicts.
- Default model: `openai/gpt-5.6-sol` via `https://openrouter.ai/api/v1/chat/completions`. Tool calling: OpenAI format, `tool_choice: "auto"`, streaming SSE.
- **Provider dispatch** (src/agent/llm.ts): when Codex CLI OAuth credentials exist (`~/.codex/auth.json`, via
  `codex login`), `openai/*` models run on the user's ChatGPT subscription through the Codex backend
  (`https://chatgpt.com/backend-api/codex/responses`, Responses API, SSE-only; src/agent/codex.ts translates
  to/from the chat.completions shapes so callers can't tell providers apart). Wire ids drop the `openai/`
  prefix (`gpt-5.6-sol`). `max_output_tokens`/`temperature` are unsupported there and omitted; reasoning
  efforts none…max pass through. Tokens auto-refresh via `auth.openai.com` and are written back to auth.json.
  All other models — and everything when auth is absent or `RAUTML_CODEX=0` — stay on OpenRouter.
- Selectable models (server/src/agent/models.ts owns the catalog; efforts are the provider's own
  `reasoning_effort` values, sent as OpenRouter `reasoning: { effort }`):
  - `openai/gpt-5.6-sol` / `-terra` / `-luna` — none | low | medium | high | xhigh | max (default medium)
  - `x-ai/grok-4.5` — low | medium | high (default high)
  - `deepseek/deepseek-v4-flash-0731` — low | high | max (default high)
- Firecrawl: `https://api.firecrawl.dev/v1/search` (web + images sources), `https://api.firecrawl.dev/v1/scrape` (formats:["markdown"]).

## Database (SQLite via built-in `node:sqlite` `DatabaseSync` — NOT better-sqlite3; Node 26, WAL)

```sql
chats(id TEXT PK, title TEXT, created_at INTEGER, updated_at INTEGER);
-- thread: 'main' | 'fork'
messages(id TEXT PK, chat_id TEXT, thread TEXT, role TEXT, content TEXT,
         status TEXT DEFAULT 'complete',  -- 'streaming'|'complete'|'error'
         run_id TEXT, attachments TEXT, created_at INTEGER); -- optional JSON FollowUpAttachment[]
-- canonical model-side transcript for context rebuilding (incl. tool calls/results), per thread
model_turns(id INTEGER PK AUTOINCREMENT, chat_id TEXT, thread TEXT, seq INTEGER, json TEXT);
runs(id TEXT PK, chat_id TEXT, thread TEXT,
     status TEXT,  -- 'running'|'awaiting_input'|'done'|'error'|'stopped'
     error TEXT, created_at INTEGER, finished_at INTEGER,
     model TEXT, effort TEXT, elaboration TEXT);  -- selection the run was started with (resume reuses it)
-- every SSE event persisted here; seq monotonic per chat (for replay)
tool_events(id INTEGER PK AUTOINCREMENT, chat_id TEXT, run_id TEXT, seq INTEGER,
            type TEXT, payload TEXT, created_at INTEGER);
assets(id TEXT PK, chat_id TEXT, message_id TEXT, title TEXT, rel_path TEXT, created_at INTEGER);
asset_versions(id TEXT PK, asset_id TEXT, version INTEGER, html TEXT, created_at INTEGER);
pending_inputs(id TEXT PK, run_id TEXT, chat_id TEXT, thread TEXT, payload TEXT, resolved INTEGER DEFAULT 0);
-- local sources: user uploads, stored permanently per chat. messages also
-- carry source_ids TEXT (JSON array) for files sent with that message.
sources(id TEXT PK, chat_id TEXT, name TEXT, ext TEXT, mime TEXT, size INTEGER,
        status TEXT DEFAULT 'processing',  -- 'processing'|'ready'|'error'
        error TEXT, text_chars INTEGER DEFAULT 0, chunk_count INTEGER DEFAULT 0, created_at INTEGER);
-- semantic-search chunks; embedding = normalized Float32Array bytes,
-- NULL when the embedding model was unavailable (lexical fallback applies)
source_chunks(id INTEGER PK AUTOINCREMENT, source_id TEXT, chat_id TEXT, seq INTEGER,
              start_off INTEGER, end_off INTEGER, text TEXT, embedding BLOB);
```

## HTTP API (all JSON under /api)

- `GET  /api/chats` → `Chat[]` (desc by updated_at)
- `POST /api/chats` `{}` → `Chat` (title "New chat"; auto-titled after first exchange)
- `DELETE /api/chats/:id`
- `GET  /api/chats/:id` → `{ chat, messages, assets: AssetWithVersions[], events: ChatEvent[], pendingInput: PendingInput|null, activeRun: Run|null }`
- `POST /api/chats/:id/retitle` → `{ title: string, changed: boolean }` (GPT-5.6 Luna at effort `none`; invoked when leaving a chat that changed since its initial title)
- `POST /api/chats/:id/messages` `{ content: string, thread: 'main'|'fork', model?: string, effort?: string, elaboration?: 'undergraduate'|'bachelors'|'doctor', attachments?: FollowUpAttachment[] }` → `{ runId }` (attachments are supported on the fork thread; 409 if a run is active; 400 on invalid selections)
- `GET  /api/models` → `{ models: ModelInfo[], defaultModelId: string }` (the selectable catalog)
- `POST /api/chats/:id/input` `{ pendingInputId, value: string }` → resumes paused run
- `POST /api/chats/:id/stop` → stops active run(s)
- `GET  /api/chats/:id/events?after=<seq>` → SSE stream (replays persisted events with seq > after, then live)
- `GET  /api/assets/:assetId/:version` → `text/html` (the version's html; version 'latest' allowed)
- `POST /api/chats/:id/sources` → multipart (`files` field) upload into the chat's local sources.
  400MB per file, unlimited files per request/chat. Allowed: pdf csv docx pptx md markdown tex hwp hwpx.
  Returns `{ sources: Source[], rejected: [{name, error}] }`; indexing runs in the background
  (source.updated fires when a file turns ready/error). Restart-safe: 'processing' rows re-queue on boot.
- `GET  /api/chats/:id/sources` → `Source[]`
- `GET  /api/sources/:sourceId/file` → raw file download
- `DELETE /api/sources/:sourceId` → removes the file, its chunks and its disk dir; emits source.removed

`POST /api/chats/:id/messages` also accepts `sourceIds?: string[]` (must belong to the chat) — the
files uploaded with that message. They are listed in the model turn as an `<attached_files>` block and
stored on the message row; `GET /api/chats/:id` includes `sources: Source[]` in the snapshot.

## SSE events (ChatEvent)

`{ seq: number, chatId: string, thread: 'main'|'fork', type: string, data: any }`
Types (data shape):
- `run.status` `{ runId, status }`
- `run.phase` `{ runId, phase, label }` — what the run is doing between visible events.
  phase is `connecting|thinking|responding|tools`; label is the timeline header line
  (`Thinking…`, or a streamed reasoning headline like `Planning the search`). Emitted before the
  provider request leaves, so the UI is never blank while the model reasons. Throttled to ≥700ms.
- `message.start` `{ messageId, role }`
- `message.delta` `{ messageId, text }` — append text
- `message.complete` `{ messageId, content }`
- `tool.start` `{ toolCallId, name, label }`  — label is human text, e.g. `Searching: “hormone cycles”`
- `tool.end` `{ toolCallId, name, ok, summary }` — e.g. `8 results` / error text
- `thinking.start` `{ thinkingId }` — the model round paused before visible output (first reasoning delta, or 1s of silence)
- `thinking.delta` `{ thinkingId, text }` — reasoning trace chunk, only from models that stream one
- `thinking.end` `{ thinkingId, ms }` — pause finished at first visible output (or round end); `ms` is authoritative
- `asset.created` `{ asset: Asset, version: 1 }`
- `asset.version` `{ assetId, version }`
- `widget` `{ messageId, html }` — visualize_show_widget payload
- `files.presented` `{ messageId, files: [{name, relPath, size}] }`
- `input.request` `{ pendingInputId, question, options: string[] }`
- `input.resolved` `{ pendingInputId, value }`
- `chat.title` `{ title }`
- `source.added` `{ source: Source }` — a file landed in the chat's local sources (upload accepted)
- `source.updated` `{ source: Source }` — indexing finished: status flipped to 'ready' or 'error'
- `source.removed` `{ sourceId }`
- `subagent.start` `{ subagentId, parentToolCallId, title, model }` — a research subagent spawned by `spawn_subagents`
- `subagent.delta` `{ subagentId, text }` — the subagent's own streamed text
- `subagent.tool.start` `{ subagentId, toolCallId, name, label }`
- `subagent.tool.end` `{ subagentId, toolCallId, name, ok, summary }`
- `subagent.end` `{ subagentId, ok, summary }` — e.g. `6 steps · 2,140 chars` / error text

## Engine (server/src/agent/engine.ts)

- `startRun(chatId, thread, userContent)`: persist user message + model_turn, create run, then loop
  detached from any HTTP response (fire-and-forget promise; survives client disconnect — SSE replay covers reload).
- Context: main thread → all main model_turns. Fork thread → **main** model_turns up to the fork run's
  `context_seq` watermark + all **fork** model_turns. The watermark is captured at run creation: the last
  fully generated main state — with a main run live, its half-finished turns never leak into a fork's context
  (runs.context_seq; main runs record their own pre-run watermark for forks to snapshot).
  (fork system preamble: "You are answering focused questions about the conversation and its generated assets;
  be concise; do not create or edit assets — direct the user to the main chat for changes.").
- Loop: call OpenRouter (stream). Stream text → message.delta. Tool calls → emit a provisional tool.start
  the moment the call appears in the stream (before its arguments finish arriving), then re-emit tool.start
  with the full label at execution, execute via registry, emit tool.end, append tool result turn, continue.
  Cap: 120 tool calls per run (env `RAUTML_MAX_TOOL_CALLS`) → inject a final "wrap up now" user-role nudge;
  the iteration safety valve also forces a wrap-up round so a run always ends with a visible answer.
  Retries: 3x exponential backoff on 429/5xx/network; a stream that stalls >120s or ends without a
  finish_reason counts as a network failure (not a finished answer). A retry closes any provisionally
  announced tool rows ("Connection dropped — retrying").
- Run phase: every iteration emits `run.phase` — `connecting` before the request leaves, `thinking`
  once the provider accepts it, then a reasoning headline as reasoning streams (both providers surface
  reasoning deltas; Codex requests `reasoning.summary: auto` and falls back once if the backend rejects
  it), `responding` on the first visible token, `tools` while tool calls execute. This is what fills the
  minute-long reasoning window that otherwise reaches the client as silence.
- Thinking rows: per streamChat round, the pause before visible output is measured from dispatch;
  `thinking.start` fires lazily (first reasoning delta or 1s of silence — faster rounds emit nothing) and the
  first text/tool call closes it with `thinking.end`, whose `ms` is authoritative. Subagents are out of scope.
- Tool result truncation: any tool result > 24k chars → truncate middle with `[…truncated…]`.
- `ask_user_input_v0`: persist pending_input, emit input.request, set run status awaiting_input, **park** the
  loop (persist current turn state via model_turns; the resume endpoint re-enters the loop with the answer as
  the tool result). Survives server restart because everything is in DB.
- Auto-title: after the first main exchange completes, one cheap non-streamed GPT-5.6 Luna call at effort
  `none` ("title this chat in ≤5 words, language of the user") → update chats.title, emit chat.title.
- Exit retitle: after any later successful interaction, leaving or switching the chat triggers one serialized
  Luna/`none` refresh over a bounded conversation sample. Navigation never waits; changed titles update
  `chats.title` and emit `chat.title`.
- Errors: run.status error + message.complete with friendly text; never leave status 'streaming'.

## Tools (names/schemas exact; registry order = this order)

1. `web_search {query: string}` → Firecrawl search, top 8: `title, url, snippet`
2. `web_fetch {url: string}` → Firecrawl scrape → markdown (fallback: raw fetch, html→text)
3. `image_search {query: string}` → Firecrawl search images source, top 8: `title, imageUrl, sourceUrl`
4. `bash_tool {command: string}` → exec in workspace cwd, 60s timeout, stdout+stderr capped 50k chars
5. `create_file {path: string, content: string}` → write within workspace (reject `..` escapes)
6. `str_replace {path: string, old_str: string, new_str: string}` → old_str must match exactly once
7. `view {path: string, start_line?: number, end_line?: number}` → file text w/ line numbers, or dir listing; images → "[binary image: <path>]"
8. `present_files {paths: string[], title?: string}` → emit files.presented (download cards)
9. `visualize_read_me {}` → returns DESIGN_README string (design constraints; model MUST call before first asset)
10. `visualize_show_widget {html: string}` → emit widget event (inline SVG/HTML mini-visual in chat flow)
11. `ask_user_input_v0 {question: string, options: string[]}` → pauses run; returns chosen value on resume
12. `spawn_subagents {tasks: [{title: string, prompt: string, model?: string}]}` → fans research out to 2–5
    parallel subagents (src/tools/subagents.ts). Each task becomes an independent mini agentic loop with its own
    OpenRouter stream and tool calling over the research tools only (`web_search`, `web_fetch`, `image_search`);
    lifecycle/activity surface as the `subagent.*` SSE events. Allowed models: `x-ai/grok-4.5` (default, at its
    default effort `high`) and `openai/gpt-5.6-luna` (at effort `xhigh`). Budgets: 12 tool calls per subagent, tool results
    truncated at 12k inside the subagent, reports capped at `max(4k, 22k/n)` each. The tool result is the combined
    reports (`N/M subagents reported.` first line + one `## [i] title` section each). Subagents cannot spawn
    subagents, write files, or ask the user; a failed subagent yields an error note, not a failed batch.
13. `list_sources {}` → inventory of the chat's local sources (name, type, size, index state, id)
14. `search_sources {query: string, top_k?: number}` → semantic top-k (default 8, max 20) passages across
    every uploaded file, with file name + char offsets. Embeddings: local transformers.js
    `Xenova/multilingual-e5-small` (q8, KO/EN-capable, lazy-downloaded, `RAUTML_EMBED_MODEL` overrides);
    keyword fallback when the model is unavailable, so search always answers.
15. `read_source {name: string, offset?: number, length?: number}` → a slice of a file's extracted text
    (default 6k chars, max 20k; name accepts the id or a unique filename prefix)

Workspace = `server/data/workspaces/<chatId>/`, created on chat creation.

### Local sources (uploads)

- Composer: paperclip + drag-drop, unlimited files, staged as chips; uploads land in local sources
  immediately and ride the next main-thread send as `sourceIds`. Files persist for the life of the chat —
  agents reach any upload, however old, through tools 13–15.
- Storage: `server/data/sources/<chatId>/<sourceId>/<original name>` + `extracted.txt` (the parsed text).
  Extraction caps: 8M chars per file (48MB read for plain-text types); indexing embeds the first 1.5M chars
  (`RAUTML_INDEX_CHAR_CAP`), chunked at ~1200 chars with 150 overlap.
- Top bar: a "Local sources" text button (count badge) in the shell topbar and in the document header
  immediately left of the copy icon — panel lists every upload with status (Indexing…/searchable/failed),
  download and delete.

### Asset protocol (the critical convention)

- An asset is an HTML file the model writes to `assets/<slug>.html` inside its workspace via `create_file`.
- Server intercepts `create_file`/`str_replace` on paths matching `assets/*.html`:
  - `create_file` → register asset (title from `<title>` tag else slug), store html as version 1, emit `asset.created`. The assistant message the model is currently producing gets the asset attached (message_id).
  - `str_replace` → store as next version, emit `asset.version`.
- Frontend renders assets from `/api/assets/:id/:version` — html is stored in DB (asset_versions.html), file on disk is the model's working copy.

## System prompt essence (prompts.ts owns the wording)

The model: is "Rautml", researches thoroughly (web_search/web_fetch/image_search) before building; divides
research bigger than a medium-large task across parallel subagents via spawn_subagents (2–5 self-contained
briefs, early, then verifies and synthesizes; Grok 4.5 default, Luna for lighter briefs); confirms
scope in one short message for large requests then proceeds (no endless clarification); calls visualize_read_me
before its first asset; writes complete self-contained HTML (inline CSS/JS, no external JS frameworks; Google
Fonts + image hotlinks allowed); edits existing assets with str_replace (never regenerates whole file for small
changes); replies in the user's language (Korean ↔ English); uses markdown + $…$/$$…$$ LaTeX in chat text.

DESIGN_README (returned by visualize_read_me): concrete visual constraints for impeccable assets — typographic
scale, spacing rhythm, color discipline (max 2 accent hues), generous whitespace, section rhythm, responsive,
`prefers-color-scheme` support, Korean font stack (`Pretendard, -apple-system, "Noto Sans KR", sans-serif`
via CDN allowed), buttery CSS transitions, no lorem ipsum, real researched content only, cite sources in a
footer. prompts.ts authors the full text (~60 lines).

## Design tokens (web/src/theme/tokens.css) — Anthropic-inspired

Light: `--bg:#faf9f5; --surface:#ffffff; --surface-2:#f0eee6; --text:#1f1e1d; --text-muted:#73726c;
--border:#e8e6dc; --accent:#d97757; --accent-hover:#c96442; --accent-soft:#f5e5dd;`
Dark:  `--bg:#262624; --surface:#30302e; --surface-2:#3a3a37; --text:#f5f4ee; --text-muted:#a8a69e;
--border:#3f3e3a; --accent:#d97757; --accent-hover:#e08b6f; --accent-soft:#453733;`
Radius: `--r-sm:8px; --r-md:12px; --r-lg:16px`. Shadow: soft, low-alpha.
Fonts: UI `"Pretendard Variable", Pretendard, -apple-system, sans-serif` (npm `pretendard`, variable woff2);
display serif for headings/brand: `"Lora", Georgia, serif` (self-hosted or @fontsource/lora).
Theme: `[data-theme="light"|"dark"]` on `<html>`, default from `prefers-color-scheme`, toggle persisted to localStorage.
Motion: framer-motion; standard easing `[0.22, 1, 0.36, 1]`; durations 200–450ms; 60fps (transform/opacity only).

## Frontend behaviors

- **ActivityTimeline**: during a run, a collapsible strip under the streaming message lists tool.start/tool.end
  lines live (icon + label + status). Collapses to "Worked for Xs · N steps" summary on completion; click re-expands.
  Subagents render as nested groups under their spawn_subagents row (left rail, title + model pill + status), each
  with its own tool rows and streamed-text preview; a group is open while its subagent runs and collapses to one
  line when it reports (click toggles). Subagent steps count toward the strip's step total.
  Thinking rows interleave with tool rows: live they read "Thinking · Xs", finalized "Thought for Xs", and
  expand to show the reasoning trace when the model streamed one.
- **AssetCard**: appears in flow at its message position. Expand-from-message animation (scale/opacity from the
  user's request bubble feel). Contains AssetFrame: `<iframe srcdoc>` **no sandbox attr** (full JS by design),
  style-isolated by nature of iframe; auto-height via injected script (ResizeObserver → postMessage '__rautml_h';
  server/AssetFrame injects the snippet before `</body>`). Header: title, version picker (v1…vN, morph transition
  on switch), open-in-new-tab, copy-html.
- **Fork ball**: after first asset exists, floating ball bottom-right (draggable optional). Click → expands into
  right sidebar panel (~380px, spring animation, main chat stays interactive). One persistent fork thread per chat.
  Fork panel = mini chat: own composer, own streaming, markdown+KaTeX, its own ActivityTimeline (fork may search).
- **Questioned-selection marks**: selections already sent with a fork question re-render inside the asset frames
  as persistent marks — text selections get a dotted coral underline, diagram selections a note icon at the
  element's top-right corner. Marks rebuild from the fork messages' persisted attachments (they survive reload)
  and are pushed parent→frame over postMessage ('__rautml_context_marks'); clicking a mark posts
  '__rautml_context_open' back, which opens the fork panel scrolled to (and flashing) the exact message that
  asked about it.
- **Composer**: textarea autosize, Enter=send/Shift+Enter=newline, disabled-with-stop-button while running.
- **ModelPicker** (components/shell): pill chip left of the send button (“Sol High ⌄”) → popover with the
  model list and a reasoning-effort slider (magnetic detents, provider wire values verbatim). Selection is
  global, persisted to localStorage (`rautml.model`, `rautml.efforts` per-model map), sent with each
  POST /messages; each run stores it so parked runs resume on the same settings. The fork composer
  renders a compact variant of the same picker (same global selection), so model + effort can also be
  changed from the sidebar.
- **ElaborationPicker** (components/shell): pill chip left of the model pebble → popover with three audience
  levels — `undergraduate` (explain most domain terms, extra approachable sections allowed), `bachelors`
  (one-or-two-sentence reminders of terms, no dedicated sections), `doctor` (terms used directly, no extra
  explanation). Appends an extra system-prompt layer per run (prompts.ts `ELABORATION_PREAMBLES`); it changes
  the path, never the conclusions. Global, default `bachelors`, persisted to localStorage
  (`rautml.elaboration`), sent with each POST /messages; runs store it so resume keeps it.
- **InputChips**: input.request renders tappable option chips in the thread; tap → POST input, chips lock in.
- **Markdown**: react-markdown + remark-gfm + remark-math + rehype-katex. Code blocks styled, copy button.
- **Reload/reconnect**: on chat open, GET /api/chats/:id renders full state incl. timeline from events; SSE
  connects with ?after=<last seq>. Mid-generation reload must seamlessly continue the live timeline.
- Korean/English mixed text must render cleanly everywhere (Pretendard handles both).

## Shared TS types (types.ts — identical both sides)

```ts
type Thread = 'main'|'fork';
interface Chat { id:string; title:string; createdAt:number; updatedAt:number }
type FollowUpAttachmentKind = 'text'|'diagram';
interface FollowUpAttachment { id:string; kind:FollowUpAttachmentKind; label:string; preview:string;
  content:string; assetId:string; assetTitle:string; version:number }
interface Message { id:string; chatId:string; thread:Thread; role:'user'|'assistant';
  content:string; status:'streaming'|'complete'|'error'; runId?:string;
  attachments?:FollowUpAttachment[]; createdAt:number }
interface Run { id:string; chatId:string; thread:Thread; status:'running'|'awaiting_input'|'done'|'error'|'stopped';
  model?:string; effort?:string; elaboration?:ElaborationLevel }
type ElaborationLevel = 'undergraduate'|'bachelors'|'doctor';
interface ModelInfo { id:string; name:string; shortName:string; provider:string; description:string;
  efforts:string[]; defaultEffort:string }
interface Asset { id:string; chatId:string; messageId:string; title:string; latestVersion:number; createdAt:number }
interface Source { id:string; chatId:string; name:string; ext:string; mime:string; size:number;
  status:'processing'|'ready'|'error'; error?:string; textChars:number; chunkCount:number; createdAt:number }
interface ChatEvent { seq:number; chatId:string; thread:Thread; type:string; data:any }
interface PendingInput { id:string; question:string; options:string[] }
```

## Quality bars

- `npm run typecheck` (tsc --noEmit in both workspaces) must pass; server smoke-testable via curl.
- No CSS leakage from assets into app (iframe guarantees this).
- All animations transform/opacity-based.
- Korean IME input works in composer (no keydown-enter bugs with composition events — check `e.nativeEvent.isComposing`).
