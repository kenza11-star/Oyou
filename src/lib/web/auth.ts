import { NextRequest, NextResponse } from "next/server";
import { db } from "../db";
import { loadEnv, type AppEnv } from "../env";
import { consumeRateLimit } from "../rate-limit";
import { getActiveGithubLogin } from "../github/linking";
import { UploadError } from "../upload/service";
import { UserFacingError, GithubAuthError, GithubNotFoundError, GithubRateLimitError } from "../github/client";
import { webClaimsFromBearer } from "./session";

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

export interface WebUser {
  userId: number;
  githubLogin: string | null;
  env: AppEnv;
}

/**
 * Authenticates a dashboard request. The user id comes ONLY from the signed token; the token is revoked
 * by bumping upload_session_version (disconnect, re-link, "sign out everywhere").
 * requireGithub=false lets read-only pages explain an unlinked state instead of failing.
 */
export async function withWebUser(
  req: NextRequest,
  handler: (user: WebUser) => Promise<NextResponse>,
  options: { requireGithub?: boolean; limit?: number } = {},
): Promise<NextResponse> {
  try {
    const env = loadEnv();
    const claims = webClaimsFromBearer(req.headers.get("authorization"), env.encryptionKey);
    if (!claims) return json({ error: "Sesi tidak valid atau kedaluwarsa. Kirim /web di Telegram untuk membuka dashboard lagi." }, 401);
    const { rows } = await db().query<{ upload_session_version: number }>(
      "select upload_session_version from app.telegram_users where id=$1",
      [claims.telegramUserId],
    );
    if (!rows[0] || rows[0].upload_session_version !== claims.sessionVersion)
      return json({ error: "Sesi dicabut. Kirim /web di Telegram untuk masuk lagi." }, 401);
    if (!(await consumeRateLimit(`web:${claims.telegramUserId}`, options.limit ?? 120, 60)))
      return json({ error: "Terlalu banyak permintaan. Coba lagi sebentar." }, 429, { "retry-after": "60" });
    const githubLogin = await getActiveGithubLogin(claims.telegramUserId);
    if (!githubLogin && options.requireGithub !== false)
      return json({ error: "Akun GitHub belum terhubung. Kirim /login di Telegram.", code: "github_not_linked" }, 409);
    return await handler({ userId: claims.telegramUserId, githubLogin, env });
  } catch (err) {
    return mapError(err);
  }
}

export function mapError(err: unknown): NextResponse {
  if (err instanceof UploadError) return json({ error: err.message }, err.status);
  if (err instanceof GithubAuthError) return json({ error: "Sesi GitHub berakhir atau dicabut. Kirim /login di Telegram.", code: "github_auth" }, 401);
  if (err instanceof GithubRateLimitError) return json({ error: "Batas permintaan GitHub tercapai. Coba lagi nanti.", code: "github_rate_limit" }, 429);
  if (err instanceof GithubNotFoundError) return json({ error: "Repositori atau sumber daya tidak tersedia untuk instalasi GitHub App Anda.", code: "github_not_found" }, 404);
  if (err instanceof UserFacingError) return json({ error: err.message }, 400);
  console.error("[web] request failed:", err instanceof Error ? err.name : "unknown");
  return json({ error: "Terjadi kesalahan internal. Coba lagi." }, 500);
}
