// Live rolling usage limits from CLIProxyAPI (and the same first-party
// endpoints it proxies), plus OpenRouter credit data, so Settings can show
// provider limits and balances that were already refreshed in the background.
//
// GET /api/usage only ever returns the last snapshot. A 10-minute poller
// started at boot writes that snapshot to the settings table, so opening
// the page never waits on ChatGPT / Anthropic / the proxy.

import { homedir } from 'node:os';
import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getSetting, setSetting } from '../repo.js';
import type { ProviderBalance, ProviderUsage, UsageSnapshot, UsageWindow } from '../types.js';
import { fetchWithHeadersTimeout } from './http.js';
import { peekCodexTokens } from './codex.js';

export const USAGE_POLL_MS = 10 * 60_000;
const SNAPSHOT_KEY = 'provider_usage';
const TOKEN_SLACK_MS = 5 * 60_000;
const WHAM_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1';
const WINDOW_5H = 5 * 60 * 60;
const WINDOW_WEEK = 7 * 24 * 60 * 60;

export type UsageWindowKind = 'fiveHour' | 'weekly';

export type { ProviderUsage, UsageSnapshot, UsageWindow };

interface UsageAccount {
  id: string;
  provider: string;
  name: string;
  email?: string;
  accountId?: string;
  accessToken?: string;
  refreshToken?: string;
  authIndex?: string;
  filePath?: string;
  disabled?: boolean;
}

interface AccountReport {
  provider: string;
  name: string;
  plan?: string;
  accountKey: string;
  fiveHour?: UsageWindow;
  weekly?: UsageWindow;
  error?: string;
}

const PROVIDER_NAMES: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude',
  'gemini-cli': 'Gemini CLI',
  gemini: 'Gemini',
  antigravity: 'Antigravity',
  'grok-build': 'Grok Build',
  grok: 'Grok Build',
  xai: 'Grok Build',
  'kimi-code': 'Kimi Code',
  kimi: 'Kimi Code',
  openrouter: 'OpenRouter',
};

let cached: UsageSnapshot | null = null;
let inflight: Promise<UsageSnapshot> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

export function emptyUsageSnapshot(): UsageSnapshot {
  return { providers: [], updatedAt: 0 };
}

export function getUsageSnapshot(): UsageSnapshot {
  if (!cached) cached = readPersisted();
  return cached;
}

export function startUsagePoller(): void {
  if (pollTimer) return;
  cached = readPersisted();
  void refreshUsage();
  pollTimer = setInterval(() => void refreshUsage(), USAGE_POLL_MS);
  pollTimer.unref();
}

export function stopUsagePoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** Kick a background refresh. Does not wait, and does not replace a good cache. */
export function scheduleUsageRefresh(): void {
  void refreshUsage();
}

export async function refreshUsage(): Promise<UsageSnapshot> {
  if (inflight) return inflight;
  inflight = collectUsage()
    .then((snapshot) => {
      cached = snapshot;
      persist(snapshot);
      return snapshot;
    })
    .catch((err) => {
      console.error('[usage] refresh failed', err);
      return getUsageSnapshot();
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function cliproxyUrl(): string {
  return (process.env.CLIPROXYAPI_URL || 'http://127.0.0.1:8317').replace(/\/+$/, '');
}

function cliproxyKey(): string {
  return (process.env.CLIPROXYAPI_MANAGEMENT_KEY || '').trim();
}

function cliproxyAuthDir(): string {
  const override = process.env.CLIPROXYAPI_AUTH_DIR?.trim();
  return override || path.join(homedir(), '.cli-proxy-api');
}

function readPersisted(): UsageSnapshot {
  const raw = getSetting(SNAPSHOT_KEY);
  if (!raw) return emptyUsageSnapshot();
  try {
    const parsed = JSON.parse(raw) as UsageSnapshot;
    if (!parsed || !Array.isArray(parsed.providers) || typeof parsed.updatedAt !== 'number') {
      return emptyUsageSnapshot();
    }
    return parsed;
  } catch {
    return emptyUsageSnapshot();
  }
}

function persist(snapshot: UsageSnapshot): void {
  try {
    setSetting(SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch (err) {
    console.error('[usage] could not persist snapshot', err);
  }
}

async function collectUsage(): Promise<UsageSnapshot> {
  const accounts = await discoverAccounts();
  const [reports, openRouter] = await Promise.all([
    Promise.all(accounts.map((account) => queryAccount(account))),
    queryOpenRouterBalance(),
  ]);
  const providers = aggregateReports(reports);
  if (openRouter) providers.push(openRouter);
  return {
    providers,
    updatedAt: Date.now(),
  };
}

/**
 * OpenRouter exposes account credits to management keys. Normal inference keys
 * may only expose their own spending allowance, so fall back to GET /key and
 * label that narrower value explicitly in the UI.
 */
async function queryOpenRouterBalance(): Promise<ProviderUsage | null> {
  const apiKey = (process.env.OPENROUTER_API_KEY || '').trim();
  const managementKey = (process.env.OPENROUTER_MANAGEMENT_API_KEY || '').trim();
  if (!apiKey && !managementKey) return null;
  const baseUrl = (process.env.OPENROUTER_BASE_URL || OPENROUTER_API_URL).replace(/\/+$/, '');
  let creditsError: unknown;
  if (managementKey) {
    try {
      const payload = await requestJson(
        `${baseUrl}/credits`,
        { headers: { Authorization: `Bearer ${managementKey}` } },
        8_000,
      );
      const balance = parseOpenRouterCredits(payload);
      if (balance) return openRouterUsage(balance);
    } catch (err) {
      creditsError = err;
    }
  }
  if (!apiKey) {
    const message = creditsError instanceof Error ? creditsError.message : 'Could not read OpenRouter balance';
    return openRouterUsage(undefined, message);
  }
  try {
    const payload = await requestJson(
      `${baseUrl}/key`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
      8_000,
    );
    const balance = parseOpenRouterKey(payload);
    if (balance) return openRouterUsage(balance);
    return openRouterUsage(undefined, 'This API key has no spending limit to display');
  } catch (err) {
    const message = err instanceof Error
      ? err.message
      : creditsError instanceof Error
        ? creditsError.message
        : 'Could not read OpenRouter balance';
    return openRouterUsage(undefined, message);
  }
}

function openRouterUsage(balance?: ProviderBalance, error?: string): ProviderUsage {
  return {
    id: 'openrouter',
    name: 'OpenRouter',
    accounts: 1,
    balance,
    error: balance ? undefined : error,
  };
}

export function parseOpenRouterCredits(payload: unknown): ProviderBalance | undefined {
  const data = asRecord(asRecord(payload)?.data);
  const total = numberOf(firstValue(data?.total_credits, data?.totalCredits));
  const used = numberOf(firstValue(data?.total_usage, data?.totalUsage));
  if (!Number.isFinite(total) || !Number.isFinite(used)) return undefined;
  return { remaining: total - used, used, total, scope: 'account' };
}

export function parseOpenRouterKey(payload: unknown): ProviderBalance | undefined {
  const data = asRecord(asRecord(payload)?.data);
  const total = numberOf(data?.limit);
  const used = numberOf(data?.usage);
  let remaining = numberOf(firstValue(data?.limit_remaining, data?.limitRemaining));
  if (!Number.isFinite(remaining) && Number.isFinite(total) && Number.isFinite(used)) {
    remaining = total - used;
  }
  if (!Number.isFinite(remaining)) return undefined;
  return {
    remaining,
    used: Number.isFinite(used) ? used : undefined,
    total: Number.isFinite(total) ? total : undefined,
    scope: 'key',
  };
}

async function discoverAccounts(): Promise<UsageAccount[]> {
  const byKey = new Map<string, UsageAccount>();
  const add = (account: UsageAccount) => {
    if (account.disabled) return;
    const key = `${account.provider}:${account.accountId || account.email || account.id}`;
    if (!byKey.has(key)) byKey.set(key, account);
  };

  for (const account of await loadManagementAccounts()) add(account);
  for (const account of loadAuthDirAccounts()) add(account);

  const local = await peekCodexTokens();
  if (local) {
    add({
      id: 'codex-local',
      provider: 'codex',
      name: 'Codex',
      accountId: local.accountId,
      accessToken: local.accessToken,
    });
  }

  return [...byKey.values()];
}

async function loadManagementAccounts(): Promise<UsageAccount[]> {
  const key = cliproxyKey();
  const payload = await managementGet('/v0/management/auth-files', key);
  const files = Array.isArray(payload?.files) ? payload.files : [];
  const accounts: UsageAccount[] = [];
  for (const raw of files) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const provider = normalizeProvider(firstString(entry.provider, entry.type));
    if (!provider) continue;
    const authIndex = firstString(entry.auth_index, entry.authIndex);
    if (!authIndex) continue;
    accounts.push({
      id: firstString(entry.name, entry.id, authIndex) || authIndex,
      provider,
      name: firstString(entry.name, entry.email, entry.id) || providerName(provider),
      email: firstString(entry.email),
      accountId: firstString(entry.account_id, entry.accountId) || accountIdFromJwt(firstString(entry.id_token)),
      authIndex,
      disabled: entry.disabled === true,
    });
  }
  return accounts;
}

function loadAuthDirAccounts(): UsageAccount[] {
  const dir = cliproxyAuthDir();
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const accounts: UsageAccount[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const filePath = path.join(dir, name);
    const data = jsonFile(filePath);
    if (!data) continue;
    const provider = normalizeProvider(firstString(data.type, data.provider));
    if (!provider) continue;
    accounts.push({
      id: firstString(data.email, data.id, name) || name,
      provider,
      name: firstString(data.email, data.id, name) || providerName(provider),
      email: firstString(data.email),
      accountId: firstString(data.account_id, data.accountId) || accountIdFromJwt(firstString(data.id_token)),
      accessToken: firstString(data.access_token, data.accessToken),
      refreshToken: firstString(data.refresh_token, data.refreshToken),
      filePath,
      disabled: data.disabled === true,
    });
  }
  return accounts;
}

async function queryAccount(account: UsageAccount): Promise<AccountReport> {
  const base: AccountReport = {
    provider: account.provider,
    name: account.name,
    accountKey: account.accountId || account.email || account.id,
  };
  try {
    if (account.provider === 'codex') {
      const payload = await fetchCodexUsage(account);
      return { ...base, ...parseWhamUsage(payload) };
    }
    if (account.provider === 'claude') {
      const payload = await fetchClaudeUsage(account);
      return { ...base, ...parseClaudeUsage(payload) };
    }
    return { ...base, error: 'Limits are not available for this provider yet' };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : 'Could not read limits' };
  }
}

async function fetchCodexUsage(account: UsageAccount): Promise<Record<string, unknown>> {
  if (account.authIndex) {
    const headers: Record<string, string> = {
      Authorization: 'Bearer $TOKEN$',
      'Content-Type': 'application/json',
      'User-Agent': 'codex_cli_rs/0.76.0',
    };
    if (account.accountId) headers['Chatgpt-Account-Id'] = account.accountId;
    return managementApiCall(account.authIndex, 'GET', WHAM_USAGE_URL, headers);
  }
  const token = await freshCodexToken(account);
  if (!token) throw new Error('Codex is not signed in');
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'codex_cli_rs/0.76.0',
  };
  if (account.accountId) headers['Chatgpt-Account-Id'] = account.accountId;
  return requestJson(WHAM_USAGE_URL, { headers });
}

async function fetchClaudeUsage(account: UsageAccount): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    'anthropic-beta': 'oauth-2025-04-20',
    'Content-Type': 'application/json',
  };
  if (account.authIndex) {
    return managementApiCall(account.authIndex, 'GET', CLAUDE_USAGE_URL, {
      ...headers,
      Authorization: 'Bearer $TOKEN$',
    });
  }
  if (!account.accessToken) throw new Error('Claude is not signed in');
  return requestJson(CLAUDE_USAGE_URL, {
    headers: { ...headers, Authorization: `Bearer ${account.accessToken}` },
  });
}

async function freshCodexToken(account: UsageAccount): Promise<string | null> {
  if (account.id === 'codex-local' && account.accessToken) return account.accessToken;
  if (!account.accessToken) return null;
  if (jwtExpMs(account.accessToken) - Date.now() > TOKEN_SLACK_MS) return account.accessToken;
  if (!account.refreshToken || !account.filePath) return account.accessToken;

  const res = await fetchWithHeadersTimeout(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CODEX_OAUTH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: account.refreshToken,
      scope: 'openid profile email',
    }),
  });
  if (!res.ok) return account.accessToken;
  const json: any = await res.json();
  const access = typeof json.access_token === 'string' ? json.access_token : account.accessToken;
  const refresh = typeof json.refresh_token === 'string' ? json.refresh_token : account.refreshToken;
  try {
    const current = jsonFile(account.filePath) ?? {};
    const next = {
      ...current,
      access_token: access,
      refresh_token: refresh,
      last_refresh: new Date().toISOString(),
    };
    const tmp = `${account.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(tmp, account.filePath);
  } catch {
    /* in-memory token still works */
  }
  return access;
}

async function managementGet(pathname: string, key: string): Promise<any | null> {
  try {
    const headers: Record<string, string> = {};
    if (key) headers.Authorization = `Bearer ${key}`;
    return await requestJson(`${cliproxyUrl()}${pathname}`, { headers }, 8_000);
  } catch {
    return null;
  }
}

async function managementApiCall(
  authIndex: string,
  method: string,
  url: string,
  header: Record<string, string>,
): Promise<Record<string, unknown>> {
  const key = cliproxyKey();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const response = await requestJson(
    `${cliproxyUrl()}/v0/management/api-call`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ auth_index: authIndex, method, url, header }),
    },
    20_000,
  );
  const status = Number(response.status_code ?? response.statusCode ?? 0);
  const body = parseMaybeJson(response.body);
  if (status && (status < 200 || status >= 300)) {
    throw new Error(typeof response.body === 'string' && response.body ? response.body.slice(0, 180) : `HTTP ${status}`);
  }
  if (!body) throw new Error('Empty usage payload');
  return body;
}

async function requestJson(url: string, init: RequestInit, timeoutMs = 20_000): Promise<any> {
  const res = await fetchWithHeadersTimeout(url, init, timeoutMs);
  const text = await res.text();
  if (!res.ok) throw new Error(text.slice(0, 180) || `HTTP ${res.status}`);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Invalid usage payload');
  }
}

export function parseWhamUsage(payload: Record<string, unknown>): Pick<AccountReport, 'plan' | 'fiveHour' | 'weekly'> {
  const rate = asRecord(firstValue(payload.rate_limit, payload.rateLimit));
  const windows = [asRecord(firstValue(rate?.primary_window, rate?.primaryWindow)), asRecord(firstValue(rate?.secondary_window, rate?.secondaryWindow))];
  let fiveHour: UsageWindow | undefined;
  let weekly: UsageWindow | undefined;
  for (const window of windows) {
    const kind = classifyWindowSeconds(numberOf(firstValue(window?.limit_window_seconds, window?.limitWindowSeconds)));
    const parsed = parseWhamWindow(window);
    if (!kind || !parsed) continue;
    if (kind === 'fiveHour') fiveHour = parsed;
    else weekly = parsed;
  }
  return {
    plan: firstString(payload.plan_type, payload.planType) || undefined,
    fiveHour,
    weekly,
  };
}

export function parseClaudeUsage(payload: Record<string, unknown>): Pick<AccountReport, 'fiveHour' | 'weekly'> {
  return {
    fiveHour: parseClaudeWindow(asRecord(payload.five_hour) ?? asRecord(payload.fiveHour)),
    weekly: parseClaudeWindow(asRecord(firstValue(payload.seven_day, payload.sevenDay, payload.weekly))),
  };
}

export function classifyWindowSeconds(seconds: number): UsageWindowKind | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (Math.abs(seconds - WINDOW_5H) / WINDOW_5H <= 0.2) return 'fiveHour';
  if (Math.abs(seconds - WINDOW_WEEK) / WINDOW_WEEK <= 0.2) return 'weekly';
  if (seconds >= 3.5 * 3600 && seconds <= 6.5 * 3600) return 'fiveHour';
  if (seconds >= 6 * 24 * 3600 && seconds <= 8 * 24 * 3600) return 'weekly';
  return null;
}

function parseWhamWindow(window: Record<string, unknown> | null): UsageWindow | undefined {
  if (!window) return undefined;
  const used = numberOf(firstValue(window.used_percent, window.usedPercent));
  if (!Number.isFinite(used)) return undefined;
  const resetAtSec = numberOf(firstValue(window.reset_at, window.resetAt));
  const resetAfter = numberOf(firstValue(window.reset_after_seconds, window.resetAfterSeconds));
  const resetAt =
    resetAtSec > 1_000_000_000 ? resetAtSec * 1000 : resetAfter > 0 ? Date.now() + resetAfter * 1000 : null;
  return { usedPercent: clampPercent(used), resetAt };
}

function parseClaudeWindow(window: Record<string, unknown> | null): UsageWindow | undefined {
  if (!window) return undefined;
  const raw = numberOf(firstValue(window.utilization, window.used_percent, window.usedPercent));
  if (!Number.isFinite(raw)) return undefined;
  const usedPercent = raw <= 1 ? raw * 100 : raw;
  const resetRaw = firstValue(window.resets_at, window.resetsAt, window.reset_at, window.resetAt);
  let resetAt: number | null = null;
  if (typeof resetRaw === 'string') {
    const parsed = Date.parse(resetRaw);
    resetAt = Number.isFinite(parsed) ? parsed : null;
  } else if (typeof resetRaw === 'number' && resetRaw > 1_000_000_000) {
    resetAt = resetRaw > 1e12 ? resetRaw : resetRaw * 1000;
  }
  return { usedPercent: clampPercent(usedPercent), resetAt };
}

export function aggregateReports(reports: AccountReport[]): ProviderUsage[] {
  const groups = new Map<string, AccountReport[]>();
  for (const report of reports) {
    const list = groups.get(report.provider) ?? [];
    list.push(report);
    groups.set(report.provider, list);
  }
  const providers: ProviderUsage[] = [];
  for (const [id, items] of groups) {
    const fiveHour = pickWindow(items, 'fiveHour');
    const weekly = pickWindow(items, 'weekly');
    const error = items.find((item) => item.error && !item.fiveHour && !item.weekly)?.error;
    if (!fiveHour && !weekly && !error) continue;
    const plan = items.map((item) => item.plan).find(Boolean);
    providers.push({
      id,
      name: providerName(id),
      plan,
      accounts: new Set(items.map((item) => item.accountKey)).size,
      fiveHour,
      weekly,
      error: fiveHour || weekly ? undefined : error,
    });
  }
  const order = ['codex', 'claude', 'grok-build', 'kimi-code', 'gemini-cli', 'gemini', 'antigravity', 'openrouter'];
  providers.sort((a, b) => {
    const left = order.indexOf(a.id);
    const right = order.indexOf(b.id);
    return (left === -1 ? 99 : left) - (right === -1 ? 99 : right) || a.name.localeCompare(b.name);
  });
  return providers;
}

function pickWindow(items: AccountReport[], kind: UsageWindowKind): UsageWindow | undefined {
  const windows = items.map((item) => item[kind]).filter((window): window is UsageWindow => !!window);
  if (!windows.length) return undefined;
  return windows.reduce((worst, window) => (window.usedPercent > worst.usedPercent ? window : worst));
}

export function normalizeProvider(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!value) return '';
  if (value === 'xai' || value === 'grok' || value === 'grok-build') return 'grok-build';
  if (value === 'kimi' || value === 'kimi-code') return 'kimi-code';
  if (value === 'gemini' || value === 'gemini-cli') return 'gemini-cli';
  return value;
}

function providerName(id: string): string {
  return PROVIDER_NAMES[id] ?? id.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function jsonFile(file: string): any | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function parseMaybeJson(body: unknown): Record<string, unknown> | null {
  if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  if (typeof body !== 'string' || !body.trim()) return null;
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function accountIdFromJwt(token: string): string | undefined {
  if (!token) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
    const auth = claims?.['https://api.openai.com/auth'];
    return firstString(claims?.chatgpt_account_id, auth?.chatgpt_account_id) || undefined;
  } catch {
    return undefined;
  }
}

function jwtExpMs(token: string): number {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
    return typeof claims.exp === 'number' ? claims.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function firstValue(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function numberOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return NaN;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}
