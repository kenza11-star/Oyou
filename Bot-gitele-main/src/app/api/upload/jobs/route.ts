import { NextRequest, NextResponse } from "next/server";
import { withUser } from "@/lib/upload/http";
import { createOrResumeJob, validateNewJob } from "@/lib/upload/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return withUser(req, async (userId, scope) => {
    const body = await req.json().catch(() => null);
    const input = validateNewJob(body);
    const job = await createOrResumeJob(userId, input, scope);
    return NextResponse.json(job);
  });
}
