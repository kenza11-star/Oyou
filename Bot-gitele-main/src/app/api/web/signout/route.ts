import { NextRequest } from "next/server";
import { withWebUser, json } from "@/lib/web/auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { db } from "@/lib/db";
/** Revokes every dashboard and upload session issued to this user. */
export async function POST(req: NextRequest) {
  return withWebUser(req, async ({ userId }) => {
    await db().query("update app.telegram_users set upload_session_version=upload_session_version+1 where id=$1", [userId]);
    return json({ ok: true });
  }, { requireGithub: false });
}
