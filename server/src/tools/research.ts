import type { ToolCtx, ToolDef } from '../types.js';

const FIRECRAWL_SEARCH_URL = 'https://api.firecrawl.dev/v1/search';
const FIRECRAWL_SCRAPE_URL = 'https://api.firecrawl.dev/v1/scrape';
// v1/search's schema does not accept a `sources` param (hard 400: unrecognized_keys).
// v2/search supports `sources:["images"]` and returns data.images[]; used for image_search only.
const FIRECRAWL_SEARCH_V2_URL = 'https://api.firecrawl.dev/v2/search';
const TIMEOUT_MS = 30_000;
const FETCH_TRUNCATE_CHARS = 24_000;

function firecrawlKey(): string {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) throw new Error('FIRECRAWL_API_KEY is not set');
  return key;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n[…truncated…]\n${text.slice(text.length - half)}`;
}

function stripHtml(html: string): string {
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

/**
 * The 30s fetch cap combined with the run's abort signal, so a stopped run
 * cancels in-flight fetches instead of waiting them out. AbortSignal.any is
 * available on every Node we ship (>=20.3).
 */
function fetchSignal(ctx: ToolCtx): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
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

const web_search: ToolDef = {
  name: 'web_search',
  description: 'Search the web for a query. Returns top 8 results as title / url / snippet.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
    },
    required: ['query'],
  },
  async execute(args: { query: string }, ctx: ToolCtx): Promise<string> {
    try {
      const data = await firecrawlPost(
        FIRECRAWL_SEARCH_URL,
        {
          query: args.query,
          limit: 8,
        },
        fetchSignal(ctx),
      );
      const results: any[] = data?.data?.web ?? data?.data ?? [];
      if (!Array.isArray(results) || results.length === 0) {
        return 'No results found.';
      }
      const lines = results.slice(0, 8).map((r, i) => {
        const title = r.title ?? '(no title)';
        const url = r.url ?? r.link ?? '';
        const snippet = r.description ?? r.snippet ?? '';
        return `${i + 1}. ${title}\n   ${url}\n   ${snippet}`;
      });
      return lines.join('\n');
    } catch (err: any) {
      return `ERROR: ${err?.message ?? String(err)}`;
    }
  },
};

const web_fetch: ToolDef = {
  name: 'web_fetch',
  description: 'Fetch a URL and return its content as markdown.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch' },
    },
    required: ['url'],
  },
  async execute(args: { url: string }, ctx: ToolCtx): Promise<string> {
    try {
      const data = await firecrawlPost(
        FIRECRAWL_SCRAPE_URL,
        {
          url: args.url,
          formats: ['markdown'],
        },
        fetchSignal(ctx),
      );
      const markdown: string | undefined = data?.data?.markdown ?? data?.markdown;
      if (typeof markdown === 'string' && markdown.length > 0) {
        return truncate(markdown, FETCH_TRUNCATE_CHARS);
      }
      throw new Error('Firecrawl returned no markdown content');
    } catch (firecrawlErr: any) {
      try {
        const res = await fetch(args.url, {
          signal: fetchSignal(ctx),
        });
        if (!res.ok) {
          return `ERROR: fetch failed with ${res.status} ${res.statusText}`;
        }
        const html = await res.text();
        const text = stripHtml(html);
        return truncate(text, FETCH_TRUNCATE_CHARS);
      } catch (fallbackErr: any) {
        return `ERROR: ${fallbackErr?.message ?? String(fallbackErr)}`;
      }
    }
  },
};

const image_search: ToolDef = {
  name: 'image_search',
  description: 'Search the web for images matching a query. Returns top 8 as title / imageUrl / sourceUrl.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The image search query' },
    },
    required: ['query'],
  },
  async execute(args: { query: string }, ctx: ToolCtx): Promise<string> {
    try {
      const data = await firecrawlPost(
        FIRECRAWL_SEARCH_V2_URL,
        {
          query: args.query,
          limit: 8,
          sources: ['images'],
        },
        fetchSignal(ctx),
      );
      const results: any[] =
        data?.data?.images ?? (Array.isArray(data?.data) ? data.data : []) ?? [];
      if (!Array.isArray(results) || results.length === 0) {
        return 'No images found.';
      }
      const lines = results.slice(0, 8).map((r, i) => {
        const title = r.title ?? '(no title)';
        const imageUrl = r.imageUrl ?? r.image_url ?? '';
        const sourceUrl = r.sourceUrl ?? r.source_url ?? r.url ?? r.link ?? '';
        return `${i + 1}. ${title}\n   imageUrl: ${imageUrl}\n   sourceUrl: ${sourceUrl}`;
      });
      return lines.join('\n');
    } catch (err: any) {
      return `ERROR: ${err?.message ?? String(err)}`;
    }
  },
};

export const researchTools: ToolDef[] = [web_search, web_fetch, image_search];
