import { NextRequest } from "next/server";
import { withWebUser, json } from "@/lib/web/auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { getUsableToken } from "@/lib/github/credentials";
import { assertRepoAccessible } from "@/lib/github/repos";
import { getBranch } from "@/lib/github/branches";
import { setSelectedRepo } from "@/lib/telegram/state";
export async function POST(req: NextRequest) {
  return withWebUser(req, async ({ userId, env }) => {
    const body = (await req.json().catch(() => null)) as { repoId?: unknown; branch?: unknown } | null;
    const repoId = Number(body?.repoId);
    if (!Number.isSafeInteger(repoId) || repoId <= 0) return json({ error: "repoId tidak valid." }, 400);
    const cred = await getUsableToken(userId, env);
    if (!cred) return json({ error: "Akun GitHub belum terhubung.", code: "github_not_linked" }, 409);
    const repo = await assertRepoAccessible(cred.token, repoId);
    const branch = typeof body?.branch === "string" && body.branch ? await getBranch(cred.token, repo.fullName, body.branch) : repo.defaultBranch;
    await setSelectedRepo(userId, repo.id, repo.fullName, branch);
    return json({ repoId: repo.id, repoFullName: repo.fullName, branch });
  });
}
