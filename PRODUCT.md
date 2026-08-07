# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

macOS desktop (Electron), with the web workspace retained for development.

## Users

The builder themself, plus people they show it to (developers, designers, potential employers or collaborators). The viewer arrives at a demo — live or recorded — and judges within a minute whether this is a genuinely new interaction model or just another chat wrapper. Design serves both daily personal use and first-impression impact; polish and wow-factor are part of the product's job, not decoration.

## Product Purpose

Rautml is a research-driven chat where the answer is a web page. Ask for something substantial and the model researches it (web/image search, page reads, bash) and builds a rich, self-contained HTML document that takes over the chat view. Success means a demo viewer immediately grasps — and is impressed by — the shift from "chat that describes" to "chat that builds the artifact."

## Positioning

Two co-equal pillars, confirmed as inseparable — neither may be sacrificed for the other:

1. **The answer IS the page.** Document takeover is sacred: once a chat has an asset, the generated HTML owns the main column edge-to-edge; chat chrome recedes to a glass header, floating composer, and history overlay.
2. **Transparent research process.** The live activity timeline — watching the agent search, read pages, and build files in real time, collapsing to "Worked for 1m 05s · 8 steps" — is as much the product as the output.

A neighboring chat product could not truthfully claim both: answers as living, versioned documents *and* a fully visible research process behind each one.

## Operating Context

- Monorepo: `server/` (Express + TS + node:sqlite), `web/` (Vite + React 18 + TS), and `desktop/` (Electron host). The packaged app starts its engine on a private loopback port; all UI remains in `web/`.
- The macOS window uses native traffic lights in a hidden-inset titlebar. Content fills the window and the sidebar provides the draggable region without adding a separate desktop chrome bar.
- Runs are durable and server-side: reload mid-generation and the timeline resumes via SSE replay; `ask_user_input_v0` questions park the run in SQLite until answered.
- Follow-ups live in a forked side thread (the "fork ball" orb → 380px panel) so the page never gets buried — "ask, don't scroll."
- In-place edits ("make the header purple") patch the page via `str_replace` and bump a version picker (v1, v2, …); every version stays viewable.
- Generated assets are per-chat HTML files in `server/data/workspaces/<chatId>/assets/`, auto-registered and versioned, rendered in a sandboxed iframe.
- Model/effort pickers expose the OpenRouter catalog (GPT-5.6 family, Grok 4.5, DeepSeek v4 flash) with per-model reasoning-effort options.
- `CONTRACT.md` is the binding source of truth for names, schemas, routes, and component ownership boundaries; design work must not deviate from it.

## Capabilities and Constraints

- Model tools: `web_search`, `web_fetch`, `image_search` (Firecrawl), `bash_tool`, `create_file`, `str_replace`, `view`, `present_files`, `visualize_read_me`, `visualize_show_widget`, `ask_user_input_v0`.
- Provider credentials remain optional and feature-specific. The desktop app inherits the user's login-shell environment and reads its private `.env` from Application Support; the packaged Node runtime provides `node:sqlite`.
- Generated pages are self-contained HTML — the app must frame arbitrary model-authored documents gracefully, light or dark, ugly or beautiful.
- Terminology (fixed): **asset** (a generated HTML document), **fork** / **fork ball** (the side thread and its orb), **activity timeline** (live tool-call stream), **run** (one server-side generation), **takeover** (asset filling the main column).
- Known environment quirk: a parent checkout's dev server can squat port 5175, making smoke tests hit stale routes — verify which server answers before trusting a route.

## Evidence on Hand

- The product itself is the evidence: live generations, real research runs, and versioned assets produced during demos.
- No external users, testimonials, metrics, or case studies exist — never fabricate user counts, quotes, logos, or adoption claims on any surface.

## Product Principles

1. **The artifact leads.** When an asset exists, everything else — chat, chrome, controls — yields the stage to it. UI over the document is glass, floating, dismissible.
2. **Show the work.** The research process is theater worth watching: every tool call is legible as it happens, and its summary stays honest afterward.
3. **Never bury the page.** Conversation grows sideways (fork) or behind (history overlay), not on top of the document.
4. **Demo-grade at every moment.** Any state a viewer might see mid-demo — streaming, waiting, resuming, erroring — must look intentional, because first impressions are the product's success metric.
5. **Durable over ephemeral.** Versions, runs, and threads persist and resume; nothing a viewer watched being built should be losable to a reload.
