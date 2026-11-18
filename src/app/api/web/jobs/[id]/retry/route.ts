import { NextRequest } from "next/server";
import { withWebUser, json } from "@/lib/web/auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { retryJob } from "@/lib/upload/service";
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withWebUser(req, async ({ userId }) => {
    await retryJob(userId, id);
    return json({ ok: true });
  });
}
