import { NextRequest, NextResponse } from "next/server";
import { loadEnv } from "@/lib/env";
import { consumeRateLimit } from "@/lib/rate-limit";
import { consumeLoginStateWithMessage } from "@/lib/auth/oauth-state";
import { exchangeCode, fetchGithubProfile } from "@/lib/github/oauth";
import { linkGithubAccount } from "@/lib/github/linking";
import { listAccessibleRepos } from "@/lib/github/repos";
import { logActivity } from "@/lib/activity";
import { markLoginResult, sendProfileCard } from "@/lib/telegram/menu";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function page(message: string, status = 200): NextResponse {
  // Only static strings are passed here, never request input.
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GitHub Manager</title></head><body style="font-family:system-ui;background:#121316;color:#e6e6e6;padding:24px"><p>${message}</p></body></html>`;
  return new NextResponse(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    },
  });
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code"),
    state = req.nextUrl.searchParams.get("state");
  if (!code || !state || code.length > 512 || state.length > 256)
    return page("Invalid request.", 400);
  let env;
  try {
    env = loadEnv();
  } catch {
    return page("Service configuration is unavailable.", 503);
  }
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  if (!(await consumeRateLimit(`cb:${ip}`, 20, 60)))
    return page("Too many attempts. Try again later.", 429);

  const consumed = await consumeLoginStateWithMessage(state);
  const telegramUserId = consumed?.telegramUserId ?? null;
  const loginMessageId = consumed?.messageId ?? null;
  if (telegramUserId === null) {
    return page(
      "This link is invalid, expired, or already used. Send /login in the bot to get a new one.",
      400,
    );
  }

  try {
    const token = await exchangeCode(env, code);
    const profile = await fetchGithubProfile(token.accessToken);
    const result = await linkGithubAccount(env, telegramUserId, profile, token);

    if (result === "owned_by_another_user") {
      await logActivity(
        telegramUserId,
        "github_connect",
        "failure",
        "account linked to another Telegram user",
      ).catch(() => undefined);
      await markLoginResult(
        env,
        telegramUserId,
        loginMessageId,
        false,
        "This GitHub account is already connected to another Telegram user.",
      );
      return page(
        "This GitHub account is already connected to another Telegram user.",
        409,
      );
    }

    await logActivity(telegramUserId, "github_connect", "success").catch(
      () => undefined,
    );
    await markLoginResult(
      env,
      telegramUserId,
      loginMessageId,
      true,
      `GitHub account @${profile.login} connected.`,
    );
    const accessible = await listAccessibleRepos(token.accessToken)
      .then((r) => r.length)
      .catch(() => null);
    await sendProfileCard(env, telegramUserId, profile, accessible).catch(() =>
      console.error("github connection notification unavailable"),
    );
    return page("GitHub account connected. You can return to Telegram.");
  } catch (err) {
    await logActivity(
      telegramUserId,
      "github_connect",
      "failure",
      err instanceof Error ? err.name : "unknown error",
    ).catch(() => undefined);
    await markLoginResult(
      env,
      telegramUserId,
      loginMessageId,
      false,
      "Could not complete GitHub authorization.",
    );
    return page(
      "Could not complete GitHub authorization. Send /login in the bot to try again.",
      502,
    );
  }
}
