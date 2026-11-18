import { NextRequest } from "next/server";
import { withWebUser, json } from "@/lib/web/auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { getUsableToken } from "@/lib/github/credentials";
import { assertRepoAccessible } from "@/lib/github/repos";
import { listRuns } from "@/lib/github/actions";
import { getUserState } from "@/lib/telegram/state";
export async function GET(req: NextRequest) {
  return withWebUser(req, async ({ userId, env }) => {
    const st = await getUserState(userId);
    if (!st.repoId || !st.repoFullName) return json({ repo: null, runs: [] });
    const cred = await getUsableToken(userId, env);
    if (!cred) return json({ error: "Akun GitHub belum terhubung.", code: "github_not_linked" }, 409);
    await assertRepoAccessible(cred.token, st.repoId);
    return json({ repo: st.repoFullName, runs: await listRuns(cred.token, st.repoFullName) });
  });
}
