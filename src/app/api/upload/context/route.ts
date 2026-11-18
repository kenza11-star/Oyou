import { NextRequest, NextResponse } from "next/server";
import { withUser } from "@/lib/upload/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  return withUser(req, async (userId, scope) =>
    NextResponse.json({ telegramUserId: userId, ...scope }),
  );
}
