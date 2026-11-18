import { NextRequest, NextResponse } from "next/server";
import { withUser } from "@/lib/upload/http";
import { markReady } from "@/lib/upload/service";

export const maxDuration = 60;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return withUser(req, async (userId) =>
    NextResponse.json(await markReady(userId, id)),
  );
}
