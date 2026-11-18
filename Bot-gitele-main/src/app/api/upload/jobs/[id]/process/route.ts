import { NextRequest, NextResponse } from "next/server";
import { withUser } from "@/lib/upload/http";
import { processJobNow } from "@/lib/upload/service";

export const maxDuration = 300;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Publishes a fully uploaded ZIP to GitHub immediately (no waiting for the scheduled queue). */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return withUser(req, async (userId) =>
    NextResponse.json(await processJobNow(userId, id)),
  );
}
