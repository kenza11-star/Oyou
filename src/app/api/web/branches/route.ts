import { NextRequest } from "next/server";
import { withWebUser, json } from "@/lib/web/auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { getUsableToken } from "@/lib/github/credentials";
import { assertRepoAccessible } from "@/lib/github/repos";
import { listBranches } from "@/lib/github/branches";
export async function GET(req: NextRequest) {
  return withWebUser(req, async ({ userId, env }) => {
    const repoId = Number(req.nextUrl.searchParams.get("repoId"));
    if (!Number.isSafeInteger(repoId) || repoId <= 0) return json({ error: "repoId tidak valid." }, 400);
    const cred = await getUsableToken(userId, env);
    if (!cred) return json({ error: "Akun GitHub belum terhubung.", code: "github_not_linked" }, 409);
    const repo = await assertRepoAccessible(cred.token, repoId);
    return json({ defaultBranch: repo.defaultBranch, branches: await listBranches(cred.token, repo.fullName) });
  });
}
