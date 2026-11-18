import { NextRequest, NextResponse } from "next/server";
import { withUser } from "@/lib/upload/http";
import { cancelJob } from "@/lib/upload/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withUser(req, async (userId) => NextResponse.json(await cancelJob(userId, id)));
}
