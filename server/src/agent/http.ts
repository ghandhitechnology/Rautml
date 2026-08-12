// fetch() bounded on the connect + response-headers phase.
//
// Node/undici only enforces a 300s headersTimeout by default, so a provider
// that accepts the connection and then stalls parks a run for minutes per
// attempt (times retries), and a token refresh with no caller signal can
// queue every concurrent run behind one hung request. This wrapper fails the
// request after HEADERS_TIMEOUT_MS unless response headers have arrived; once
// they have, the timer is cleared and streaming bodies are governed by the
// caller's signal and the stream idle watchdog instead.

/** How long a provider may take to start responding before we give up. */
export const HEADERS_TIMEOUT_MS = 45_000;

function isAbortError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    ((err as { name?: string }).name === 'AbortError' ||
      (err as { code?: string }).code === 'ABORT_ERR')
  );
}

export async function fetchWithHeadersTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = HEADERS_TIMEOUT_MS,
): Promise<Response> {
  const caller = init.signal ?? null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forwardAbort = () => controller.abort(caller?.reason);
  if (caller) {
    if (caller.aborted) forwardAbort();
    else caller.addEventListener('abort', forwardAbort, { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    // The timeout firing surfaces as an AbortError just like the caller's
    // Stop would — only the latter is a real cancellation.
    if (isAbortError(err) && !caller?.aborted) {
      throw new Error(
        `timed out after ${Math.round(timeoutMs / 1000)}s waiting for response headers`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener('abort', forwardAbort);
  }
}
