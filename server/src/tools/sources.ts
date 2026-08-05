// Local-sources tools: the agent's window into files the user uploaded.
// Sources persist for the life of the chat — a file uploaded twenty turns ago
// is as reachable as one uploaded this turn.
//
//   list_sources   {}                                → inventory of every upload
//   search_sources {query, top_k?}                   → semantic top-k passages
//   read_source    {name, offset?, length?}          → page through extracted text
import type { ToolDef } from '../types.js';
import * as repo from '../repo.js';
import {
  formatBytes,
  readExtractedText,
  searchChunks,
} from '../sources/indexer.js';
import type { Source } from '../types.js';

const DEFAULT_TOP_K = 8;
const MAX_TOP_K = 20;
const DEFAULT_READ_LENGTH = 6000;
const MAX_READ_LENGTH = 20_000;

function describe(source: Source): string {
  const state =
    source.status === 'ready'
      ? `${source.textChars.toLocaleString('en-US')} chars of text, ${source.chunkCount} chunks`
      : source.status === 'error'
        ? `text extraction failed (${source.error ?? 'unknown error'})`
        : 'still indexing';
  return `- "${source.name}" — ${source.ext}, ${formatBytes(source.size)}, ${state} [id: ${source.id}]`;
}

/** A source by exact id, exact name, then unique case-insensitive name prefix. */
function resolveSource(chatId: string, ref: string): Source | string {
  const sources = repo.listSources(chatId);
  if (!sources.length) return 'This chat has no local sources yet.';
  const byId = sources.find((source) => source.id === ref);
  if (byId) return byId;
  const byName = sources.filter((source) => source.name === ref);
  if (byName.length === 1) return byName[0]!;
  const needle = ref.toLowerCase();
  const byPrefix = sources.filter((source) => source.name.toLowerCase().startsWith(needle));
  if (byPrefix.length === 1) return byPrefix[0]!;
  if (byPrefix.length > 1) {
    return `Ambiguous name "${ref}" — matches: ${byPrefix.map((s) => s.name).join(', ')}`;
  }
  return `No source named "${ref}". Available:\n${sources.map(describe).join('\n')}`;
}

const list_sources: ToolDef = {
  name: 'list_sources',
  description:
    "List every file in this chat's local sources (files the user uploaded, from any turn): name, type, size, and indexing state.",
  parameters: { type: 'object', properties: {} },
  async execute(_args, ctx): Promise<string> {
    const sources = repo.listSources(ctx.chatId);
    if (!sources.length) return 'This chat has no local sources yet.';
    return `${sources.length} source${sources.length === 1 ? '' : 's'}:\n${sources
      .map(describe)
      .join('\n')}`;
  },
};

const search_sources: ToolDef = {
  name: 'search_sources',
  description:
    "Semantic search across every uploaded file in this chat's local sources. Returns the most relevant passages with their file name and character offsets (usable with read_source to pull more context). Query in the language of the documents when known; Korean and English both work.",
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look for — a question or key phrases' },
      top_k: {
        type: 'number',
        description: `How many passages to return (default ${DEFAULT_TOP_K}, max ${MAX_TOP_K})`,
      },
    },
    required: ['query'],
  },
  async execute(args: { query: string; top_k?: number }, ctx): Promise<string> {
    const query = typeof args?.query === 'string' ? args.query.trim() : '';
    if (!query) return 'query must be a non-empty string.';
    const sources = repo.listSources(ctx.chatId);
    if (!sources.length) return 'This chat has no local sources yet.';

    const topK = Math.max(1, Math.min(Math.floor(args?.top_k ?? DEFAULT_TOP_K), MAX_TOP_K));
    const hits = await searchChunks(ctx.chatId, query, topK);
    if (!hits.length) {
      const pending = sources.filter((source) => source.status === 'processing');
      return pending.length
        ? `No matching passages yet — ${pending.length} file(s) are still indexing. Try again shortly or use read_source.`
        : 'No matching passages found. Try different phrasing, or read_source to scan a file directly.';
    }
    return hits
      .map(
        (hit, i) =>
          `[${i + 1}] "${hit.source.name}" chars ${hit.startOff}–${hit.endOff} (score ${hit.score.toFixed(3)})\n${hit.text}`,
      )
      .join('\n\n');
  },
};

const read_source: ToolDef = {
  name: 'read_source',
  description:
    "Read a slice of an uploaded file's extracted text from this chat's local sources. Use after search_sources to pull surrounding context, or to scan a file top to bottom. offset/length are in characters.",
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'File name (or source id) as shown by list_sources' },
      offset: { type: 'number', description: 'Start character offset (default 0)' },
      length: {
        type: 'number',
        description: `Characters to return (default ${DEFAULT_READ_LENGTH}, max ${MAX_READ_LENGTH})`,
      },
    },
    required: ['name'],
  },
  async execute(args: { name: string; offset?: number; length?: number }, ctx): Promise<string> {
    const ref = typeof args?.name === 'string' ? args.name.trim() : '';
    if (!ref) return 'name must be a non-empty string.';
    const resolved = resolveSource(ctx.chatId, ref);
    if (typeof resolved === 'string') return resolved;
    if (resolved.status === 'processing') {
      return `"${resolved.name}" is still indexing — its text is not readable yet. Try again in a moment.`;
    }
    if (resolved.status === 'error') {
      return `"${resolved.name}" has no extracted text (${resolved.error ?? 'extraction failed'}). The raw file is still stored, but it cannot be read as text.`;
    }

    const offset = Math.max(0, Math.floor(args?.offset ?? 0));
    const length = Math.max(
      1,
      Math.min(Math.floor(args?.length ?? DEFAULT_READ_LENGTH), MAX_READ_LENGTH),
    );
    if (offset >= resolved.textChars) {
      return `Offset ${offset} is past the end — "${resolved.name}" has ${resolved.textChars} characters of text.`;
    }
    const text = await readExtractedText(resolved, offset, length);
    const end = offset + text.length;
    const header = `"${resolved.name}" chars ${offset}–${end} of ${resolved.textChars}${
      end < resolved.textChars ? ` (continue with offset: ${end})` : ' (end of file)'
    }`;
    return `${header}\n${text}`;
  },
};

export const sourceTools: ToolDef[] = [list_sources, search_sources, read_source];
