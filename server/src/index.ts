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
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: process.env.RAUTML_ENV_PATH || path.join(__dirname, '..', '..', '.env') });

const { default: express } = await import('express');
// Ensures data dirs (server/data, server/data/workspaces) + schema exist.
await import('./db.js');
const { default: apiRouter } = await import('./routes/api.js');
const { resumePendingIndexing } = await import('./sources/indexer.js');

// Sources stuck in 'processing' by a restart pick up where they left off.
// The embedding model stays lazy: loading it at every desktop launch retained
// a large ONNX session even when the user never opened local sources.
resumePendingIndexing();

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use('/api', apiRouter);

// In Electron the production renderer is served by the same loopback origin as
// the API. This preserves every existing fetch, SSE, iframe, and download path.
const webDist = process.env.RAUTML_WEB_DIST;
if (webDist) {
  const absoluteWebDist = path.resolve(webDist);
  app.use(express.static(absoluteWebDist));
  app.get('*', (_req, res) => res.sendFile(path.join(absoluteWebDist, 'index.html')));
}

// Overridable so a second checkout (or a test harness) can run alongside the
// usual dev server instead of fighting it for the port.
const PORT = Number(process.env.PORT) || 5175;
const HOST = process.env.HOST || '127.0.0.1';
const server = app.listen(PORT, HOST, () => {
  console.log(`Rautml server listening on http://${HOST}:${PORT}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
