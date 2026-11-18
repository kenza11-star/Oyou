import {
  githubRaw,
  GithubRateLimitError,
  GithubHttpError,
} from "../github/client";
import { AdaptiveConcurrency, HttpError, withRetry } from "../transfer/engine";
import { Lease, Deferred, reserveMutation, blockGithub } from "./state";

export class WorkerGithub {
  readonly concurrency = new AdaptiveConcurrency(6, 2, 16);
  constructor(
    public token: string,
    readonly lease: Lease,
  ) {}
  async call<T>(
    method: string,
    path: string,
    body?: unknown,
    preReserved = false,
  ): Promise<T> {
    return withRetry(
      async (attempt) => {
        await this.lease.check();
        if (method !== "GET" && !(preReserved && attempt === 0)) {
          const wait = await reserveMutation(
            Number(this.lease.job.telegram_user_id),
          );
          if (wait > 0) throw new Deferred(Math.ceil(wait) + 1000);
        }
        try {
          const res = await githubRaw(this.token, path, {
            method,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.any([
              this.lease.signal,
              AbortSignal.timeout(60_000),
            ]),
          });
          return (await res.json()) as T;
        } catch (err) {
          if (err instanceof GithubRateLimitError) {
            this.concurrency.onFailure();
            await blockGithub(
              Number(this.lease.job.telegram_user_id),
              err.retryAfterMs,
            );
            throw new Deferred(
              err.retryAfterMs,
              "Waiting for GitHub rate limit",
            );
          }
          if (
            err instanceof GithubHttpError &&
            [408, 425, 500, 502, 503, 504].includes(err.status)
          ) {
            this.concurrency.onFailure();
            throw new HttpError(err.status);
          }
          if (err instanceof Error && err.name === "TimeoutError")
            throw new TypeError("GitHub request timed out");
          throw err;
        }
      },
      { attempts: 5, baseMs: 1000, maxMs: 10_000, signal: this.lease.signal },
    );
  }
}
export interface TreeEntry {
  path: string;
  sha: string;
  type: string;
  mode: string;
}
/** Recursive API result may truncate. Fall back to complete per-directory traversal. */
export async function repositoryTree(
  api: WorkerGithub,
  repo: string,
  sha: string,
): Promise<TreeEntry[]> {
  const base = `/repos/${repo}/git/trees/`;
  const quick = await api.call<{ tree: TreeEntry[]; truncated: boolean }>(
    "GET",
    `${base}${sha}?recursive=1`,
  );
  if (!quick.truncated) return quick.tree;
  const result: TreeEntry[] = [],
    queue = [{ sha, prefix: "" }];
  while (queue.length) {
    const current = queue.pop()!;
    const part = await api.call<{ tree: TreeEntry[]; truncated: boolean }>(
      "GET",
      base + current.sha,
    );
    if (part.truncated)
      throw new Error("GitHub returned an incomplete directory tree");
    for (const e of part.tree) {
      const path = current.prefix + e.path;
      result.push({ ...e, path });
      if (e.type === "tree") queue.push({ sha: e.sha, prefix: path + "/" });
    }
    if (result.length > 200_000)
      throw new Error(
        "Repository tree exceeds the 200,000 entry processing limit",
      );
  }
  return result;
}
/** Bounds concurrent base64 allocation, independently of the request count. */
export class ByteGate {
  private used = 0;
  constructor(private readonly capacity = 64 * 1024 * 1024) {}
  async acquire(bytes: number, signal: AbortSignal): Promise<() => void> {
    while (this.used > 0 && this.used + bytes > this.capacity) {
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new Error("cancelled"));
          return;
        }
        const abort = () => {
          clearTimeout(timer);
          reject(new Error("cancelled"));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        }, 20);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
    if (signal.aborted) throw new Error("cancelled");
    this.used += bytes;
    return () => {
      this.used -= bytes;
    };
  }
}
