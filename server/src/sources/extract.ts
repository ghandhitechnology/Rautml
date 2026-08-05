// Text extraction for local sources — one entry point per supported upload
// type. Everything returns plain UTF-8 text; downstream (indexer) chunks and
// embeds it. Extraction is best-effort: a parse failure surfaces as a thrown
// error and the source lands in status 'error' (still downloadable, never lost).
import { promises as fs } from 'node:fs';
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

const TRUNCATION_NOTE = '\n\n[…extraction truncated: the file continues beyond this point…]';

export function extForName(name: string): SupportedExt | null {
  const dot = name.lastIndexOf('.');
  if (dot === -1) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return (SUPPORTED_EXTS as readonly string[]).includes(ext) ? (ext as SupportedExt) : null;
}

export async function extractText(absPath: string, ext: string): Promise<string> {
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
    await handle.read(buffer, 0, bytes, 0);
    let text = buffer.toString('utf8');
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
