import { NextRequest } from "next/server";
import { withWebUser, json } from "@/lib/web/auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { getUserState } from "@/lib/telegram/state";
import { dispatchConfigured } from "@/lib/actions-worker/dispatch";
export async function GET(req: NextRequest) {
  return withWebUser(
    req,
    async ({ userId, githubLogin, env }) => {
      const st = await getUserState(userId);
      return json({
        github: githubLogin ? { login: githubLogin } : null,
        selection: st.repoId ? { repoId: st.repoId, repoFullName: st.repoFullName, branch: st.repoBranch } : null,
        installUrl: `https://github.com/apps/${env.githubAppSlug}/installations/new`,
        instantProcessing: dispatchConfigured(),
      });
    },
    { requireGithub: false },
  );
}
