import { NextRequest } from "next/server";
import { withWebUser, json } from "@/lib/web/auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { listJobs } from "@/lib/upload/service";
export async function GET(req: NextRequest) {
  return withWebUser(req, async ({ userId }) => json({ jobs: await listJobs(userId, 30) }), { requireGithub: false });
}
