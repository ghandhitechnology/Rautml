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
config({ path: path.join(__dirname, '..', '..', '.env') });

const { default: express } = await import('express');
// Ensures data dirs (server/data, server/data/workspaces) + schema exist.
await import('./db.js');
const { default: apiRouter } = await import('./routes/api.js');
const { resumePendingIndexing } = await import('./sources/indexer.js');
const { preloadEmbeddings } = await import('./sources/embeddings.js');

// Sources stuck in 'processing' by a restart pick up where they left off, and
// the embedding model warms in the background so the first upload is instant.
resumePendingIndexing();
preloadEmbeddings();

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use('/api', apiRouter);

// Overridable so a second checkout (or a test harness) can run alongside the
// usual dev server instead of fighting it for the port.
const PORT = Number(process.env.PORT) || 5175;
app.listen(PORT, () => {
  console.log(`Rautml server listening on http://localhost:${PORT}`);
});
