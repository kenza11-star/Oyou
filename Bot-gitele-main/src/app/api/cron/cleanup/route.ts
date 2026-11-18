import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { expireStaleUploads } from "@/lib/upload/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(header: string | null, secret: string): boolean {
  const a = Buffer.from(header ?? "");
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Deletes expired OAuth states, old rate-limit windows, old processed updates, and stale pending uploads. */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) {
    return new NextResponse("CRON_SECRET is not configured", { status: 503 });
  }
  if (!authorized(req.headers.get("authorization"), secret)) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  const states = await db().query(`delete from app.oauth_states where expires_at < now() - interval '1 day'`);
  const limits = await db().query(`delete from app.rate_limits where window_start < now() - interval '1 day'`);
  const updates = await db().query(`delete from app.processed_updates where received_at < now() - interval '7 days'`);
  const pending = await db().query(
    `update app.telegram_users set pending_action = null, pending_expires_at = null
     where pending_action is not null and pending_expires_at < now()`,
  );

  const uploadsExpired = await expireStaleUploads().catch(() => -1);

  return NextResponse.json({
    uploads_expired: uploadsExpired,
    oauth_states: states.rowCount ?? 0,
    rate_limits: limits.rowCount ?? 0,
    processed_updates: updates.rowCount ?? 0,
    pending_cleared: pending.rowCount ?? 0,
  });
}
