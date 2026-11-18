import { NextRequest } from "next/server";
import { withWebUser, json } from "@/lib/web/auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { getUsableToken, revokeGrant } from "@/lib/github/credentials";
import { unlinkGithubAccount } from "@/lib/github/linking";
import { clearSelection } from "@/lib/telegram/state";
import { logActivity } from "@/lib/activity";
export async function POST(req: NextRequest) {
  return withWebUser(req, async ({ userId, env }) => {
    const cred = await getUsableToken(userId, env).catch(() => null);
    const revoked = cred ? await revokeGrant(env, cred.token).catch(() => false) : false;
    await unlinkGithubAccount(userId);
    await clearSelection(userId);
    await logActivity(userId, "github_disconnect", "success", revoked ? undefined : "grant not confirmed revoked").catch(() => undefined);
    return json({ ok: true, revoked });
  }, { requireGithub: false });
}
