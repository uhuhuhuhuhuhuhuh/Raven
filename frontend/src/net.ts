export function abortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

export type RetryOptions = {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

/** Delay before the next attempt: the server's numeric Retry-After if given, else exponential backoff. */
export function retryDelayMs(response: Response, attempt: number, baseDelayMs = 2000, maxDelayMs = 30_000): number {
  const header = response.headers.get('Retry-After');
  const seconds = header === null || header.trim() === '' ? Number.NaN : Number(header);
  const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : baseDelayMs * 2 ** attempt;
  return Math.min(delay, maxDelayMs);
}

/**
 * Fetch that retries a small, bounded number of times when a shared public service
 * reports it is rate limiting or overloaded, honouring its Retry-After hint.
 */
export async function fetchWithRetry(input: RequestInfo | URL, init: RequestInit = {}, options: RetryOptions = {}): Promise<Response> {
  const { retries = 2, baseDelayMs = 2000, maxDelayMs = 30_000 } = options;
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(input, init);
    if (!RETRYABLE_STATUS.has(response.status) || attempt >= retries) return response;
    await sleep(retryDelayMs(response, attempt, baseDelayMs, maxDelayMs), init.signal ?? undefined);
  }
}
