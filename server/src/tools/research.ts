import type { ToolCtx, ToolDef } from '../types.js';
import {
  browserbaseConfigured,
  browserService,
  validatePublicFetchUrl,
  type BrowserImageResult,
  type BrowserSearchResult,
} from './browser.js';

const FIRECRAWL_SEARCH_URL = 'https://api.firecrawl.dev/v1/search';
const FIRECRAWL_SCRAPE_URL = 'https://api.firecrawl.dev/v1/scrape';
// v1/search's schema does not accept a `sources` param (hard 400: unrecognized_keys).
// v2/search supports `sources:["images"]` and returns data.images[]; used for image_search only.
const FIRECRAWL_SEARCH_V2_URL = 'https://api.firecrawl.dev/v2/search';
const TIMEOUT_MS = 30_000;
const FETCH_TRUNCATE_CHARS = 24_000;
const DIRECT_FETCH_MAX_BYTES = 2 * 1024 * 1024;

function firecrawlKey() {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) throw new Error('FIRECRAWL_API_KEY is not set');
  return key;
}

function truncate(text: string, max: number) {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n[…truncated…]\n${text.slice(text.length - half)}`;
}

function stripHtml(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Combine the 30s request cap with run cancellation. */
function fetchSignal(ctx: ToolCtx) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
}

async function publicFetch(rawUrl: string, ctx: ToolCtx) {
  let url = await validatePublicFetchUrl(rawUrl);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetch(url, { signal: fetchSignal(ctx), redirect: 'manual' });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get('location');
    if (!location) throw new Error(`redirect ${response.status} had no location`);
    if (redirects === 5) throw new Error('too many redirects');
    url = await validatePublicFetchUrl(new URL(location, url).toString());
  }
  throw new Error('too many redirects');
}

async function responseTextLimited(response: Response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > DIRECT_FETCH_MAX_BYTES) throw new Error('response exceeded the 2 MB direct-fetch limit');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function firecrawlPost(url: string, body: object, signal: AbortSignal): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${firecrawlKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Firecrawl ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
  }
  return res.json();
}

function formatSearchResults(results: BrowserSearchResult[]) {
  return results.slice(0, 8).map((result, index) =>
    `${index + 1}. ${result.title || '(no title)'}\n   ${result.url}\n   ${result.snippet}`,
  ).join('\n');
}

function formatImageResults(results: BrowserImageResult[]) {
  return results.slice(0, 8).map((result, index) =>
    `${index + 1}. ${result.title || '(no title)'}\n   imageUrl: ${result.imageUrl}\n   sourceUrl: ${result.sourceUrl}`,
  ).join('\n');
}

export function wrapUntrustedWebContent(content: string) {
  return `<untrusted_web_content>\n${content}\n</untrusted_web_content>`;
}

function browserFallbackAllowed(ctx: ToolCtx) {
  return ctx.allowBrowserFallback !== false && browserbaseConfigured();
}

function browserFallbackHint(ctx: ToolCtx) {
  return ctx.allowBrowserFallback === false
    ? 'Browserbase fallback is reserved for the lead agent.'
    : 'Add Browserbase credentials in Settings → API keys to enable browser fallback.';
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function rethrowAbort(error: unknown, ctx: ToolCtx) {
  if (ctx.signal?.aborted ||
      (error instanceof Error && (error.name === 'AbortError' || error.name === 'APIUserAbortError'))) {
    throw error;
  }
}

const web_search: ToolDef = {
  name: 'web_search',
  description:
    'Search the web for a query. Returns top 8 results as title / URL / snippet. Automatically uses a real Browserbase browser when Firecrawl is unavailable.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
    },
    required: ['query'],
  },
  async execute(args: { query: string }, ctx: ToolCtx) {
    try {
      const data = await firecrawlPost(
        FIRECRAWL_SEARCH_URL,
        { query: args.query, limit: 8 },
        fetchSignal(ctx),
      );
      const results: any[] = data?.data?.web ?? data?.data ?? [];
      if (!Array.isArray(results) || results.length === 0) return 'No results found.';
      return wrapUntrustedWebContent(results.slice(0, 8).map((result, index) => {
        const title = result.title ?? '(no title)';
        const url = result.url ?? result.link ?? '';
        const snippet = result.description ?? result.snippet ?? '';
        return `${index + 1}. ${title}\n   ${url}\n   ${snippet}`;
      }).join('\n'));
    } catch (firecrawlError) {
      rethrowAbort(firecrawlError, ctx);
      if (browserFallbackAllowed(ctx)) {
        try {
          const results = await browserService.search(args.query, ctx);
          return results.length ? wrapUntrustedWebContent(formatSearchResults(results)) : 'No results found.';
        } catch (browserError) {
          rethrowAbort(browserError, ctx);
          return `ERROR: Firecrawl failed (${errorMessage(firecrawlError)}); Browserbase fallback failed (${errorMessage(browserError)}).`;
        }
      }
      return `ERROR: ${errorMessage(firecrawlError)}. ${browserFallbackHint(ctx)}`;
    }
  },
};

const web_fetch: ToolDef = {
  name: 'web_fetch',
  description:
    'Fetch a URL and return readable content. Uses Browserbase for a rendered-page fallback when Firecrawl fails; call browser directly for clicks, forms, login, or multi-step interaction.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The absolute http(s) URL to fetch' },
    },
    required: ['url'],
  },
  async execute(args: { url: string }, ctx: ToolCtx) {
    try {
      const data = await firecrawlPost(
        FIRECRAWL_SCRAPE_URL,
        { url: args.url, formats: ['markdown'] },
        fetchSignal(ctx),
      );
      const markdown: string | undefined = data?.data?.markdown ?? data?.markdown;
      if (typeof markdown === 'string' && markdown.length > 0) {
        return wrapUntrustedWebContent(truncate(markdown, FETCH_TRUNCATE_CHARS));
      }
      throw new Error('Firecrawl returned no markdown content');
    } catch (firecrawlError) {
      rethrowAbort(firecrawlError, ctx);
      if (browserFallbackAllowed(ctx)) {
        try {
          return wrapUntrustedWebContent(await browserService.fetchPage(args.url, ctx));
        } catch (browserError) {
          rethrowAbort(browserError, ctx);
          try {
            const res = await publicFetch(args.url, ctx);
            if (!res.ok) throw new Error(`fetch failed with ${res.status} ${res.statusText}`);
            return wrapUntrustedWebContent(truncate(stripHtml(await responseTextLimited(res)), FETCH_TRUNCATE_CHARS));
          } catch (directError) {
            rethrowAbort(directError, ctx);
            return `ERROR: Firecrawl failed (${errorMessage(firecrawlError)}); Browserbase failed (${errorMessage(browserError)}); direct fetch failed (${errorMessage(directError)}).`;
          }
        }
      }
      try {
        const res = await publicFetch(args.url, ctx);
        if (!res.ok) throw new Error(`fetch failed with ${res.status} ${res.statusText}`);
        return wrapUntrustedWebContent(truncate(stripHtml(await responseTextLimited(res)), FETCH_TRUNCATE_CHARS));
      } catch (directError) {
        rethrowAbort(directError, ctx);
        return `ERROR: Firecrawl failed (${errorMessage(firecrawlError)}); direct fetch failed (${errorMessage(directError)}).`;
      }
    }
  },
};

const image_search: ToolDef = {
  name: 'image_search',
  description:
    'Search the web for images matching a query. Returns top 8 as title / imageUrl / sourceUrl and falls back to Browserbase when Firecrawl is unavailable.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The image search query' },
    },
    required: ['query'],
  },
  async execute(args: { query: string }, ctx: ToolCtx) {
    try {
      const data = await firecrawlPost(
        FIRECRAWL_SEARCH_V2_URL,
        { query: args.query, limit: 8, sources: ['images'] },
        fetchSignal(ctx),
      );
      const results: any[] = data?.data?.images ?? (Array.isArray(data?.data) ? data.data : []) ?? [];
      if (!Array.isArray(results) || results.length === 0) return 'No images found.';
      return wrapUntrustedWebContent(results.slice(0, 8).map((result, index) => {
        const title = result.title ?? '(no title)';
        const imageUrl = result.imageUrl ?? result.image_url ?? '';
        const sourceUrl = result.sourceUrl ?? result.source_url ?? result.url ?? result.link ?? '';
        return `${index + 1}. ${title}\n   imageUrl: ${imageUrl}\n   sourceUrl: ${sourceUrl}`;
      }).join('\n'));
    } catch (firecrawlError) {
      rethrowAbort(firecrawlError, ctx);
      if (browserFallbackAllowed(ctx)) {
        try {
          const results = await browserService.imageSearch(args.query, ctx);
          return results.length ? wrapUntrustedWebContent(formatImageResults(results)) : 'No images found.';
        } catch (browserError) {
          rethrowAbort(browserError, ctx);
          return `ERROR: Firecrawl failed (${errorMessage(firecrawlError)}); Browserbase fallback failed (${errorMessage(browserError)}).`;
        }
      }
      return `ERROR: ${errorMessage(firecrawlError)}. ${browserFallbackHint(ctx)}`;
    }
  },
};

export const researchTools: ToolDef[] = [web_search, web_fetch, image_search];
