// Local embedding model for semantic source search. Runs fully on-device via
// transformers.js (ONNX); the model downloads once on first use and is cached
// by the library. When the model cannot load (offline first run, unsupported
// platform), every function degrades to null and callers fall back to lexical
// scoring — search never hard-fails because of the model.
import type { FeatureExtractionPipeline } from '@huggingface/transformers';

// multilingual-e5 requires these role prefixes; scores are garbage without them.
const QUERY_PREFIX = 'query: ';
const PASSAGE_PREFIX = 'passage: ';

const MODEL_ID = process.env.RAUTML_EMBED_MODEL || 'Xenova/multilingual-e5-small';

/** Inputs are clipped before embedding — e5-small attends to 512 tokens anyway. */
const EMBED_INPUT_CHAR_CAP = 2000;

const BATCH_SIZE = 8;

let pipePromise: Promise<FeatureExtractionPipeline | null> | null = null;

function getPipe(): Promise<FeatureExtractionPipeline | null> {
  if (!pipePromise) {
    pipePromise = (async () => {
      try {
        const { pipeline, env } = await import('@huggingface/transformers');
        if (process.env.RAUTML_CACHE_DIR) env.cacheDir = process.env.RAUTML_CACHE_DIR;
        const pipe = await pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' });
        console.log(`[sources] embedding model ready: ${MODEL_ID}`);
        return pipe as FeatureExtractionPipeline;
      } catch (err) {
        console.error(
          `[sources] embedding model unavailable (${(err as Error)?.message}); semantic search falls back to keyword scoring`,
        );
        return null;
      }
    })();
  }
  return pipePromise;
}

/** Warm the model in the background so the first upload doesn't pay for it. */
export function preloadEmbeddings(): void {
  void getPipe();
}

async function embed(texts: string[], prefix: string): Promise<Float32Array[] | null> {
  const pipe = await getPipe();
  if (!pipe || texts.length === 0) return pipe ? [] : null;

  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts
      .slice(i, i + BATCH_SIZE)
      .map((text) => prefix + text.slice(0, EMBED_INPUT_CHAR_CAP));
    const tensor = await pipe(batch, { pooling: 'mean', normalize: true });
    const [rows, dim] = tensor.dims as [number, number];
    const data = tensor.data as Float32Array;
    for (let row = 0; row < rows; row++) {
      out.push(data.slice(row * dim, (row + 1) * dim));
    }
  }
  return out;
}

export function embedPassages(texts: string[]): Promise<Float32Array[] | null> {
  return embed(texts, PASSAGE_PREFIX);
}

export async function embedQuery(text: string): Promise<Float32Array | null> {
  const vectors = await embed([text], QUERY_PREFIX);
  return vectors?.[0] ?? null;
}

/** Vectors are L2-normalized at embed time, so cosine similarity is a dot product. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot;
}
