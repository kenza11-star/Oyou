export class GithubAuthError extends Error {}
export class GithubRateLimitError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs = 60_000,
  ) {
    super(message);
  }
}
export class GithubNotFoundError extends Error {}
/** An error whose message is safe to show the Telegram user. */
export class UserFacingError extends Error {}

export class GithubHttpError extends UserFacingError {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const API = "https://api.github.com";

export interface GithubInit {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** Calls GitHub with the user's own token. Redirects are returned to the caller, never followed with the token. */
export async function githubRaw(
  token: string,
  pathOrUrl: string,
  init: GithubInit = {},
): Promise<Response> {
  const url = pathOrUrl.startsWith("https://")
    ? pathOrUrl
    : `${API}${pathOrUrl}`;
  if (new URL(url).origin !== API)
    throw new Error("Untrusted GitHub API URL origin");
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${token}`,
    ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    ...(init.headers ?? {}),
  };
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers,
    body: init.body,
    redirect: "manual",
    signal: init.signal ?? AbortSignal.timeout(60_000),
    cache: "no-store",
  });

  if (res.status === 401)
    throw new GithubAuthError("GitHub rejected the stored credential");
  if (res.status === 404) throw new GithubNotFoundError("Not found");
  const detail = !res.ok
    ? ((await res
        .clone()
        .json()
        .catch(() => ({}))) as { message?: string })
    : {};
  if (
    res.status === 429 ||
    (res.status === 403 &&
      (res.headers.get("x-ratelimit-remaining") === "0" ||
        res.headers.has("retry-after") ||
        /secondary rate|rate limit|abuse detection/i.test(
          detail.message ?? "",
        )))
  ) {
    const hint = res.headers.get("retry-after"),
      seconds = hint ? Number(hint) : NaN;
    const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
    const retry = Number.isFinite(seconds)
      ? seconds * 1000
      : hint && Number.isFinite(Date.parse(hint))
        ? Date.parse(hint) - Date.now()
        : res.headers.get("x-ratelimit-remaining") === "0" && reset > Date.now()
          ? reset - Date.now()
          : 60_000;
    throw new GithubRateLimitError(
      "GitHub rate limit reached",
      Math.max(1000, retry),
    );
  }
  if (!res.ok && ![301, 302, 307, 308].includes(res.status)) {
    throw new GithubHttpError(
      res.status,
      `GitHub request failed with status ${res.status}`,
    );
  }
  return res;
}

export async function github<T>(
  token: string,
  path: string,
  init: GithubInit = {},
): Promise<T> {
  const res = await githubRaw(token, path, init);
  return (await res.json()) as T;
}
