import { NextRequest, NextResponse } from "next/server";
import { withUser, parseIndex } from "@/lib/upload/http";
import { issueChunkUrl } from "@/lib/upload/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; index: string }> }) {
  const { id, index } = await params;
  return withUser(req, async (userId) => {
    const result = await issueChunkUrl(userId, id, parseIndex(index));
    return NextResponse.json(result);
  });
}
