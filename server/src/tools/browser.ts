import Browserbase from '@browserbasehq/sdk';
import { createReadStream } from 'node:fs';
import { isIP } from 'node:net';
import { promises as dns } from 'node:dns';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import type { ToolCtx, ToolDef } from '../types.js';

const CONNECT_TIMEOUT_MS = 25_000;
const ACTION_TIMEOUT_MS = 30_000;
const SESSION_TIMEOUT_SECONDS = 5 * 60;

function positiveEnvInt(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function maxGlobalSessions() {
  return positiveEnvInt('RAUTML_BROWSER_CONCURRENCY', 2);
}

function maxBrowserCalls() {
  return positiveEnvInt('RAUTML_MAX_BROWSER_CALLS', 20);
}
const SNAPSHOT_TEXT_LIMIT = 8_000;
const MAX_ELEMENTS = 60;
const MAX_SEARCH_RESULTS = 8;
const MAX_WAIT_MS = 10_000;
const MAX_EXTRACT_CHARS = 24_000;
const MAX_UPLOAD_FILES = 5;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const REF_PATTERN = /^s\d{1,6}r\d{1,4}$/;
const MAX_TYPED_CHARS = 2_000;

interface BrowserElement {
  ref: string;
  role: string;
  name: string;
  value?: string;
  href?: string;
  checked?: boolean;
  disabled?: boolean;
}

interface BrowserSnapshot {
  url: string;
  title: string;
  text: string;
  elements: BrowserElement[];
}

export interface BrowserSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface BrowserImageResult {
  title: string;
  imageUrl: string;
  sourceUrl: string;
}

export interface BrowserDriver {
  navigate(url: string): Promise<BrowserSnapshot>;
  observe(): Promise<BrowserSnapshot>;
  click(ref: string): Promise<BrowserSnapshot>;
  fill(ref: string, value: string): Promise<BrowserSnapshot>;
  type(ref: string, value: string): Promise<BrowserSnapshot>;
  press(key: string, ref?: string): Promise<BrowserSnapshot>;
  select(ref: string, values: string[]): Promise<BrowserSnapshot>;
  setChecked(ref: string, checked: boolean): Promise<BrowserSnapshot>;
  hover(ref: string): Promise<BrowserSnapshot>;
  wait(ms: number): Promise<BrowserSnapshot>;
  history(direction: 'back' | 'forward' | 'reload'): Promise<BrowserSnapshot>;
  extract(ref?: string): Promise<string>;
  screenshot(file: string, fullPage: boolean): Promise<void>;
  upload(ref: string, files: string[]): Promise<BrowserSnapshot>;
  triggerDownload(ref: string): Promise<{ suggestedFilename: string; snapshot: BrowserSnapshot }>;
  tabs(): Promise<Array<{ index: number; active: boolean; title: string; url: string }>>;
  newTab(url?: string): Promise<BrowserSnapshot>;
  switchTab(index: number): Promise<BrowserSnapshot>;
  closeTab(index?: number): Promise<BrowserSnapshot | null>;
  search(query: string): Promise<BrowserSearchResult[]>;
  imageSearch(query: string): Promise<BrowserImageResult[]>;
  fetchPage(url: string): Promise<string>;
  close(): Promise<void>;
}

export interface BrowserConnection {
  driver: BrowserDriver;
  sessionId: string;
  prepareUploads(files: string[]): Promise<string[]>;
  saveDownloads(directory: string, suggestedFilename: string): Promise<string[]>;
  release(): Promise<void>;
}

export type BrowserConnector = (ctx: ToolCtx) => Promise<BrowserConnection>;

interface ManagedSession {
  connection: BrowserConnection;
  signal?: AbortSignal;
  abortListener?: () => void;
}

function truncate(text: string, limit: number) {
  const clean = text.replace(/\u0000/g, '').trim();
  if (clean.length <= limit) return clean;
  const half = Math.floor(limit / 2);
  return `${clean.slice(0, half)}\n[…truncated…]\n${clean.slice(-half)}`;
}

function credentials() {
  return {
    apiKey: (process.env.BROWSERBASE_API_KEY || '').trim(),
    projectId: (process.env.BROWSERBASE_PROJECT_ID || '').trim(),
  };
}

export function browserbaseConfigured() {
  const { apiKey, projectId } = credentials();
  return Boolean(apiKey && projectId);
}

function isPrivateIPv4(host: string) {
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    a! >= 224
  );
}

function isPrivateIPv6(host: string) {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === '::' || normalized === '::1') return true;
  if (/^(fc|fd)/.test(normalized) || /^fe[89ab]/.test(normalized)) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)?.[1];
  return mapped ? isPrivateIPv4(mapped) : false;
}

/** Reject schemes and literal destinations that a remote research browser never needs. */
export function validatePublicBrowserUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Expected an absolute http(s) URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http(s) URLs can be opened.');
  }
  if (url.username || url.password) throw new Error('URLs containing credentials are not allowed.');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal'
  ) {
    throw new Error('Local and private network destinations are not allowed.');
  }
  const kind = isIP(host);
  if ((kind === 4 && isPrivateIPv4(host)) || (kind === 6 && isPrivateIPv6(host))) {
    throw new Error('Local and private network destinations are not allowed.');
  }
  return url.toString();
}

export async function validatePublicFetchUrl(raw: string) {
  const safeUrl = validatePublicBrowserUrl(raw);
  const host = new URL(safeUrl).hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return safeUrl;
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`Could not resolve ${host}.`);
  }
  if (!addresses.length) throw new Error(`Could not resolve ${host}.`);
  if (addresses.some(({ address, family }) =>
    (family === 4 && isPrivateIPv4(address)) || (family === 6 && isPrivateIPv6(address)))) {
    throw new Error('Local and private network destinations are not allowed.');
  }
  return safeUrl;
}

async function isBlockedRequestUrl(raw: string) {
  if (/^(about:|data:|blob:)/i.test(raw)) return false;
  try {
    await validatePublicFetchUrl(raw);
    return false;
  } catch {
    return true;
  }
}

/** Read a zip entry, aborting decompression as soon as the expanded bytes exceed maxBytes. */
function readZipEntryLimited(entry: JSZip.JSZipObject, maxBytes: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const stream = entry.nodeStream() as NodeJS.ReadableStream & { destroy(): void };
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        stream.destroy();
        reject(new Error('Browser downloads exceeded the 100 MB limit.'));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    stream.on('error', reject);
  });
}

function safeWorkspacePath(workspaceDir: string, relativePath: string) {
  const root = path.resolve(workspaceDir);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('Browser file paths must stay inside the chat workspace.');
  }
  return resolved;
}

function safeBrowserError(error: unknown) {
  const status = error instanceof Browserbase.APIError ? error.status : undefined;
  const raw = error instanceof Error ? error.message : String(error);
  const sanitized = raw
    .replace(/wss?:\/\/[^\s)]+/gi, '[Browserbase connection URL]')
    .replace(/([?&](?:apiKey|signingKey|token)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi, '$1[redacted]');
  return `${status ? `HTTP ${status}: ` : ''}${truncate(sanitized, 500)}`;
}

function safeFileName(value: string) {
  const cleaned = path.basename(value).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || `download-${Date.now()}`;
}

function formatSnapshot(snapshot: BrowserSnapshot) {
  const lines = [
    `URL: ${snapshot.url}`,
    `Title: ${snapshot.title || '(untitled)'}`,
    '',
    'Page text:',
    snapshot.text || '(no visible text)',
  ];
  if (snapshot.elements.length) {
    lines.push('', 'Interactive elements:');
    for (const item of snapshot.elements) {
      const details = [
        `[${item.ref}] ${item.role}`,
        item.name ? JSON.stringify(item.name) : '',
        item.value ? `value=${JSON.stringify(item.value)}` : '',
        item.href ? `href=${item.href}` : '',
        item.checked !== undefined ? `checked=${item.checked}` : '',
        item.disabled ? 'disabled' : '',
      ].filter(Boolean);
      lines.push(details.join(' '));
    }
  }
  return `<untrusted_web_content>\n${truncate(lines.join('\n'), SNAPSHOT_TEXT_LIMIT + 6_000)}\n</untrusted_web_content>`;
}

class PlaywrightBrowserDriver implements BrowserDriver {
  private page: Page;
  private pageSetup = new WeakMap<Page, Promise<void>>();
  private snapshotGeneration = 0;

  constructor(
    private browser: Browser,
    private context: BrowserContext,
  ) {
    this.page = context.pages()[0]!;
    void this.configurePage(this.page);
    context.on('page', (page) => void this.configurePage(page));
  }

  private configurePage(page: Page) {
    const existing = this.pageSetup.get(page);
    if (existing) return existing;
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(ACTION_TIMEOUT_MS);
    const setup = page.route('**/*', async (route) => {
      if (await isBlockedRequestUrl(route.request().url())) await route.abort('blockedbyclient');
      else await route.continue();
    }).then(() => undefined);
    this.pageSetup.set(page, setup);
    return setup;
  }

  private currentPage() {
    if (!this.page.isClosed()) return this.page;
    const page = this.context.pages().find((candidate) => !candidate.isClosed());
    if (!page) throw new Error('The browser has no open tab. Navigate to a URL to open one.');
    this.page = page;
    return page;
  }

  private async settle(page = this.currentPage()) {
    await this.configurePage(page);
    await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(250);
    if (/^https?:/i.test(page.url())) await validatePublicFetchUrl(page.url());
  }

  private locator(ref: string) {
    if (!REF_PATTERN.test(ref)) throw new Error('Use a current element ref such as s2r3.');
    const generation = Number(/^s(\d+)r/.exec(ref)?.[1]);
    if (generation !== this.snapshotGeneration) {
      throw new Error(`Element ${ref} came from an older page observation. Use a ref from the latest result.`);
    }
    return this.currentPage().locator(`[data-rautml-ref="${ref}"]`).first();
  }

  private async requireLocator(ref: string) {
    const locator = this.locator(ref);
    if ((await locator.count()) === 0) {
      throw new Error(`Element ${ref} is no longer on the page. Observe the page again for current refs.`);
    }
    return locator;
  }

  private async snapshot(page = this.currentPage()) {
    await this.settle(page);
    const generation = ++this.snapshotGeneration;
    const data = await page.evaluate(({ maxElements, generation }) => {
      for (const element of document.querySelectorAll('[data-rautml-ref]')) {
        element.removeAttribute('data-rautml-ref');
      }
      const selector = [
        'a[href]',
        'button',
        'input',
        'textarea',
        'select',
        '[contenteditable="true"]',
        '[role="button"]',
        '[role="link"]',
        '[role="textbox"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[role="combobox"]',
        '[role="tab"]',
        '[role="menuitem"]',
      ].join(',');
      const elements: BrowserElement[] = [];
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(selector));
      for (const element of candidates) {
        if (elements.length >= maxElements) break;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          Number(style.opacity) === 0 ||
          rect.width < 1 ||
          rect.height < 1
        ) continue;
        const ref = `s${generation}r${elements.length + 1}`;
        element.setAttribute('data-rautml-ref', ref);
        const input = element instanceof HTMLInputElement ? element : null;
        const select = element instanceof HTMLSelectElement ? element : null;
        const explicitRole = element.getAttribute('role');
        const role = explicitRole ||
          (element instanceof HTMLAnchorElement ? 'link' :
            element instanceof HTMLButtonElement ? 'button' :
              select ? 'combobox' :
                input?.type === 'checkbox' ? 'checkbox' :
                  input?.type === 'radio' ? 'radio' :
                    element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? 'textbox' :
                      element.isContentEditable ? 'textbox' : element.tagName.toLowerCase());
        const labelledBy = element.getAttribute('aria-labelledby');
        const labelledText = labelledBy
          ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ')
          : '';
        const label = 'labels' in element && element.labels
          ? Array.from(element.labels as NodeListOf<HTMLLabelElement>).map((item) => item.innerText).join(' ')
          : '';
        const name = (
          element.getAttribute('aria-label') ||
          labelledText ||
          label ||
          element.getAttribute('title') ||
          element.getAttribute('placeholder') ||
          element.innerText ||
          input?.value ||
          select?.selectedOptions[0]?.text ||
          ''
        ).replace(/\s+/g, ' ').trim().slice(0, 240);
        const value = input?.type === 'password'
          ? undefined
          : input?.value || (element instanceof HTMLTextAreaElement ? element.value : select?.value || undefined);
        elements.push({
          ref,
          role,
          name,
          value: value?.slice(0, 240),
          href: element instanceof HTMLAnchorElement ? element.href : undefined,
          checked: input && (input.type === 'checkbox' || input.type === 'radio') ? input.checked : undefined,
          disabled: 'disabled' in element ? Boolean((element as HTMLInputElement).disabled) : undefined,
        });
      }
      return {
        url: location.href,
        title: document.title,
        text: (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n'),
        elements,
      } satisfies BrowserSnapshot;
    }, { maxElements: MAX_ELEMENTS, generation });
    return { ...data, text: truncate(data.text, SNAPSHOT_TEXT_LIMIT) };
  }

  async navigate(url: string) {
    const safeUrl = await validatePublicFetchUrl(url);
    let page = this.context.pages().find((candidate) => !candidate.isClosed());
    if (!page) {
      page = await this.context.newPage();
      await this.configurePage(page);
    }
    this.page = page;
    await page.goto(safeUrl, { waitUntil: 'domcontentloaded' });
    return this.snapshot(page);
  }

  observe() {
    return this.snapshot();
  }

  async click(ref: string) {
    const locator = await this.requireLocator(ref);
    const before = new Set(this.context.pages());
    await locator.click();
    await this.currentPage().waitForTimeout(250);
    const opened = this.context.pages().find((page) => !before.has(page) && !page.isClosed());
    if (opened) this.page = opened;
    return this.snapshot();
  }

  private async rejectPasswordField(ref: string) {
    const locator = await this.requireLocator(ref);
    const password = await locator.evaluate((element) =>
      element instanceof HTMLInputElement && element.type.toLowerCase() === 'password');
    if (password) throw new Error('Rautml does not enter password fields. Use a public page instead.');
    return locator;
  }

  async fill(ref: string, value: string) {
    await (await this.rejectPasswordField(ref)).fill(value);
    return this.snapshot();
  }

  async type(ref: string, value: string) {
    if (value.length > MAX_TYPED_CHARS) throw new Error(`type is limited to ${MAX_TYPED_CHARS} characters; use fill for longer text.`);
    await (await this.rejectPasswordField(ref)).pressSequentially(value, { delay: 10 });
    return this.snapshot();
  }

  async press(key: string, ref?: string) {
    if (!key.trim()) throw new Error('A key is required, for example Enter or Control+A.');
    if (ref) await (await this.requireLocator(ref)).press(key);
    else await this.currentPage().keyboard.press(key);
    return this.snapshot();
  }

  async select(ref: string, values: string[]) {
    if (!values.length) throw new Error('At least one option value is required.');
    await (await this.requireLocator(ref)).selectOption(values);
    return this.snapshot();
  }

  async setChecked(ref: string, checked: boolean) {
    await (await this.requireLocator(ref)).setChecked(checked);
    return this.snapshot();
  }

  async hover(ref: string) {
    await (await this.requireLocator(ref)).hover();
    return this.snapshot();
  }

  async wait(ms: number) {
    await this.currentPage().waitForTimeout(Math.max(0, Math.min(MAX_WAIT_MS, ms)));
    return this.snapshot();
  }

  async history(direction: 'back' | 'forward' | 'reload') {
    const page = this.currentPage();
    if (direction === 'back') await page.goBack({ waitUntil: 'domcontentloaded' });
    else if (direction === 'forward') await page.goForward({ waitUntil: 'domcontentloaded' });
    else await page.reload({ waitUntil: 'domcontentloaded' });
    return this.snapshot(page);
  }

  async extract(ref?: string) {
    if (!ref) return truncate(await this.currentPage().locator('body').innerText(), MAX_EXTRACT_CHARS);
    return truncate(await (await this.requireLocator(ref)).innerText(), MAX_EXTRACT_CHARS);
  }

  async screenshot(file: string, fullPage: boolean) {
    await this.currentPage().screenshot({ path: file, fullPage });
  }

  async upload(ref: string, files: string[]) {
    const locator = await this.requireLocator(ref);
    await locator.evaluate((element) => element.setAttribute('data-rautml-upload-target', 'true'));
    const cdp = await this.context.newCDPSession(this.currentPage());
    try {
      const document = await cdp.send('DOM.getDocument');
      const target = await cdp.send('DOM.querySelector', {
        nodeId: document.root.nodeId,
        selector: '[data-rautml-upload-target="true"]',
      });
      if (!target.nodeId) throw new Error(`Upload element ${ref} is no longer on the page.`);
      await cdp.send('DOM.setFileInputFiles', { files, nodeId: target.nodeId });
    } finally {
      await locator.evaluate((element) => element.removeAttribute('data-rautml-upload-target')).catch(() => {});
      await cdp.detach().catch(() => {});
    }
    return this.snapshot();
  }

  async triggerDownload(ref: string) {
    const page = this.currentPage();
    const cdp = await this.context.newCDPSession(page);
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: 'downloads',
      eventsEnabled: true,
    });
    const downloadPromise = page.waitForEvent('download', { timeout: ACTION_TIMEOUT_MS });
    await (await this.requireLocator(ref)).click();
    const download = await downloadPromise;
    const failure = await download.failure();
    await cdp.detach().catch(() => {});
    if (failure) throw new Error(`Browser download failed: ${failure}`);
    return { suggestedFilename: download.suggestedFilename(), snapshot: await this.snapshot() };
  }

  async tabs() {
    const pages = this.context.pages().filter((page) => !page.isClosed());
    return Promise.all(pages.map(async (page, index) => ({
      index,
      active: page === this.page,
      title: await page.title().catch(() => ''),
      url: page.url(),
    })));
  }

  async newTab(url?: string) {
    const page = await this.context.newPage();
    await this.configurePage(page);
    this.page = page;
    if (url) await page.goto(await validatePublicFetchUrl(url), { waitUntil: 'domcontentloaded' });
    return this.snapshot(page);
  }

  async switchTab(index: number) {
    const pages = this.context.pages().filter((page) => !page.isClosed());
    const page = pages[index];
    if (!page) throw new Error(`Tab ${index} does not exist.`);
    this.page = page;
    await page.bringToFront();
    return this.snapshot(page);
  }

  async closeTab(index?: number) {
    const pages = this.context.pages().filter((page) => !page.isClosed());
    const target = index === undefined ? this.currentPage() : pages[index];
    if (!target) throw new Error(`Tab ${index} does not exist.`);
    await target.close();
    const remaining = this.context.pages().filter((page) => !page.isClosed());
    if (!remaining.length) return null;
    this.page = remaining[Math.min(index ?? 0, remaining.length - 1)]!;
    return this.snapshot();
  }

  private async temporaryPage<T>(run: (page: Page) => Promise<T>) {
    const page = await this.context.newPage();
    await this.configurePage(page);
    try {
      return await run(page);
    } finally {
      await page.close().catch(() => {});
    }
  }

  async search(query: string) {
    return this.temporaryPage(async (page) => {
      const engines = [
        `https://www.google.com/search?hl=en&num=10&q=${encodeURIComponent(query)}`,
        `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
      ];
      for (const url of engines) {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await this.settle(page);
        const results = await page.evaluate((limit) => {
          const output: BrowserSearchResult[] = [];
          const seen = new Set<string>();
          const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));
          for (const anchor of anchors) {
            const heading = anchor.querySelector('h2, h3');
            const title = (heading?.textContent || '').replace(/\s+/g, ' ').trim();
            if (!title || !/^https?:/i.test(anchor.href)) continue;
            let host = '';
            try { host = new URL(anchor.href).hostname; } catch { continue; }
            if (/google\.|bing\.|gstatic\.|microsoft\./i.test(host) || seen.has(anchor.href)) continue;
            seen.add(anchor.href);
            const container = anchor.closest('li, article, [data-snhf], [class*="result"]') || anchor.parentElement?.parentElement;
            const text = (container?.textContent || '').replace(/\s+/g, ' ').trim();
            output.push({ title, url: anchor.href, snippet: text.replace(title, '').trim().slice(0, 500) });
            if (output.length >= limit) break;
          }
          return output;
        }, MAX_SEARCH_RESULTS);
        if (results.length) return results;
      }
      return [];
    });
  }

  async imageSearch(query: string) {
    return this.temporaryPage(async (page) => {
      await page.goto(`https://www.bing.com/images/search?q=${encodeURIComponent(query)}`, {
        waitUntil: 'domcontentloaded',
      });
      await this.settle(page);
      return page.evaluate((limit) => {
        const output: BrowserImageResult[] = [];
        const seen = new Set<string>();
        for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a.iusc, a[m]')) {
          let metadata: Record<string, unknown> = {};
          try { metadata = JSON.parse(anchor.getAttribute('m') || '{}'); } catch { continue; }
          const imageUrl = typeof metadata.murl === 'string' ? metadata.murl : '';
          const sourceUrl = typeof metadata.purl === 'string' ? metadata.purl : anchor.href;
          const title = typeof metadata.t === 'string'
            ? metadata.t
            : anchor.getAttribute('aria-label') || anchor.querySelector('img')?.alt || '(no title)';
          if (!/^https?:/i.test(imageUrl) || seen.has(imageUrl)) continue;
          seen.add(imageUrl);
          output.push({ title: title.slice(0, 300), imageUrl, sourceUrl });
          if (output.length >= limit) break;
        }
        return output;
      }, MAX_SEARCH_RESULTS);
    });
  }

  async fetchPage(url: string) {
    const safeUrl = await validatePublicFetchUrl(url);
    return this.temporaryPage(async (page) => {
      await page.goto(safeUrl, { waitUntil: 'domcontentloaded' });
      await this.settle(page);
      const data = await page.evaluate(() => {
        const root = document.querySelector('main, article') || document.body;
        const text = ((root as HTMLElement | null)?.innerText || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
        const links = Array.from(root?.querySelectorAll<HTMLAnchorElement>('a[href]') || [])
          .map((anchor) => ({ label: (anchor.textContent || '').replace(/\s+/g, ' ').trim(), url: anchor.href }))
          .filter((item) => item.label && /^https?:/i.test(item.url))
          .slice(0, 40);
        return { title: document.title, url: location.href, text, links };
      });
      const links = data.links.length
        ? `\n\nLinks:\n${data.links.map((link) => `- ${link.label}: ${link.url}`).join('\n')}`
        : '';
      return truncate(`# ${data.title || data.url}\n\n${data.text}${links}`, MAX_EXTRACT_CHARS);
    });
  }

  async close() {
    await this.browser.close().catch(() => {});
  }
}

async function withDeadline<T>(promise: Promise<T>, ms: number, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function connectBrowserbase(ctx: ToolCtx): Promise<BrowserConnection> {
  const { apiKey, projectId } = credentials();
  if (!apiKey || !projectId) {
    throw new Error('Browserbase needs both BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID in Settings → API keys.');
  }
  if (ctx.signal?.aborted) throw Object.assign(new Error('Run stopped'), { name: 'AbortError' });

  const client = new Browserbase({ apiKey, timeout: 15_000, maxRetries: 1 });
  let session: Browserbase.SessionCreateResponse;
  try {
    session = await client.sessions.create({
      projectId,
      keepAlive: false,
      api_timeout: SESSION_TIMEOUT_SECONDS,
      browserSettings: { blockAds: true },
      userMetadata: { rautmlRunId: ctx.runId, rautmlChatId: ctx.chatId },
    }, { signal: ctx.signal });
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'APIUserAbortError')) throw error;
    throw new Error(`Could not create Browserbase session: ${safeBrowserError(error)}`);
  }
  let browser: Browser | undefined;
  let abortConnect: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    if (!ctx.signal) return;
    abortConnect = () => {
      void browser?.close().catch(() => {});
      void client.sessions.update(session.id, { status: 'REQUEST_RELEASE', projectId }, {
        timeout: 5_000,
        maxRetries: 0,
      }).catch(() => {});
      reject(Object.assign(new Error('Run stopped'), { name: 'AbortError' }));
    };
    if (ctx.signal.aborted) abortConnect();
    else ctx.signal.addEventListener('abort', abortConnect, { once: true });
  });
  try {
    browser = await Promise.race([
      chromium.connectOverCDP(session.connectUrl, { timeout: CONNECT_TIMEOUT_MS }),
      aborted,
    ]);
    if (abortConnect) ctx.signal?.removeEventListener('abort', abortConnect);
    const context = browser.contexts()[0];
    if (!context) throw new Error('Browserbase session opened without a browser context.');
    if (!context.pages().length) await context.newPage();
    const driver = new PlaywrightBrowserDriver(browser, context);
    const prepareUploads = async (files: string[]) => {
      for (const file of files) {
        await client.sessions.uploads.create(session.id, { file: createReadStream(file) }, {
          timeout: ACTION_TIMEOUT_MS,
          maxRetries: 1,
          signal: ctx.signal,
        });
      }
      return files.map((file) => `/tmp/.uploads/${path.basename(file)}`);
    };
    const saveDownloads = async (directory: string, suggestedFilename: string) => {
      const deadline = Date.now() + 20_000;
      let lastError: unknown;
      while (Date.now() < deadline) {
        if (ctx.signal?.aborted) throw Object.assign(new Error('Run stopped'), { name: 'AbortError' });
        try {
          const response = await client.sessions.downloads.list(session.id, {
            timeout: ACTION_TIMEOUT_MS,
            maxRetries: 1,
            signal: ctx.signal,
          });
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new Error('Browser downloads exceeded the 100 MB limit.');
          const archive = await JSZip.loadAsync(bytes);
          const entries = Object.values(archive.files).filter((entry) => !entry.dir);
          if (entries.length) {
            const files: string[] = [];
            let totalBytes = 0;
            for (const entry of entries) {
              const content = await readZipEntryLimited(entry, MAX_DOWNLOAD_BYTES - totalBytes);
              totalBytes += content.byteLength;
              const preferred = files.length === 0 ? suggestedFilename : entry.name;
              const file = path.join(directory, `${Date.now()}-${safeFileName(preferred)}`);
              await writeFile(file, content, { mode: 0o600 });
              files.push(file);
            }
            return files;
          }
        } catch (error) {
          if (ctx.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
          lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
      throw new Error(`Browserbase did not finish syncing the download: ${safeBrowserError(lastError)}`);
    };
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await withDeadline(driver.close(), 5_000, 'Browser disconnect').catch(() => {});
      await client.sessions.update(session.id, { status: 'REQUEST_RELEASE', projectId }, {
        timeout: 5_000,
        maxRetries: 0,
      }).catch(() => {});
    };
    return { driver, sessionId: session.id, prepareUploads, saveDownloads, release };
  } catch (error) {
    if (abortConnect) ctx.signal?.removeEventListener('abort', abortConnect);
    await browser?.close().catch(() => {});
    await client.sessions.update(session.id, { status: 'REQUEST_RELEASE', projectId }, {
      timeout: 5_000,
      maxRetries: 0,
    }).catch(() => {});
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'APIUserAbortError')) throw error;
    throw new Error(`Could not start Browserbase: ${safeBrowserError(error)}`);
  }
}

export class BrowserService {
  private sessions = new Map<string, Promise<ManagedSession>>();
  private calls = new Map<string, number>();

  constructor(private connector: BrowserConnector = connectBrowserbase) {}

  private async start(ctx: ToolCtx) {
    const connection = await this.connector(ctx);
    const managed: ManagedSession = { connection };
    if (ctx.signal) {
      const abortListener = () => void this.close(ctx.runId);
      ctx.signal.addEventListener('abort', abortListener, { once: true });
      managed.signal = ctx.signal;
      managed.abortListener = abortListener;
    }
    return managed;
  }

  async get(ctx: ToolCtx) {
    if (ctx.signal?.aborted) throw Object.assign(new Error('Run stopped'), { name: 'AbortError' });
    const calls = (this.calls.get(ctx.runId) ?? 0) + 1;
    this.calls.set(ctx.runId, calls);
    if (calls > maxBrowserCalls()) {
      await this.close(ctx.runId);
      throw new Error(`The browser budget for this run is spent (${maxBrowserCalls()} calls). Use web_fetch or web_search.`);
    }
    let pending = this.sessions.get(ctx.runId);
    if (!pending) {
      if (this.sessions.size >= maxGlobalSessions()) {
        throw new Error(`Browserbase is busy (${maxGlobalSessions()} sessions are already active). Try web_fetch or retry shortly.`);
      }
      pending = this.start(ctx);
      this.sessions.set(ctx.runId, pending);
      void pending.catch(() => {
        if (this.sessions.get(ctx.runId) === pending) this.sessions.delete(ctx.runId);
      });
    }
    const managed = await pending;
    if (ctx.signal?.aborted) {
      await this.close(ctx.runId);
      throw Object.assign(new Error('Run stopped'), { name: 'AbortError' });
    }
    return managed.connection;
  }

  async close(runId: string) {
    const pending = this.sessions.get(runId);
    if (!pending) return;
    this.sessions.delete(runId);
    try {
      const managed = await pending;
      if (managed.signal && managed.abortListener) {
        managed.signal.removeEventListener('abort', managed.abortListener);
      }
      await managed.connection.release();
    } catch {
      // A failed startup has no usable session to release here.
    }
  }

  async finish(runId: string) {
    await this.close(runId);
    this.calls.delete(runId);
  }

  async closeAll() {
    await Promise.all([...this.sessions.keys()].map((runId) => this.finish(runId)));
    this.calls.clear();
  }

  async search(query: string, ctx: ToolCtx) {
    return (await this.get(ctx)).driver.search(query);
  }

  async imageSearch(query: string, ctx: ToolCtx) {
    return (await this.get(ctx)).driver.imageSearch(query);
  }

  async fetchPage(url: string, ctx: ToolCtx) {
    return (await this.get(ctx)).driver.fetchPage(url);
  }
}

export const browserService = new BrowserService();

export function cleanupBrowserSession(runId: string) {
  return browserService.finish(runId);
}

export function cleanupAllBrowserSessions() {
  return browserService.closeAll();
}

interface BrowserArgs {
  action: 'navigate' | 'observe' | 'click' | 'fill' | 'type' | 'press' | 'select' | 'check' | 'uncheck' |
    'hover' | 'scroll' | 'wait' | 'back' | 'forward' | 'reload' | 'extract' | 'screenshot' | 'upload' | 'download' |
    'tabs' | 'new_tab' | 'switch_tab' | 'close_tab' | 'close';
  url?: string;
  ref?: string;
  value?: string;
  values?: string[];
  key?: string;
  durationMs?: number;
  direction?: 'up' | 'down';
  amount?: number;
  path?: string;
  paths?: string[];
  fullPage?: boolean;
  tabIndex?: number;
}

export function createBrowserTools(service = browserService): ToolDef[] {
  const browser: ToolDef = {
    name: 'browser',
    description:
      'Use a real Browserbase browser for rendered JavaScript, clicking, forms, authentication flows, tabs, uploads/downloads, or pages web_fetch cannot read. One browser session is reused for this run and released automatically. Start with navigate; every result includes snapshot-scoped element refs like s2r3. Only use refs from the latest result. Prefer fill for text; type emulates keystrokes and is for short input. Never enter secrets unless the user explicitly supplied them for this task.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['navigate', 'observe', 'click', 'fill', 'type', 'press', 'select', 'check', 'uncheck', 'hover', 'scroll', 'wait', 'back', 'forward', 'reload', 'extract', 'screenshot', 'upload', 'download', 'tabs', 'new_tab', 'switch_tab', 'close_tab', 'close'],
          description: 'Browser operation to perform.',
        },
        url: { type: 'string', description: 'Absolute http(s) URL for navigate.' },
        ref: { type: 'string', description: 'Current element ref from the latest observe/navigate result, such as s2r3.' },
        value: { type: 'string', description: 'Text for fill/type or a single select value.' },
        values: { type: 'array', items: { type: 'string' }, description: 'Option values for a multi-select.' },
        key: { type: 'string', description: 'Keyboard key/chord for press, such as Enter or Control+A.' },
        durationMs: { type: 'number', description: 'Wait duration, capped at 10000 ms.' },
        direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction.' },
        amount: { type: 'number', description: 'Scroll distance in CSS pixels; defaults to 700 and is capped at 5000.' },
        path: { type: 'string', description: 'Workspace-relative screenshot path.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative files for upload.' },
        fullPage: { type: 'boolean', description: 'Capture the full page for screenshot.' },
        tabIndex: { type: 'number', description: 'Zero-based tab index for switch_tab/close_tab.' },
      },
      required: ['action'],
    },
    async execute(args: BrowserArgs, ctx: ToolCtx) {
      if (args.action === 'close') {
        await service.close(ctx.runId);
        return 'Browser session closed.';
      }
      const connection = await service.get(ctx);
      const driver = connection.driver;
      const ref = () => {
        if (!args.ref) throw new Error(`${args.action} requires an element ref from the latest page observation.`);
        return args.ref;
      };
      let snapshot: BrowserSnapshot | null = null;
      switch (args.action) {
        case 'navigate':
          if (!args.url) throw new Error('navigate requires url.');
          snapshot = await driver.navigate(args.url);
          break;
        case 'observe': snapshot = await driver.observe(); break;
        case 'click': snapshot = await driver.click(ref()); break;
        case 'fill': snapshot = await driver.fill(ref(), args.value ?? ''); break;
        case 'type': snapshot = await driver.type(ref(), args.value ?? ''); break;
        case 'press': snapshot = await driver.press(args.key ?? '', args.ref); break;
        case 'select': snapshot = await driver.select(ref(), args.values ?? (args.value === undefined ? [] : [args.value])); break;
        case 'check': snapshot = await driver.setChecked(ref(), true); break;
        case 'uncheck': snapshot = await driver.setChecked(ref(), false); break;
        case 'hover': snapshot = await driver.hover(ref()); break;
        case 'scroll': {
          const amount = Math.max(1, Math.min(5_000, args.amount ?? 700));
          await driver.press(args.direction === 'up' ? 'PageUp' : 'PageDown');
          if (amount !== 700) {
            // PageUp/PageDown provides a safe default; repeated presses cover
            // larger requests without exposing arbitrary page JavaScript.
            for (let moved = 700; moved < amount; moved += 700) {
              await driver.press(args.direction === 'up' ? 'PageUp' : 'PageDown');
            }
          }
          snapshot = await driver.observe();
          break;
        }
        case 'wait': snapshot = await driver.wait(args.durationMs ?? 1_000); break;
        case 'back': case 'forward': case 'reload': snapshot = await driver.history(args.action); break;
        case 'extract': return `<untrusted_web_content>\n${await driver.extract(args.ref)}\n</untrusted_web_content>`;
        case 'screenshot': {
          const relative = args.path || `browser/screenshot-${Date.now()}.png`;
          const file = safeWorkspacePath(ctx.workspaceDir, relative);
          await mkdir(path.dirname(file), { recursive: true });
          await driver.screenshot(file, args.fullPage ?? true);
          return `Screenshot saved to ${path.relative(ctx.workspaceDir, file)}.`;
        }
        case 'upload': {
          if (!args.paths?.length) throw new Error('upload requires one or more workspace-relative paths.');
          if (args.paths.length > MAX_UPLOAD_FILES) throw new Error(`Upload is limited to ${MAX_UPLOAD_FILES} files at once.`);
          const files = args.paths.map((file) => safeWorkspacePath(ctx.workspaceDir, file));
          const basenames = files.map((file) => path.basename(file));
          if (new Set(basenames).size !== basenames.length) {
            throw new Error('Uploaded files must have unique filenames.');
          }
          for (const file of files) {
            const info = await stat(file).catch(() => null);
            if (!info?.isFile()) throw new Error(`Upload file does not exist: ${path.relative(ctx.workspaceDir, file)}`);
            if (info.size > MAX_UPLOAD_BYTES) throw new Error(`Upload file exceeds 50 MB: ${path.relative(ctx.workspaceDir, file)}`);
          }
          const remoteFiles = await connection.prepareUploads(files);
          snapshot = await driver.upload(ref(), remoteFiles);
          break;
        }
        case 'download': {
          const directory = safeWorkspacePath(ctx.workspaceDir, 'downloads');
          await mkdir(directory, { recursive: true });
          const result = await driver.triggerDownload(ref());
          const files = await connection.saveDownloads(directory, result.suggestedFilename);
          return `Downloaded to ${files.map((file) => path.relative(ctx.workspaceDir, file)).join(', ')}.\n\n${formatSnapshot(result.snapshot)}`;
        }
        case 'tabs': {
          const tabs = await driver.tabs();
          return tabs.length
            ? tabs.map((tab) => `${tab.active ? '*' : ' '} [${tab.index}] ${tab.title || '(untitled)'} — ${tab.url}`).join('\n')
            : 'No open tabs.';
        }
        case 'new_tab': snapshot = await driver.newTab(args.url); break;
        case 'switch_tab': snapshot = await driver.switchTab(args.tabIndex ?? -1); break;
        case 'close_tab': snapshot = await driver.closeTab(args.tabIndex); break;
        default: throw new Error(`Unsupported browser action: ${String(args.action)}`);
      }
      return snapshot ? formatSnapshot(snapshot) : 'No open tabs.';
    },
  };
  return [browser];
}

export const browserTools = createBrowserTools();
