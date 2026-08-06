import { execFile } from 'node:child_process';
import { accessSync, constants, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname, platform, release } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ModelInfo, ProviderInfo, ProviderAuthStatus } from '../types.js';
import type { CompatibleTransport } from './openrouter.js';

const exec = promisify(execFile);
const HOME = homedir();
const CACHE_MS = 30_000;
const DEFAULT_EFFORTS = ['low', 'medium', 'high'];
const GPT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

type ProviderId = 'codex' | 'grok-build' | 'opencode-go' | 'opencode-zen' | 'kimi-code' | 'openrouter';

export class ProviderUnavailableError extends Error {
  readonly code = 'PROVIDER_UNAVAILABLE';
  constructor(readonly providerId: string, message: string) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

function jsonFile(file: string): any | null {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function executable(name: string, candidates: string[]): string | null {
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* continue */ }
  }
  return name;
}

const bins = {
  codex: executable('codex', [path.join(HOME, '.local/bin/codex')]),
  grok: executable('grok', [path.join(HOME, '.grok/bin/grok')]),
  opencode: executable('opencode', [path.join(HOME, '.opencode/bin/opencode')]),
  kimi: executable('kimi', [path.join(HOME, '.kimi-code/bin/kimi'), path.join(HOME, '.local/bin/kimi')]),
};

async function run(bin: string | null, args: string[], timeout = 12_000): Promise<string> {
  if (!bin) throw new Error('CLI not installed');
  const { stdout } = await exec(bin, args, { timeout, maxBuffer: 12 * 1024 * 1024 });
  return stdout;
}

function model(providerId: ProviderId, modelId: string, name?: string, efforts = DEFAULT_EFFORTS): ModelInfo {
  const pretty = name || modelId.split('/').at(-1)!.split('-').map((v) => v ? v[0]!.toUpperCase() + v.slice(1) : v).join(' ');
  return {
    id: `${providerId}:${modelId}`,
    modelId,
    providerId,
    name: pretty,
    shortName: pretty.replace(/^GPT-/i, '').slice(0, 22),
    provider: providerName(providerId),
    description: `Discovered locally through ${providerName(providerId)}`,
    efforts,
    defaultEffort: efforts.includes('medium') ? 'medium' : efforts[0] || 'medium',
  };
}

function providerName(id: ProviderId): string {
  return ({ codex: 'Codex', 'grok-build': 'Grok Build', 'opencode-go': 'OpenCode Go', 'opencode-zen': 'OpenCode Zen', 'kimi-code': 'Kimi Code', openrouter: 'OpenRouter' })[id];
}

function authStatus(id: ProviderId): ProviderAuthStatus {
  if (id === 'codex') return jsonFile(path.join(HOME, '.codex/auth.json'))?.tokens?.access_token ? 'connected' : 'disconnected';
  if (id === 'grok-build') {
    const data = jsonFile(path.join(HOME, '.grok/auth.json'));
    return data && Object.values(data).some((v: any) => typeof v?.key === 'string' && v.key) ? 'connected' : 'disconnected';
  }
  if (id === 'opencode-go' || id === 'opencode-zen') {
    const auth = jsonFile(path.join(HOME, '.local/share/opencode/auth.json'));
    const key = id === 'opencode-go' ? 'opencode-go' : 'opencode';
    return typeof auth?.[key]?.key === 'string' && auth[key].key ? 'connected' : 'disconnected';
  }
  if (id === 'kimi-code') {
    const token = jsonFile(path.join(HOME, '.kimi-code/credentials/kimi-code.json'));
    return token?.access_token ? 'connected' : 'disconnected';
  }
  return process.env.OPENROUTER_API_KEY ? 'connected' : 'disconnected';
}

async function codexModels(): Promise<ModelInfo[]> {
  const raw = JSON.parse(await run(bins.codex, ['debug', 'models', '--bundled']));
  return (raw.models ?? []).filter((m: any) => m.visibility !== 'hide').map((m: any) => {
    const efforts = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.map((e: any) => e.effort).filter(Boolean) : GPT_EFFORTS;
    const item = model('codex', `openai/${m.slug}`, m.display_name, efforts);
    item.defaultEffort = efforts.includes(m.default_reasoning_level) ? m.default_reasoning_level : item.defaultEffort;
    item.description = m.description || item.description;
    return item;
  });
}

async function grokModels(): Promise<ModelInfo[]> {
  const out = await run(bins.grok, ['models']);
  const ids = [...out.matchAll(/^\s*\*?\s*(grok-[\w.-]+)/gim)].map((m) => m[1]!);
  return [...new Set(ids)].map((id) => model('grok-build', `x-ai/${id}`, id.replace(/^grok-/, 'Grok '), ['low', 'medium', 'high']));
}

async function opencodeModels(id: 'opencode-go' | 'opencode-zen'): Promise<ModelInfo[]> {
  const cliProvider = id === 'opencode-go' ? 'opencode-go' : 'opencode';
  const out = await run(bins.opencode, ['models', cliProvider, '--verbose']);
  const items: ModelInfo[] = [];
  const pattern = new RegExp(`^(${cliProvider.replace('-', '\\-')}\\/[^\\n]+)\\n(\\{[\\s\\S]*?^\\})`, 'gm');
  for (const match of out.matchAll(pattern)) {
    try {
      const meta = JSON.parse(match[2]!);
      const variantEfforts = Object.values(meta.variants ?? {}).map((v: any) => v?.reasoningEffort).filter((v): v is string => typeof v === 'string');
      const efforts = [...new Set(variantEfforts)];
      const item = model(id, match[1]!, meta.name, efforts.length ? efforts : DEFAULT_EFFORTS);
      item.description = `${meta.name || meta.id} · ${Number(meta.limit?.context || 0).toLocaleString('en-US')} context`;
      items.push(item);
    } catch { /* ignore one malformed CLI record, keep the rest */ }
  }
  return items;
}

async function kimiModels(): Promise<ModelInfo[]> {
  const raw = JSON.parse(await run(bins.kimi, ['provider', 'list', '--json']));
  return Object.entries(raw.models ?? {}).map(([id, value]: [string, any]) => {
    const efforts = Array.isArray(value.supportEfforts) ? value.supportEfforts : ['high'];
    const item = model('kimi-code', id, value.displayName, efforts);
    item.defaultEffort = efforts.includes(value.defaultEffort) ? value.defaultEffort : efforts[0];
    return item;
  });
}

const OPENROUTER_MODELS = [
  model('openrouter', 'openai/gpt-5.6-sol', 'GPT-5.6 Sol', GPT_EFFORTS),
  model('openrouter', 'x-ai/grok-4.5', 'Grok 4.5', ['low', 'medium', 'high']),
  model('openrouter', 'deepseek/deepseek-v4-flash-0731', 'DeepSeek V4 Flash', ['low', 'high', 'max']),
];

let cached: { at: number; providers: ProviderInfo[] } | null = null;

/** Drop the discovery cache so the next read re-evaluates auth. Called after an
 *  API key is saved, so OpenRouter flips to connected without waiting out
 *  CACHE_MS or requiring a manual refresh. */
export function invalidateProviderCache(): void {
  cached = null;
}

export async function discoverProviders(force = false): Promise<ProviderInfo[]> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.providers;
  const specs: Array<[ProviderId, string, string, string | null, () => Promise<ModelInfo[]>]> = [
    ['codex', 'Codex', 'ChatGPT subscription models discovered by Codex CLI', bins.codex, codexModels],
    ['grok-build', 'Grok Build', 'xAI coding models discovered by Grok CLI', bins.grok, grokModels],
    ['opencode-go', 'OpenCode Go', 'Paid Go catalog; separate credentials and endpoint', bins.opencode, () => opencodeModels('opencode-go')],
    ['opencode-zen', 'OpenCode Zen', 'Zen catalog, kept separate from OpenCode Go', bins.opencode, () => opencodeModels('opencode-zen')],
    ['kimi-code', 'Kimi Code', 'Managed coding catalog discovered by Kimi CLI', bins.kimi, kimiModels],
    ['openrouter', 'OpenRouter', 'Explicit OpenRouter routing only', 'environment', async () => OPENROUTER_MODELS],
  ];
  const providers = await Promise.all(specs.map(async ([id, name, description, bin, load]) => {
    let models: ModelInfo[] = [];
    let installed = id === 'openrouter';
    try { models = await load(); installed = true; } catch { /* CLI absent or catalog unavailable */ }
    const status = installed ? authStatus(id) : 'unavailable';
    return { id, name, description, cli: id === 'openrouter' ? 'OPENROUTER_API_KEY' : String(bin), installed, authStatus: status, authHint: status === 'connected' ? undefined : reconnectCommand(id), modelCount: models.length, models } satisfies ProviderInfo;
  }));
  cached = { at: Date.now(), providers };
  return providers;
}

export async function allModels(force = false): Promise<ModelInfo[]> {
  return (await discoverProviders(force)).flatMap((p) => p.models);
}

export const DEFAULT_MODEL_ID = 'codex:openai/gpt-5.6-sol';

export async function defaultModelId(): Promise<string> {
  const providers = await discoverProviders();
  const preferred = providers.flatMap((p) => p.models).find((m) => m.id === DEFAULT_MODEL_ID);
  if (preferred) return preferred.id;
  return providers.find((p) => p.authStatus === 'connected' && p.models.length)?.models[0]?.id
    ?? providers.find((p) => p.models.length)?.models[0]?.id
    ?? DEFAULT_MODEL_ID;
}

export async function resolveProviderSelection(selectionId?: string): Promise<ModelInfo | null> {
  const models = await allModels();
  const legacy = selectionId && !selectionId.includes(':') ? `codex:${selectionId}` : selectionId;
  const target = legacy || await defaultModelId();
  return models.find((m) => m.id === target) ?? null;
}

export function reconnectCommand(providerId: string): string {
  if (providerId === 'codex') return 'codex login';
  if (providerId === 'grok-build') return 'grok login';
  if (providerId === 'opencode-go') return 'opencode auth login --provider opencode-go';
  if (providerId === 'opencode-zen') return 'opencode auth login --provider opencode';
  if (providerId === 'kimi-code') return 'kimi login';
  return 'Set OPENROUTER_API_KEY and restart Rautml';
}

function reconnectInvocation(providerId: string): { bin: string | null; args: string[] } | null {
  if (providerId === 'codex') return { bin: bins.codex, args: ['login'] };
  if (providerId === 'grok-build') return { bin: bins.grok, args: ['login'] };
  if (providerId === 'opencode-go') return { bin: bins.opencode, args: ['auth', 'login', '--provider', 'opencode-go'] };
  if (providerId === 'opencode-zen') return { bin: bins.opencode, args: ['auth', 'login', '--provider', 'opencode'] };
  if (providerId === 'kimi-code') return { bin: bins.kimi, args: ['login'] };
  return null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Launches the installed CLI login in Terminal. Called only by an explicit user click. */
export async function launchReconnect(providerId: string): Promise<{ launched: boolean; command: string }> {
  const command = reconnectCommand(providerId);
  const invocation = reconnectInvocation(providerId);
  if (!invocation?.bin || process.platform !== 'darwin') return { launched: false, command };

  // GUI-launched apps frequently have a minimal PATH. Send Terminal the resolved
  // executable path instead of relying on its shell to find `codex`, `grok`, etc.
  const terminalCommand = [invocation.bin, ...invocation.args].map(shellQuote).join(' ');
  const escaped = terminalCommand.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  try {
    await exec('osascript', [
      '-e', 'tell application "Terminal" to activate',
      '-e', `tell application "Terminal" to do script "${escaped}"`,
    ], { timeout: 5_000 });
    cached = null;
    return { launched: true, command };
  } catch {
    return { launched: false, command };
  }
}

function bearerFromOpenCode(key: string): string | null {
  const auth = jsonFile(path.join(HOME, '.local/share/opencode/auth.json'));
  return typeof auth?.[key]?.key === 'string' ? auth[key].key : null;
}

function grokToken(): string | null {
  const auth = jsonFile(path.join(HOME, '.grok/auth.json'));
  const entry: any = auth && Object.values(auth).find((v: any) => typeof v?.key === 'string');
  return entry?.key ?? null;
}

async function freshGrokToken(): Promise<string | null> {
  const auth = jsonFile(path.join(HOME, '.grok/auth.json'));
  const entry: any = auth && Object.values(auth).find((v: any) => typeof v?.key === 'string');
  const expiry = Date.parse(entry?.expires_at ?? '');
  if (Number.isFinite(expiry) && expiry - Date.now() < 5 * 60_000) {
    try { await run(bins.grok, ['models']); } catch { /* the request below surfaces a clear auth error */ }
  }
  return grokToken();
}

function kimiHeaders(): Record<string, string> {
  const deviceId = (() => { try { return readFileSync(path.join(HOME, '.kimi/device_id'), 'utf8').trim(); } catch { return 'rautml-local'; } })();
  return {
    'User-Agent': 'KimiCLI/0.32.0',
    'X-Msh-Platform': 'kimi_cli',
    'X-Msh-Version': '0.32.0',
    'X-Msh-Device-Name': hostname(),
    'X-Msh-Device-Model': `${platform()} ${release()}`,
    'X-Msh-Os-Version': release(),
    'X-Msh-Device-Id': deviceId,
  };
}

async function freshKimiToken(): Promise<string | null> {
  const file = path.join(HOME, '.kimi-code/credentials/kimi-code.json');
  const token = jsonFile(file);
  if (!token?.access_token) return null;
  if (Number(token.expires_at || 0) * 1000 - Date.now() > 5 * 60_000) return token.access_token;
  if (!token.refresh_token) return token.access_token;
  const body = new URLSearchParams({
    client_id: '17e5f671-d194-4dfb-9706-5516cb48c098',
    grant_type: 'refresh_token',
    refresh_token: token.refresh_token,
  });
  const response = await fetch('https://auth.kimi.com/api/oauth/token', {
    method: 'POST', headers: { ...kimiHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!response.ok) throw new ProviderUnavailableError('kimi-code', `Kimi OAuth refresh failed (${response.status}). Run \`kimi login\`.`);
  const next: any = await response.json();
  const persisted = {
    access_token: next.access_token,
    refresh_token: next.refresh_token ?? token.refresh_token,
    expires_at: Date.now() / 1000 + Number(next.expires_in || 0),
    expires_in: Number(next.expires_in || 0),
    scope: next.scope ?? token.scope ?? '',
    token_type: next.token_type ?? token.token_type ?? 'Bearer',
  };
  try { writeFileSync(file, JSON.stringify(persisted, null, 2), { mode: 0o600 }); } catch { /* in-memory token still works */ }
  return persisted.access_token;
}

export async function compatibleTransport(providerId: string, modelId: string): Promise<CompatibleTransport> {
  let token: string | null = null;
  let endpoint = '';
  let headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let prepareBody: CompatibleTransport['prepareBody'];
  if (providerId === 'grok-build') {
    token = await freshGrokToken(); endpoint = 'https://cli-chat-proxy.grok.com/v1/chat/completions';
    const grokVersion = jsonFile(path.join(HOME, '.grok/models_cache.json'))?.grok_version ?? '0.2.118';
    headers = {
      ...headers,
      'X-XAI-Token-Auth': 'xai-grok-cli',
      'x-grok-client-version': grokVersion,
      'x-grok-client-identifier': 'grok-shell',
      'x-grok-model-override': modelId.replace(/^x-ai\//, ''),
    };
    prepareBody = (body) => ({ ...body, model: modelId.replace(/^x-ai\//, '') });
  } else if (providerId === 'opencode-go') {
    token = bearerFromOpenCode('opencode-go'); endpoint = 'https://opencode.ai/zen/go/v1/chat/completions';
    prepareBody = (body) => ({ ...body, model: modelId.replace(/^opencode-go\//, '') });
  } else if (providerId === 'opencode-zen') {
    token = bearerFromOpenCode('opencode'); endpoint = 'https://opencode.ai/zen/v1/chat/completions';
    prepareBody = (body) => ({ ...body, model: modelId.replace(/^opencode\//, '') });
  } else if (providerId === 'kimi-code') {
    token = await freshKimiToken(); endpoint = 'https://api.kimi.com/coding/v1/chat/completions';
    headers = { ...headers, ...kimiHeaders() };
    prepareBody = (body) => ({ ...body, model: modelId.replace(/^kimi-code\//, '') });
  } else if (providerId === 'openrouter') {
    token = process.env.OPENROUTER_API_KEY ?? null; endpoint = process.env.OPENROUTER_BASE_URL ? `${process.env.OPENROUTER_BASE_URL}/chat/completions` : 'https://openrouter.ai/api/v1/chat/completions';
    headers = { ...headers, 'HTTP-Referer': 'http://localhost:5174', 'X-Title': 'Rautml' };
  } else {
    throw new ProviderUnavailableError(providerId, `Unsupported provider: ${providerId}`);
  }
  if (!token) throw new ProviderUnavailableError(providerId, `${providerName(providerId as ProviderId)} is not connected. ${reconnectCommand(providerId)}.`);
  return { endpoint, headers: { ...headers, Authorization: `Bearer ${token}` }, name: providerName(providerId as ProviderId), prepareBody };
}
