// Text extraction for local sources — one entry point per supported upload
// type. Everything returns plain UTF-8 text; downstream (indexer) chunks and
// embeds it. Extraction is best-effort: a parse failure surfaces as a thrown
// error and the source lands in status 'error' (still downloadable, never lost).
//
// Parsing is CPU-bound (unpdf/mammoth/JSZip/hwp), so extractText dispatches
// the work to a worker thread (extract.worker.ts) and the server stays
// responsive; if the worker cannot start, extraction falls back to in-process.
import { existsSync, promises as fs } from 'node:fs';
import { Worker } from 'node:worker_threads';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import { parse as parseHwp } from 'hwp.js';
import { extractText as unpdfExtractText, getDocumentProxy } from 'unpdf';

/** Lowercase extensions (no dot) the upload endpoint accepts. */
export const SUPPORTED_EXTS = [
  'pdf',
  'csv',
  'docx',
  'pptx',
  'md',
  'markdown',
  'tex',
  'hwp',
  'hwpx',
] as const;

export type SupportedExt = (typeof SUPPORTED_EXTS)[number];

/**
 * Extracted text is capped so one enormous upload cannot swallow the process:
 * the cap bounds what read_source can page through and what gets indexed.
 */
export const EXTRACT_CHAR_CAP = 8_000_000;

/** Bytes read for plain-text formats — a 300MB CSV must not be slurped whole. */
const PLAIN_TEXT_BYTE_CAP = 48 * 1024 * 1024;

/**
 * Bytes accepted for the binary formats, which are parsed whole in memory.
 * Uploads may reach 400MB (multer cap), but parsing a 400MB PDF is exactly
 * the freeze scenario — refuse early instead of grinding the process down.
 */
const BINARY_PARSE_BYTE_CAP = 100 * 1024 * 1024;

/** Formats the parse cap applies to: everything not read as plain text. */
const BINARY_EXTS: ReadonlySet<string> = new Set(['pdf', 'docx', 'pptx', 'hwp', 'hwpx']);

const TRUNCATION_NOTE = '\n\n[…extraction truncated: the file continues beyond this point…]';

export function extForName(name: string): SupportedExt | null {
  const dot = name.lastIndexOf('.');
  if (dot === -1) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return (SUPPORTED_EXTS as readonly string[]).includes(ext) ? (ext as SupportedExt) : null;
}

// ---------------------------------------------------------------------------
// worker dispatch — the actual parse lives in extractTextInProcess below and
// runs on the worker thread; the main thread only ships paths back and forth.
// ---------------------------------------------------------------------------

/** Wire protocol with extract.worker.ts — one job in, one reply out. */
export type ExtractReply = { ok: true; text: string } | { ok: false; error: string };

interface PendingJob {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
}

let worker: Worker | null = null;
let workerViable = false; // answered at least one job — proven able to start
let workerUnavailable = false; // never came up — stay in-process from then on
let activeJob: PendingJob | null = null;
let extractChain: Promise<void> = Promise.resolve();

/**
 * Extract through the worker, one job at a time (the indexer queue is already
 * sequential; the chain just guards against a second concurrent caller).
 */
export function extractText(absPath: string, ext: string): Promise<string> {
  const run = extractChain.then(() => dispatchExtract(absPath, ext));
  extractChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

async function dispatchExtract(absPath: string, ext: string): Promise<string> {
  if (workerUnavailable) return extractTextInProcess(absPath, ext);
  try {
    return await runWorkerJob(absPath, ext);
  } catch (err) {
    if (!workerUnavailable) throw err;
    // The worker could not start — fall back in-process (warned once already).
    return extractTextInProcess(absPath, ext);
  }
}

function runWorkerJob(absPath: string, ext: string): Promise<string> {
  let instance = worker;
  if (!instance) {
    try {
      instance = spawnWorker();
    } catch (err) {
      // new Worker() itself threw — same story as an async spawn failure.
      markWorkerUnavailable(err as Error);
      throw err;
    }
    worker = instance;
  }
  return new Promise<string>((resolve, reject) => {
    activeJob = { resolve, reject };
    instance.postMessage({ absPath, ext });
  });
}

/**
 * The built server loads dist/sources/extract.worker.js; under tsx (dev and
 * tests) only the .ts source exists, which the worker picks up through the
 * inherited tsx loader in execArgv.
 */
function workerEntryUrl(): URL {
  const js = new URL('./extract.worker.js', import.meta.url);
  return existsSync(js) ? js : new URL('./extract.worker.ts', import.meta.url);
}

function spawnWorker(): Worker {
  const instance = new Worker(workerEntryUrl());
  instance.on('message', (reply: ExtractReply) => {
    const job = activeJob;
    activeJob = null;
    if (!job) return;
    workerViable = true; // any reply — even a parse error — proves the worker runs
    if (reply.ok) job.resolve(reply.text);
    else job.reject(new Error(reply.error));
  });
  instance.on('error', (err) => retireWorker(instance, err));
  instance.on('exit', (code) => {
    // An exit before the reply means the job (and the worker) is lost.
    retireWorker(instance, new Error(`extraction worker stopped (exit code ${code})`));
  });
  instance.unref();
  return instance;
}

/** A dead worker rejects its in-flight job; the next job spawns a fresh one. */
function retireWorker(dead: Worker, err: Error): void {
  if (worker === dead) worker = null;
  void dead.terminate();
  const job = activeJob;
  activeJob = null;
  if (!workerViable) markWorkerUnavailable(err);
  job?.reject(err);
}

function markWorkerUnavailable(err: Error): void {
  if (workerUnavailable) return;
  workerUnavailable = true;
  console.warn(
    `[sources] extraction worker unavailable (${err.message}); extracting in-process instead`,
  );
}

// ---------------------------------------------------------------------------
// the parse itself
// ---------------------------------------------------------------------------

/**
 * The actual extraction. Normally runs on the worker thread via extractText;
 * called directly only as the fallback when the worker cannot start.
 */
export async function extractTextInProcess(absPath: string, ext: string): Promise<string> {
  if (BINARY_EXTS.has(ext)) await assertUnderParseCap(absPath);
  switch (ext) {
    case 'csv':
    case 'md':
    case 'markdown':
    case 'tex':
      return capText(await readPlainText(absPath));
    case 'pdf':
      return capText(await extractPdf(absPath));
    case 'docx':
      return capText(await extractDocx(absPath));
    case 'pptx':
      return capText(await extractPptx(absPath));
    case 'hwpx':
      return capText(await extractHwpx(absPath));
    case 'hwp':
      return capText(extractHwpBinary(await fs.readFile(absPath)));
    default:
      throw new Error(`Unsupported file type: .${ext}`);
  }
}

/** Binary parsers slurp the whole file, so refuse the huge ones up front. */
async function assertUnderParseCap(absPath: string): Promise<void> {
  const { size } = await fs.stat(absPath);
  if (size <= BINARY_PARSE_BYTE_CAP) return;
  const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);
  throw new Error(
    `File too large to parse: ${mb(size)}MB exceeds the ${mb(BINARY_PARSE_BYTE_CAP)}MB cap`,
  );
}

function capText(text: string): string {
  const cleaned = normalize(text);
  if (cleaned.length <= EXTRACT_CHAR_CAP) return cleaned;
  return cleaned.slice(0, EXTRACT_CHAR_CAP) + TRUNCATION_NOTE;
}

/** Collapse runaway blank lines, strip NULs/control noise, unify newlines. */
function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

async function readPlainText(absPath: string): Promise<string> {
  const handle = await fs.open(absPath, 'r');
  try {
    const stat = await handle.stat();
    const bytes = Math.min(stat.size, PLAIN_TEXT_BYTE_CAP);
    const buffer = Buffer.alloc(bytes);
    // A single read() is not guaranteed to fill the buffer — loop to EOF/cap.
    let offset = 0;
    while (offset < bytes) {
      const { bytesRead } = await handle.read(buffer, offset, bytes - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    let text = buffer.toString('utf8', 0, offset);
    if (stat.size > PLAIN_TEXT_BYTE_CAP) text += TRUNCATION_NOTE;
    return text;
  } finally {
    await handle.close();
  }
}

async function extractPdf(absPath: string): Promise<string> {
  const buffer = await fs.readFile(absPath);
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await unpdfExtractText(pdf, { mergePages: true });
  return text;
}

async function extractDocx(absPath: string): Promise<string> {
  const result = await mammoth.extractRawText({ path: absPath });
  return result.value;
}

/** Minimal XML entity decoding for text pulled straight out of OOXML/OWPML. */
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Numeric-aware sort for slide1.xml … slide12.xml. */
function byTrailingNumber(a: string, b: string): number {
  const numberOf = (name: string) => parseInt(name.match(/(\d+)\.xml$/)?.[1] ?? '0', 10);
  return numberOf(a) - numberOf(b);
}

/**
 * PPTX: a zip of slide XML. Text lives in <a:t> runs; each </a:p> ends a
 * paragraph. Enough structure for search — layout is not the point here.
 */
async function extractPptx(absPath: string): Promise<string> {
  const zip = await JSZip.loadAsync(await fs.readFile(absPath));
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort(byTrailingNumber);

  const parts: string[] = [];
  for (const name of slideNames) {
    const xml = await zip.files[name]!.async('string');
    const paragraphs = xml
      .split(/<\/a:p>/)
      .map((paragraph) =>
        [...paragraph.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)]
          .map((match) => decodeEntities(match[1] ?? ''))
          .join(''),
      )
      .filter((line) => line.trim().length > 0);
    if (paragraphs.length) {
      parts.push(`[Slide ${parts.length + 1}]\n${paragraphs.join('\n')}`);
    }
  }
  return parts.join('\n\n');
}

/**
 * HWPX (OWPML): a zip with Contents/section*.xml. Text runs are <hp:t>; each
 * </hp:p> ends a paragraph.
 */
async function extractHwpx(absPath: string): Promise<string> {
  const zip = await JSZip.loadAsync(await fs.readFile(absPath));
  const sectionNames = Object.keys(zip.files)
    .filter((name) => /^Contents\/section\d+\.xml$/.test(name))
    .sort(byTrailingNumber);
  if (!sectionNames.length) throw new Error('No Contents/section*.xml inside the HWPX archive');

  const parts: string[] = [];
  for (const name of sectionNames) {
    const xml = await zip.files[name]!.async('string');
    const paragraphs = xml
      .split(/<\/hp:p>/)
      .map((paragraph) =>
        [...paragraph.matchAll(/<hp:t[^>]*>([\s\S]*?)<\/hp:t>/g)]
          .map((match) => decodeEntities((match[1] ?? '').replace(/<[^>]+>/g, '')))
          .join(''),
      )
      .filter((line) => line.trim().length > 0);
    if (paragraphs.length) parts.push(paragraphs.join('\n'));
  }
  return parts.join('\n\n');
}

/** HWP v5 (binary CFB): hwp.js parses sections → paragraphs → chars. */
function extractHwpBinary(buffer: Buffer): string {
  const document = parseHwp(buffer as any, { type: 'buffer' } as any);
  const lines: string[] = [];
  for (const section of document.sections) {
    for (const paragraph of section.content) {
      const line = paragraph.content
        .map((char) => (typeof char.value === 'string' ? char.value : ''))
        .join('');
      if (line.trim().length > 0) lines.push(line);
    }
  }
  if (!lines.length) throw new Error('No text found in the HWP document');
  return lines.join('\n');
}
