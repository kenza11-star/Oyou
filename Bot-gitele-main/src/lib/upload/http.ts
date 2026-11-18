import { db } from "../db";
import { getActiveGithubLogin } from "../github/linking";
import { NextRequest, NextResponse } from "next/server";
import { loadEnv } from "../env";
import { consumeRateLimit } from "../rate-limit";
import { scopeFromBearer, type UploadScope } from "./session";
import { UploadError, isUuid } from "./service";

export function errorResponse(
  status: number,
  message: string,
  headers?: Record<string, string>,
): NextResponse {
  return NextResponse.json(
    { error: message },
    { status, headers: { "cache-control": "no-store", ...headers } },
  );
}

/**
 * Authenticates the caller from the session token, applies a per-user rate limit, and maps errors.
 * The user ID comes only from the signed token, never from the request body or URL.
 */
export async function withUser(
  req: NextRequest,
  handler: (userId: number, scope: UploadScope) => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    const env = loadEnv();
    const scope = scopeFromBearer(
      req.headers.get("authorization"),
      env.encryptionKey,
    );
    if (scope === null)
      return errorResponse(401, "Open the upload link from Telegram again.");
    const userId = scope.telegramUserId;
    // Disconnecting GitHub also disables previously issued upload sessions.
    if (!(await getActiveGithubLogin(userId)))
      return errorResponse(401, "Connect GitHub again with /login.");
    const version = await db().query<{ upload_session_version: number }>(
      "select upload_session_version from app.telegram_users where id=$1",
      [userId],
    );
    if (
      !version.rows[0] ||
      version.rows[0].upload_session_version !== (scope.sessionVersion ?? 0)
    )
      return errorResponse(
        401,
        "This upload session was revoked. Open /upload in Telegram again.",
      );
    const jobId = /\/jobs\/([^/]+)/.exec(req.nextUrl.pathname)?.[1];
    if (jobId) {
      if (!isUuid(jobId)) return errorResponse(404, "Upload not found");
      const { rows } = await db().query(
        "select id from app.upload_jobs where id=$1 and telegram_user_id=$2 and repo_id=$3 and repo_full_name=$4 and branch=$5",
        [jobId, userId, scope.repoId, scope.repoFullName, scope.branch],
      );
      if (!rows[0]) return errorResponse(404, "Upload not found");
    }
    if (!(await consumeRateLimit(`upload:${userId}`, 300, 60))) {
      return errorResponse(429, "Too many upload requests. Slow down.", {
        "retry-after": "60",
      });
    }
    const response = await handler(userId, scope);
    response.headers.set("cache-control", "no-store");
    return response;
  } catch (err) {
    if (err instanceof UploadError)
      return errorResponse(err.status, err.message);
    console.error("upload route", err instanceof Error ? err.name : "unknown");
    return errorResponse(500, "Internal error. Try again.");
  }
}

export function parseIndex(raw: string): number {
  if (!/^\d{1,4}$/.test(raw))
    throw new UploadError(400, "Chunk index must be a whole number");
  return Number(raw);
}
