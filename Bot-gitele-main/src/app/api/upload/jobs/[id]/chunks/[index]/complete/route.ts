import { NextRequest, NextResponse } from "next/server";
import { withUser, parseIndex } from "@/lib/upload/http";
import { completeChunk } from "@/lib/upload/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Verification downloads the chunk on the server (up to 45 MB) and hashes it.
export const maxDuration = 60;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; index: string }> },
) {
  const { id, index } = await params;
  return withUser(req, async (userId) => {
    const body = (await req.json().catch(() => null)) as {
      sha256?: unknown;
      size?: unknown;
      attemptId?: unknown;
    } | null;
    const result = await completeChunk(userId, id, parseIndex(index), {
      sha256: body?.sha256,
      size: body?.size,
      attemptId: body?.attemptId,
    });
    return NextResponse.json(result);
  });
}
