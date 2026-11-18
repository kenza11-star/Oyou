/** Errors from HTTP calls. retryAfterMs comes from the Retry-After header when present. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(`HTTP ${status}`);
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return RETRYABLE_STATUS.has(err.status);
  // fetch() rejects with TypeError on network failures.
  return err instanceof TypeError;
}

export interface RetryOptions {
  attempts: number;
  baseMs: number;
  maxMs: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** Full-jitter exponential backoff: a random delay in [0, min(maxMs, baseMs * 2^attempt)). */
export function backoffDelay(
  attempt: number,
  opts: Pick<RetryOptions, "baseMs" | "maxMs" | "random">,
): number {
  const random = opts.random ?? Math.random;
  const cap = Math.min(opts.maxMs, opts.baseMs * 2 ** attempt);
  return Math.floor(random() * cap);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => defaultSleep(ms, opts.signal));
  let lastErr: unknown;
  for (let attempt = 0; attempt < opts.attempts; attempt++) {
    if (opts.signal?.aborted) throw new Error("cancelled");
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === opts.attempts - 1) throw err;
      const jitter = backoffDelay(attempt, opts);
      const serverHint =
        err instanceof HttpError && err.retryAfterMs ? err.retryAfterMs : 0;
      await sleep(Math.max(jitter, serverHint));
    }
  }
  throw lastErr;
}

/**
 * Adjusts concurrency from observed outcomes. Failures halve the limit; a streak of successes raises it by one.
 * It never leaves [min, max].
 */
export class AdaptiveConcurrency {
  private current: number;
  private successStreak = 0;

  constructor(
    initial = 6,
    private readonly min = 2,
    private readonly max = 16,
  ) {
    this.current = Math.min(max, Math.max(min, initial));
  }

  get limit(): number {
    return this.current;
  }

  onSuccess(): void {
    this.successStreak += 1;
    if (this.successStreak >= this.current * 2 && this.current < this.max) {
      this.current += 1;
      this.successStreak = 0;
    }
  }

  onFailure(): void {
    this.current = Math.max(this.min, Math.floor(this.current / 2));
    this.successStreak = 0;
  }
}

/**
 * Runs worker over items with at most controller.limit tasks in flight at once.
 * Results keep input order. Aborting stops new tasks from starting.
 */
export async function runPool<T, R>(
  items: T[],
  controller: AdaptiveConcurrency,
  worker: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let active = 0;
  let firstError: unknown = null;

  await new Promise<void>((resolve, reject) => {
    const launch = () => {
      if (firstError) return;
      while (next < items.length && active < controller.limit) {
        if (signal?.aborted) {
          firstError = new Error("cancelled");
          reject(firstError);
          return;
        }
        const idx = next++;
        active++;
        worker(items[idx], idx)
          .then((r) => {
            results[idx] = r;
            controller.onSuccess();
          })
          .catch((err) => {
            controller.onFailure();
            if (!firstError) firstError = err;
          })
          .finally(() => {
            active--;
            if (firstError) {
              if (active === 0) reject(firstError);
              return;
            }
            if (next >= items.length && active === 0) resolve();
            else launch();
          });
      }
      if (next >= items.length && active === 0) resolve();
    };
    launch();
  });

  return results;
}
