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
const PIPE_IDLE_MS = 90_000;

/** A failed model load is retried after this backoff instead of never. */
const PIPE_RETRY_MS = 60_000;

/**
 * A stalled first-run download (flaky network, dead CDN edge) must not wait
 * forever: the load promise never settling would freeze the indexing queue
 * and any run mid-`search_sources`. Fail into the retry backoff — and the
 * keyword-scoring fallback — instead.
 */
const PIPE_LOAD_TIMEOUT_MS = 5 * 60_000;

let pipePromise: Promise<FeatureExtractionPipeline | null> | null = null;
let pipe: FeatureExtractionPipeline | null = null;
let pipeIdleTimer: ReturnType<typeof setTimeout> | null = null;
let activeUses = 0;
/** Timestamp of the last failed load attempt; 0 = no failure awaiting retry. */
let pipeLoadFailedAt = 0;

function clearPipeIdleTimer(): void {
  if (!pipeIdleTimer) return;
  clearTimeout(pipeIdleTimer);
  pipeIdleTimer = null;
}

function schedulePipeDisposal(): void {
  clearPipeIdleTimer();
  if (!pipe || activeUses > 0) return;
  pipeIdleTimer = setTimeout(() => {
    pipeIdleTimer = null;
    if (!pipe || activeUses > 0) return;
    const stale = pipe;
    pipe = null;
    pipePromise = null;
    void stale.dispose().catch((err: unknown) => {
      console.warn(`[sources] embedding model disposal failed: ${(err as Error)?.message ?? err}`);
    });
  }, PIPE_IDLE_MS);
  pipeIdleTimer.unref?.();
}

function getPipe(): Promise<FeatureExtractionPipeline | null> {
  clearPipeIdleTimer();
  // A failed load used to stick for the process lifetime. Retry after a
  // backoff instead — first-run downloads fail transiently (offline, proxy
  // hiccup) and often succeed later.
  if (pipePromise && pipeLoadFailedAt && Date.now() - pipeLoadFailedAt >= PIPE_RETRY_MS) {
    pipePromise = null;
  }
  if (!pipePromise) {
    pipeLoadFailedAt = 0; // re-armed by the catch below if this attempt fails
    pipePromise = (async () => {
      try {
        const { pipeline, env } = await import('@huggingface/transformers');
        if (process.env.RAUTML_CACHE_DIR) env.cacheDir = process.env.RAUTML_CACHE_DIR;
        let loadTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          pipe = (await Promise.race([
            pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' }),
            new Promise<never>((_, reject) => {
              loadTimer = setTimeout(
                () => reject(new Error('model load timed out')),
                PIPE_LOAD_TIMEOUT_MS,
              );
              loadTimer.unref?.();
            }),
          ])) as FeatureExtractionPipeline;
        } finally {
          if (loadTimer) clearTimeout(loadTimer);
        }
        console.log(`[sources] embedding model ready: ${MODEL_ID}`);
        return pipe;
      } catch (err) {
        pipeLoadFailedAt = Date.now();
        console.error(
          `[sources] embedding model unavailable (${(err as Error)?.message}); semantic search falls back to keyword scoring`,
        );
        return null;
      }
    })();
  }
  return pipePromise;
}

async function embed(texts: string[], prefix: string): Promise<Float32Array[] | null> {
  const current = await getPipe();
  if (!current || texts.length === 0) return current ? [] : null;

  activeUses += 1;
  const out: Float32Array[] = [];
  try {
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts
        .slice(i, i + BATCH_SIZE)
        .map((text) => prefix + text.slice(0, EMBED_INPUT_CHAR_CAP));
      const tensor = await current(batch, { pooling: 'mean', normalize: true });
      const [rows, dim] = tensor.dims as [number, number];
      const data = tensor.data as Float32Array;
      for (let row = 0; row < rows; row++) {
        out.push(data.slice(row * dim, (row + 1) * dim));
      }
      tensor.dispose();
    }
    return out;
  } finally {
    activeUses -= 1;
    schedulePipeDisposal();
  }
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
