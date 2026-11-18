import { CALLBACK_PATH } from "../deployment/urls";
import { HttpError } from "../transfer/engine";
import type { AppEnv } from "../env";
import { GithubAuthError } from "./client";

export function redirectUri(env: Pick<AppEnv, "appUrl">): string {
  return `${env.appUrl}${CALLBACK_PATH}`;
}

export function authorizeUrl(
  env: Pick<AppEnv, "githubClientId" | "appUrl">,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: env.githubClientId,
    redirect_uri: redirectUri(env),
    state,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export interface GithubToken {
  accessToken: string;
  expiresAt: Date | null;
  refreshToken: string | null;
  refreshExpiresAt: Date | null;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
}

async function postToken(body: Record<string, string>): Promise<GithubToken> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 429 || res.status >= 500) throw new HttpError(res.status);
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !data.access_token) {
    throw new GithubAuthError(
      `GitHub token request failed: ${data.error ?? res.status}`,
    );
  }
  const now = Date.now();
  return {
    accessToken: data.access_token,
    expiresAt: data.expires_in ? new Date(now + data.expires_in * 1000) : null,
    refreshToken: data.refresh_token ?? null,
    refreshExpiresAt: data.refresh_token_expires_in
      ? new Date(now + data.refresh_token_expires_in * 1000)
      : null,
  };
}

export function exchangeCode(env: AppEnv, code: string): Promise<GithubToken> {
  return postToken({
    client_id: env.githubClientId,
    client_secret: env.githubClientSecret,
    code,
    redirect_uri: redirectUri(env),
  });
}

/** Refresh tokens rotate: store the new refresh token returned with each refresh. */
export function refreshAccessToken(
  env: AppEnv,
  refreshToken: string,
): Promise<GithubToken> {
  return postToken({
    client_id: env.githubClientId,
    client_secret: env.githubClientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

export interface GithubProfile {
  id: number;
  login: string;
  name?: string | null;
  avatarUrl?: string | null;
  bio?: string | null;
  location?: string | null;
  company?: string | null;
  publicRepos?: number;
  followers?: number;
  following?: number;
  createdAt?: string | null;
}

export async function fetchGithubProfile(
  accessToken: string,
): Promise<GithubProfile> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      authorization: `Bearer ${accessToken}`,
    },
  });
  if (res.status === 401)
    throw new GithubAuthError("GitHub rejected the new token");
  if (!res.ok)
    throw new Error(`GitHub user lookup failed with status ${res.status}`);
  const data = (await res.json()) as Record<string, unknown>;
  if (typeof data.id !== "number" || typeof data.login !== "string") {
    throw new Error("GitHub user response is missing id or login");
  }
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  return {
    id: data.id,
    login: data.login,
    name: str(data.name),
    avatarUrl: str(data.avatar_url),
    bio: str(data.bio),
    location: str(data.location),
    company: str(data.company),
    publicRepos: num(data.public_repos),
    followers: num(data.followers),
    following: num(data.following),
    createdAt: str(data.created_at),
  };
}
