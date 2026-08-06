// User settings: API keys (env file) + personalization (settings table).
//
// Keys live in the same .env the process was booted from, because that file is
// already the app's configuration source of truth (index.ts loads it, the
// desktop menu's "Open Configuration Folder" points at it). Writing there keeps
// one source of truth instead of two, and every consumer reads process.env at
// call time — research.ts firecrawlKey(), openrouter.ts apiKey(),
// providers.ts — so a saved key takes effect without restarting the engine.
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSetting, setSetting } from './repo.js';
import type { ApiKeyStatus, Personalization } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Same resolution as index.ts:config(). Duplicated deliberately: index.ts must
 *  call dotenv before importing anything that reads process.env at module scope,
 *  so it cannot import this module to share the constant. */
export function envPath(): string {
  return process.env.RAUTML_ENV_PATH || path.join(__dirname, '..', '..', '.env');
}

type KeySpec = { name: string; label: string; hint: string; optional?: boolean };

/** The only variables the settings UI may write. Anything else in the .env file
 *  is left untouched by writeKeys(). */
export const MANAGED_KEYS: KeySpec[] = [
  {
    name: 'OPENROUTER_API_KEY',
    label: 'OpenRouter',
    hint: 'Unlocks the OpenRouter provider in the model selector.',
  },
  {
    name: 'FIRECRAWL_API_KEY',
    label: 'Firecrawl',
    hint: 'Powers web search, page fetching, and image search.',
  },
  {
    name: 'BROWSERBASE_API_KEY',
    label: 'Browserbase',
    hint: 'Stored for upcoming browser tooling. Nothing reads it yet.',
    optional: true,
  },
  {
    name: 'BROWSERBASE_PROJECT_ID',
    label: 'Browserbase project ID',
    hint: 'Browserbase needs a project ID alongside the API key.',
    optional: true,
  },
];

const MANAGED_NAMES = new Set(MANAGED_KEYS.map((k) => k.name));

/** Never return a secret to the renderer — only enough to recognise it. */
function mask(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 4) return '••••';
  return `••••${trimmed.slice(-4)}`;
}

/** The managed keys the env file itself defines, with their values. */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out[match[1]!] = value;
  }
  return out;
}

function fileValues(): Record<string, string> {
  try {
    return parseEnvText(readFileSync(envPath(), 'utf8'));
  } catch {
    return {};
  }
}

export function readKeys(): ApiKeyStatus[] {
  const fromFile = fileValues();
  return MANAGED_KEYS.map((spec) => {
    const value = (process.env[spec.name] ?? '').trim();
    const inFile = (fromFile[spec.name] ?? '').trim();
    // dotenv does not override variables the process already had, so a key
    // exported by the user's login shell wins over the file on every restart —
    // the UI has to say so, or an edit here looks like it silently reverted.
    // (Electron inherits that shell env deliberately; see desktop/main.mjs.)
    const source: ApiKeyStatus['source'] = !value
      ? 'unset'
      : inFile && inFile === value
        ? 'file'
        : 'environment';
    return {
      name: spec.name,
      label: spec.label,
      hint: spec.hint,
      optional: spec.optional ?? false,
      set: value.length > 0,
      masked: mask(value),
      source,
    };
  });
}

/** dotenv accepts quoted values; write them quoted when they could otherwise be
 *  misparsed, and strip quotes when comparing. */
function encodeValue(value: string): string {
  return /^[A-Za-z0-9_\-./:+=~@]*$/.test(value) ? value : JSON.stringify(value);
}

/**
 * Line-preserving upsert. Comments, blank lines, ordering, and every variable
 * this module does not manage survive untouched — the file may hold config the
 * settings UI knows nothing about.
 */
export function upsertEnvText(text: string, patch: Record<string, string>): string {
  const names = Object.keys(patch).filter((n) => MANAGED_NAMES.has(n));
  if (!names.length) return text;

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const seen = new Set<string>();

  const kept: string[] = [];
  for (const line of lines) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const name = match?.[1];
    if (!name || !names.includes(name)) {
      kept.push(line);
      continue;
    }
    // First occurrence is rewritten in place; later duplicates are dropped so
    // the file cannot end up with two conflicting definitions of one key.
    if (seen.has(name)) continue;
    seen.add(name);
    const value = patch[name]!.trim();
    if (value) kept.push(`${name}=${encodeValue(value)}`);
    // An empty value clears the key: the line disappears entirely.
  }

  const appended = names.filter((n) => !seen.has(n) && patch[n]!.trim());
  if (appended.length) {
    while (kept.length && kept[kept.length - 1]!.trim() === '') kept.pop();
    if (kept.length) kept.push('');
    for (const name of appended) kept.push(`${name}=${encodeValue(patch[name]!.trim())}`);
  }

  let out = kept.join(eol);
  if (out && !out.endsWith(eol)) out += eol;
  return out;
}

/**
 * Persist keys to the env file and apply them to this process immediately.
 * An empty (or whitespace-only) value clears the key.
 */
export async function writeKeys(patch: Record<string, string>): Promise<ApiKeyStatus[]> {
  const accepted: Record<string, string> = {};
  for (const [name, value] of Object.entries(patch)) {
    if (MANAGED_NAMES.has(name) && typeof value === 'string') accepted[name] = value;
  }
  if (!Object.keys(accepted).length) return readKeys();

  const file = envPath();
  let existing = '';
  try {
    existing = await fs.readFile(file, 'utf8');
  } catch {
    /* First key on a fresh install — the file is created below. */
  }

  const next = upsertEnvText(existing, accepted);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Write-then-rename so a crash mid-write cannot leave a truncated config.
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, next, { mode: 0o600 });
  await fs.rename(tmp, file);

  for (const [name, value] of Object.entries(accepted)) {
    const trimmed = value.trim();
    if (trimmed) process.env[name] = trimmed;
    else delete process.env[name];
  }

  return readKeys();
}

// ---------------------------------------------------------------------------
// Personalization — user-global, so it is read server-side at prompt-build time
// rather than threaded through each run's selection.
// ---------------------------------------------------------------------------

const DESIGN_PREFERENCES_KEY = 'design_preferences';
const ABOUT_ME_KEY = 'about_me';

/** Guards the context window against a pasted essay. */
export const PERSONALIZATION_MAX_CHARS = 4000;

export function readPersonalization(): Personalization {
  return {
    designPreferences: getSetting(DESIGN_PREFERENCES_KEY) ?? '',
    aboutMe: getSetting(ABOUT_ME_KEY) ?? '',
  };
}

export function writePersonalization(patch: Partial<Personalization>): Personalization {
  const clamp = (value: string) => value.trim().slice(0, PERSONALIZATION_MAX_CHARS);
  if (typeof patch.designPreferences === 'string') {
    setSetting(DESIGN_PREFERENCES_KEY, clamp(patch.designPreferences));
  }
  if (typeof patch.aboutMe === 'string') {
    setSetting(ABOUT_ME_KEY, clamp(patch.aboutMe));
  }
  return readPersonalization();
}

/** The "about me" block appended to the system prompt for every run. */
export function aboutMeBlock(): string {
  const about = readPersonalization().aboutMe;
  if (!about) return '';
  return `## About the person you're helping\n\nThey wrote this about themselves. Let it shape who you are writing for — their background, their interests, the voice they want back. It never overrides a direct instruction in the conversation.\n\n${about}`;
}

/** The standing design preferences appended to the asset design constitution. */
export function designPreferencesBlock(): string {
  const prefs = readPersonalization().designPreferences;
  if (!prefs) return '';
  return `## This user's standing design preferences\n\nThese are their words, set once and applied to every asset. Treat them exactly like a styling wish stated in the conversation: they override the house defaults where they conflict, while the structural rules and contrast floors above still bind. A request made in the conversation itself wins over these.\n\n${prefs}`;
}
