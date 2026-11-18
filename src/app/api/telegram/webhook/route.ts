import { NextRequest, NextResponse } from "next/server";
import { loadEnv, EnvError } from "@/lib/env";
import { claimUpdate, finishUpdate } from "@/lib/telegram/update-claims";
import { verifyTelegramSecret } from "@/lib/telegram/webhook-auth";
import { handleMessage } from "@/lib/telegram/handlers";
import { handleCallback } from "@/lib/telegram/callbacks";
import { consumeRateLimit } from "@/lib/rate-limit";
import { describeDbError } from "@/lib/deployment/diagnostics";
import { sendMessage } from "@/lib/telegram/api";
import { MAX_UPDATE_FAILURES } from "@/lib/telegram/update-claims";
import type { TgUpdate } from "@/lib/telegram/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** A failing update is retried by Telegram. After this many failures it is dropped so it cannot block the queue. */
const retry = () => NextResponse.json({ ok: false }, { status: 503, headers: { "retry-after": "30" } });

// Logs contain only fixed reason codes, variable names and driver error codes. Never secrets, tokens or user content.
export async function POST(req: NextRequest) {
  let env;
  try {
    env = loadEnv();
  } catch (err) {
    console.error("[webhook] configuration invalid:", err instanceof EnvError ? err.message : "unknown");
    return retry();
  }

  const header = req.headers.get("x-telegram-bot-api-secret-token");
  if (!verifyTelegramSecret(header, env.telegramWebhookSecret)) {
    console.warn(`[webhook] rejected: ${header ? "secret token mismatch (re-run telegram:activate)" : "secret token header missing"}`);
    return new NextResponse("unauthorized", { status: 401 });
  }

  const update = (await req.json().catch(() => null)) as TgUpdate | null;
  if (!update || !Number.isSafeInteger(update.update_id)) return NextResponse.json({ ok: true });

  let claim;
  try {
    claim = await claimUpdate(update.update_id);
  } catch (err) {
    const p = describeDbError(err);
    console.error(`[webhook] database unavailable (${p.code}): ${p.hint}`);
    return retry();
  }
  if (claim.kind === "completed") return NextResponse.json({ ok: true });
  if (claim.kind === "busy") return retry();

  try {
    if (update.callback_query) await handleCallback(update.callback_query, env);
    else if (update.message) await handleMessage(update.message, env);
  } catch (err) {
    const name = err instanceof Error ? err.name : "unknown";
    const code = typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : "";
    console.error(`[webhook] update failed: ${name}${code ? ` (${code})` : ""}`);
    const mayRetry = await consumeRateLimit(`updfail:${update.update_id}`, MAX_UPDATE_FAILURES, 86_400).catch(() => true);
    if (mayRetry) {
      await finishUpdate(update.update_id, claim.token, false).catch(() => undefined);
      return retry();
    }
    // Poison update: tell the user once, mark it done so Telegram stops redelivering it.
    const chat = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
    if (chat && chat === (update.message?.from?.id ?? update.callback_query?.from.id))
      await sendMessage(env.telegramBotToken, chat, "Terjadi kesalahan saat memproses perintah itu. Coba lagi nanti.").catch(() => undefined);
    console.error("[webhook] update dropped after repeated failures");
  }

  if (!(await finishUpdate(update.update_id, claim.token, true).catch(() => false))) return retry();
  return NextResponse.json({ ok: true });
}
