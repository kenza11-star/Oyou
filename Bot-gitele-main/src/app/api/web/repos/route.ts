import { NextRequest } from "next/server";
import { withWebUser, json } from "@/lib/web/auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { getUsableToken } from "@/lib/github/credentials";
import { listAccessibleRepos } from "@/lib/github/repos";
export async function GET(req: NextRequest) {
  return withWebUser(req, async ({ userId, env }) => {
    const cred = await getUsableToken(userId, env);
    if (!cred) return json({ error: "Akun GitHub belum terhubung.", code: "github_not_linked" }, 409);
    return json({ repos: await listAccessibleRepos(cred.token) });
  });
}
