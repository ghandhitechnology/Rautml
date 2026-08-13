// Bootstrap: dotenv, db init, routes, listen.
//
// dotenv is configured first, with an explicit path to the repo-root .env
// (not server/.env), and the rest of the app is loaded via dynamic import
// *after* that. This matters because static ESM imports are hoisted and
// evaluated before any top-level code in this file runs — if openrouter.ts
// or a tools/*.ts module reads process.env.* at module scope, a plain
// `import './routes/api.js'` above `config()` would see undefined env vars.
import { config } from 'dotenv';
import path from 'node:path';
import type { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { ErrorRequestHandler } from 'express';
import { applyManagedEnv } from './managed-env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configuredEnv = config({
  path: process.env.RAUTML_ENV_PATH || path.join(__dirname, '..', '..', '.env'),
});
// dotenv preserves inherited variables by default. API settings saved through
// the app are different: the user's file choice must survive an engine restart
// even when their login shell exports an older key.
applyManagedEnv(configuredEnv.parsed ?? {});

// The desktop shell needs this process to stay alive: log process-level
// faults loudly instead of letting Node's defaults take the engine down.
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled rejection', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[server] uncaught exception', err);
});

const { default: express } = await import('express');
// Ensures data dirs (server/data, server/data/workspaces) + schema exist.
const { SOURCES_DIR } = await import('./db.js');
const { default: apiRouter } = await import('./routes/api.js');
const { resumePendingIndexing } = await import('./sources/indexer.js');
const { reapStaleRuns } = await import('./repo.js');
const { shutdown: shutdownEngine } = await import('./agent/engine.js');
const { startUsagePoller, stopUsagePoller } = await import('./agent/usage.js');

// Multer stages uploads in a .incoming dir under each chat's sources dir; a
// crash mid-upload orphans them, and nothing inside was ever committed to a
// source — sweep the leftovers at boot.
try {
  const { readdir, rm } = await import('node:fs/promises');
  for (const entry of await readdir(SOURCES_DIR, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      await rm(path.join(SOURCES_DIR, entry.name, '.incoming'), { recursive: true, force: true });
    }
  }
} catch (err) {
  console.error('[boot] failed to sweep stale upload staging dirs', err);
}

// Sources stuck in 'processing' by a restart pick up where they left off.
// The embedding model stays lazy: loading it at every desktop launch retained
// a large ONNX session even when the user never opened local sources.
resumePendingIndexing();

// Runs still 'running' (and messages still 'streaming') at boot are orphans
// of a crash or kill — finalize them as errors so chats don't look busy forever.
const reaped = reapStaleRuns();
if (reaped.runs || reaped.messages) {
  console.warn(
    `[boot] reaped ${reaped.runs} orphaned run(s) and ${reaped.messages} streaming message(s) from a previous crash`,
  );
}

// Rolling 5h / weekly limits: keep a snapshot warm so Settings never waits
// on CLIProxyAPI when the user opens it.
startUsagePoller();

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use('/api', apiRouter);

// Unknown /api paths get a JSON 404 — not the SPA's index.html with a 200 —
// so this must run before the static catch-all below.
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// CSP for the app shell (static index.html + the catch-all). The
// 'unsafe-inline' entries are required: generated-asset iframes use srcdoc,
// inherit the parent CSP, and rely on inline scripts and styles. Keep this
// string identical to the <meta> tag in web/index.html.
const APP_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'";

// In Electron the production renderer is served by the same loopback origin as
// the API. This preserves every existing fetch, SSE, iframe, and download path.
const webDist = process.env.RAUTML_WEB_DIST;
if (webDist) {
  const absoluteWebDist = path.resolve(webDist);
  app.use(
    express.static(absoluteWebDist, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
          res.setHeader('Content-Security-Policy', APP_CSP);
        }
      },
    }),
  );
  app.get('*', (_req, res) => {
    res.setHeader('Content-Security-Policy', APP_CSP);
    res.sendFile(path.join(absoluteWebDist, 'index.html'));
  });
}

// JSON error handler, mounted last so it covers every route above: no stack
// traces or internals over the wire; the raw message only in development.
const jsonErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('[server] request error', err);
  const message =
    process.env.NODE_ENV === 'development' && err instanceof Error
      ? err.message
      : 'Internal server error';
  res.status(500).json({ error: message });
};
app.use(jsonErrorHandler);

// Overridable so a second checkout (or a test harness) can run alongside the
// usual dev server instead of fighting it for the port.
const PORT = Number(process.env.PORT) || 5175;
const HOST = process.env.HOST || '127.0.0.1';
const server = app.listen(PORT, HOST, () => {
  console.log(`Rautml server listening on http://${HOST}:${PORT}`);
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `[server] ${HOST}:${PORT} is already in use — is another Rautml instance running?`,
    );
  } else {
    console.error('[server] failed to start', err);
  }
  process.exit(1);
});

// Track open sockets so shutdown can tear them down: SSE connections disable
// their socket timeout (see routes/api.ts), so server.close() alone would
// wait on them forever.
const connections = new Set<Socket>();
server.on('connection', (socket) => {
  connections.add(socket);
  socket.on('close', () => connections.delete(socket));
});

const shutdown = () => {
  stopUsagePoller();
  shutdownEngine(); // abort every active run so it finalizes instead of orphaning
  server.close(() => process.exit(0));
  for (const socket of connections) socket.destroy();
  // Backstop: if anything above hangs, exit anyway within 3s.
  setTimeout(() => process.exit(0), 3000).unref();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
