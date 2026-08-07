// Local-sources indexer: extraction → chunking → embeddings → DB, run as a
// sequential background queue (one file at a time keeps CPU/memory sane while
// a 300MB upload grinds through). Status transitions are published over SSE
// as source.updated so the UI tracks Indexing → Ready/Failed live.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SOURCES_DIR } from '../db.js';
import * as repo from '../repo.js';
import * as sse from '../sse.js';
import type { Source } from '../types.js';
import { cosine, embedPassages, embedQuery } from './embeddings.js';
import { extractText } from './extract.js';

/** Chunks longer than this get split; the tail overlaps so context survives cuts. */
const CHUNK_CHARS = 1200;
const CHUNK_OVERLAP = 150;

/**
 * How much extracted text gets chunked + embedded. read_source can still page
 * through the full extracted text; only *semantic search* is capped.
 */
const INDEX_CHAR_CAP = Number(process.env.RAUTML_INDEX_CHAR_CAP) || 1_500_000;

const EXTRACTED_FILENAME = 'extracted.txt';

// ---------------------------------------------------------------------------
// storage layout: data/sources/<chatId>/<sourceId>/<original name>
// ---------------------------------------------------------------------------

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function sanitizeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[/\\:*?\"<>|\u0000-\u001F]/g, '_').slice(0, 200);
  return cleaned || 'file';
}

export function sourceDir(chatId: string, sourceId: string): string {
  return path.join(SOURCES_DIR, chatId, sourceId);
}

export function rawFilePath(source: Source): string {
  return path.join(sourceDir(source.chatId, source.id), sanitizeFilename(source.name));
}

export function extractedTextPath(source: Source): string {
  return path.join(sourceDir(source.chatId, source.id), EXTRACTED_FILENAME);
}

/** A slice of the extracted text, straight from disk (offsets in characters). */
export async function readExtractedText(
  source: Source,
  offset: number,
  length: number,
): Promise<string> {
  const full = await fs.readFile(extractedTextPath(source), 'utf8');
  return full.slice(offset, offset + length);
}

// ---------------------------------------------------------------------------
// chunking
// ---------------------------------------------------------------------------

interface RawChunk {
  seq: number;
  startOff: number;
  endOff: number;
  text: string;
}

/**
 * Fixed-size windows that prefer to break on a paragraph, then a newline,
 * then a sentence end, then a space — searched within the last fifth of the
 * window so chunks stay near CHUNK_CHARS.
 */
export function chunkText(text: string): RawChunk[] {
  const chunks: RawChunk[] = [];
  const total = Math.min(text.length, INDEX_CHAR_CAP);
  let start = 0;
  while (start < total) {
    let end = Math.min(start + CHUNK_CHARS, total);
    if (end < total) {
      const windowStart = end - Math.floor(CHUNK_CHARS / 5);
      const slice = text.slice(windowStart, end);
      for (const token of ['\n\n', '\n', '. ', '。', '다. ', ' ']) {
        const at = slice.lastIndexOf(token);
        if (at > 0) {
          end = windowStart + at + token.length;
          break;
        }
      }
    }
    const body = text.slice(start, end).trim();
    if (body.length > 0) {
      chunks.push({ seq: chunks.length, startOff: start, endOff: end, text: body });
    }
    if (end >= total) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// indexing queue
// ---------------------------------------------------------------------------

let queue: Promise<void> = Promise.resolve();

export function enqueueIndex(sourceId: string): void {
  queue = queue.then(() => indexSource(sourceId)).catch(() => {});
}

/** Sources stranded mid-index by a restart get re-queued on boot. */
export function resumePendingIndexing(): void {
  const pending = repo.listProcessingSources();
  for (const source of pending) enqueueIndex(source.id);
  if (pending.length) console.log(`[sources] resuming ${pending.length} pending index job(s)`);
}

async function indexSource(sourceId: string): Promise<void> {
  const source = repo.getSource(sourceId);
  if (!source) return;
  try {
    const text = await extractText(rawFilePath(source), source.ext);
    if (!text.trim()) throw new Error('No extractable text found in this file');
    await fs.writeFile(extractedTextPath(source), text, 'utf8');

    const raw = chunkText(text);
    const vectors = await embedPassages(raw.map((chunk) => chunk.text));
    const chunks: repo.SourceChunk[] = raw.map((chunk, i) => ({
      sourceId: source.id,
      seq: chunk.seq,
      startOff: chunk.startOff,
      endOff: chunk.endOff,
      text: chunk.text,
      embedding: vectors?.[i] ? new Uint8Array(vectors[i]!.buffer, 0, vectors[i]!.byteLength) : null,
    }));
    // The source may have been deleted while we extracted/embedded — bail
    // instead of re-inserting chunks for a row that no longer exists.
    if (!repo.getSource(source.id)) return;
    repo.replaceSourceChunks(source.id, source.chatId, chunks);
    repo.setSourceReady(source.id, text.length, chunks.length);
  } catch (err) {
    console.error(`[sources] indexing failed for ${source.name}`, err);
    repo.setSourceError(source.id, (err as Error)?.message ?? 'Extraction failed');
  }
  const updated = repo.getSource(sourceId);
  if (updated) sse.publish(updated.chatId, 'main', 'source.updated', { source: updated });
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

export interface SourceHit {
  source: Source;
  seq: number;
  startOff: number;
  endOff: number;
  text: string;
  score: number;
}

/**
 * Semantic top-k over every chunk in the chat; keyword scoring covers chunks
 * (or whole installs) without embeddings, so old uploads always stay findable.
 */
export async function searchChunks(
  chatId: string,
  query: string,
  topK: number,
): Promise<SourceHit[]> {
  const chunks = repo.listChunksForChat(chatId);
  if (!chunks.length) return [];

  const sourcesById = new Map(repo.listSources(chatId).map((source) => [source.id, source]));
  const anyEmbedded = chunks.some((chunk) => chunk.embedding && chunk.embedding.byteLength > 0);
  const queryVec = anyEmbedded ? await embedQuery(query) : null;

  const scored = chunks.map((chunk) => {
    let score: number;
    if (queryVec && chunk.embedding && chunk.embedding.byteLength > 0) {
      const vec = new Float32Array(
        chunk.embedding.buffer,
        chunk.embedding.byteOffset,
        chunk.embedding.byteLength / 4,
      );
      score = cosine(queryVec, vec);
    } else {
      score = lexicalScore(query, chunk.text);
    }
    return { chunk, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const hits: SourceHit[] = [];
  for (const { chunk, score } of scored) {
    if (hits.length >= topK) break;
    const source = sourcesById.get(chunk.sourceId);
    if (!source || score <= 0) continue;
    hits.push({
      source,
      seq: chunk.seq,
      startOff: chunk.startOff,
      endOff: chunk.endOff,
      text: chunk.text,
      score,
    });
  }
  return hits;
}

/** Cheap tf scoring over unicode word tokens — the no-model fallback. */
function lexicalScore(query: string, text: string): number {
  const terms = tokenize(query);
  if (!terms.length) return 0;
  const counts = new Map<string, number>();
  for (const token of tokenize(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
  let score = 0;
  for (const term of terms) {
    const tf = counts.get(term) ?? 0;
    if (tf > 0) score += (1 + Math.log(tf)) * Math.min(term.length, 8);
  }
  return score / Math.sqrt(Math.max(text.length, 1));
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((token) => token.length > 1);
}
