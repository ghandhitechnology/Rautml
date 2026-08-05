# Rautml

Research-driven chat where the answer is a **living page**. Ask for something substantial and
GPT-5.6-sol researches it (web/image search, page reads, bash) and builds a rich, self-contained
HTML document that takes over the chat view. Small follow-up questions live in a forked side
chat (the coral ball) so the page never gets buried.

## macOS app

The Electron build keeps the local Express engine and all existing model, source, document,
download, and CLI-discovery features inside a native macOS app. It uses the native traffic lights
with a hidden titlebar, and stores its database, model cache, and optional `.env` in
`~/Library/Application Support/Rautml/`.

```bash
npm run dev:desktop  # desktop shell with Vite hot reload
npm run desktop      # production renderer in Electron
npm run dist:mac     # arm64 DMG + ZIP in release/
```

### Personal releases

Pushing a version tag builds an arm64 DMG and ZIP on a GitHub-hosted macOS runner and attaches them
to a private GitHub Release. The tag must match the version in `package.json`.

```bash
# Example: package.json contains "version": "0.2.0"
git tag v0.2.0
git push origin v0.2.0
```

Use **Rautml → Check for Updates…** to open the latest private release, then download and replace
the app in `/Applications`. GitHub login is required because the repository is private. This manual
installation path does not require an Apple Developer account or a continuously running server.

Automatic in-place updates can be added later, but macOS requires those builds to be signed and
notarized with an Apple Developer ID.

## Web development

```bash
npm install
npm run dev        # server :5175 + web :5174
```

Open http://localhost:5174. Requires `OPENROUTER_API_KEY` and `FIRECRAWL_API_KEY` in `.env`
(root) or the environment. Node 26+ (uses the built-in `node:sqlite`).

## How it works

- **Document takeover** — once a chat has an asset, the page fills the main column edge-to-edge;
  a glass header (title, asset switcher, version picker, open/copy) and a floating composer sit
  over it. The conversation is one toggle away (history overlay).
- **Live activity timeline** — every tool call streams in as it happens ("Searching…",
  "Reading science.nasa.gov…", "Building mars.html…"), collapsing to "Worked for 1m 05s · 8 steps".
- **In-place edits** — "make the header purple" patches the page via `str_replace` and bumps the
  version picker (v1, v2, …); every version stays viewable.
- **Fork ball** — the floating orb opens a 380px side thread that knows the whole main
  conversation and every asset's source. Ask-don't-scroll.
- **Runs are durable** — generation runs server-side, detached from the browser. Reload
  mid-generation and the timeline resumes via SSE replay; `ask_user_input_v0` questions park the
  run in SQLite until answered.

Model tools: `web_search`, `web_fetch`, `image_search` (Firecrawl), `bash_tool`, `create_file`,
`str_replace`, `view`, `present_files`, `visualize_read_me`, `visualize_show_widget`,
`ask_user_input_v0`. Assets are HTML files the model writes to its per-chat workspace
(`server/data/workspaces/<chatId>/assets/*.html`), auto-registered and versioned.

Architecture, schemas, and protocols: see `CONTRACT.md`.
