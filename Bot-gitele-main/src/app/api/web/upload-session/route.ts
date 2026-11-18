import { NextRequest } from "next/server";
import { withWebUser, json } from "@/lib/web/auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { getUsableToken } from "@/lib/github/credentials";
import { assertRepoAccessible } from "@/lib/github/repos";
import { getBranch } from "@/lib/github/branches";
import { mintSessionToken } from "@/lib/upload/session";
import { db } from "@/lib/db";
/** Exchanges a dashboard session for a short-lived upload token bound to ONE verified repository and branch. */
export async function POST(req: NextRequest) {
  return withWebUser(req, async ({ userId, env }) => {
    const body = (await req.json().catch(() => null)) as { repoId?: unknown; branch?: unknown } | null;
    const repoId = Number(body?.repoId);
    if (!Number.isSafeInteger(repoId) || repoId <= 0 || typeof body?.branch !== "string")
      return json({ error: "Repositori dan branch wajib diisi." }, 400);
    const cred = await getUsableToken(userId, env);
    if (!cred) return json({ error: "Akun GitHub belum terhubung.", code: "github_not_linked" }, 409);
    const repo = await assertRepoAccessible(cred.token, repoId);
    const branch = await getBranch(cred.token, repo.fullName, body.branch);
    const v = await db().query<{ upload_session_version: number }>("select upload_session_version from app.telegram_users where id=$1", [userId]);
    const token = mintSessionToken(userId, env.encryptionKey, Date.now(), {
      repoId: repo.id,
      repoFullName: repo.fullName,
      branch,
      sessionVersion: v.rows[0].upload_session_version,
    });
    return json({ token, repoFullName: repo.fullName, branch });
  }, { limit: 30 });
}
