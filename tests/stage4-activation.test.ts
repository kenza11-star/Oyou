import { expect, it, vi } from "vitest";
import { activateTelegram } from "@/lib/deployment/activate";
const env = {
  telegramBotToken: "123:NEVER_PRINT_TOKEN",
  telegramWebhookSecret: "safe-secret",
  appUrl: "https://bot-xsync-delta.vercel.app",
};
it("checks readiness/routes then registers and verifies the exact deployed webhook", async () => {
  const calls: any[] = [];
  const fetcher = vi.fn(async (url: string, init: any = {}) => {
    calls.push({ url, init });
    if (url.endsWith("/github/callback"))
      return new Response("Invalid request", { status: 400 });
    if (url.endsWith("/api/health?ready=1"))
      return Response.json({
        status: "ready",
        core: { ready: true, checks: { env: true, database: true, schema: true }, problems: [] },
        processing: { ready: false, problems: [{ area: "dispatch", code: "X", hint: "optional" }] },
      });
    if (url.endsWith("/api/health"))
      return Response.json({
        service: "github-manager-bot",
        version: 4,
        status: "ok",
      });
    if (url.endsWith("/api/telegram/webhook"))
      return init.headers?.["x-telegram-bot-api-secret-token"] ===
        env.telegramWebhookSecret
        ? Response.json({ ok: true })
        : new Response("unauthorized", { status: 401 });
    if (url.endsWith("/getMe")) return Response.json({ ok: true, result: { username: "kynx_bot" } });
    if (url.endsWith("/setMyCommands")) return Response.json({ ok: true, result: true });
    if (url.endsWith("/setWebhook"))
      return Response.json({ ok: true, result: true });
    if (url.endsWith("/getWebhookInfo"))
      return Response.json({
        ok: true,
        result: {
          url: env.appUrl + "/api/telegram/webhook",
          pending_update_count: 0,
        },
      });
    throw new Error("unknown");
  });
  const result = await activateTelegram(env, fetcher as typeof fetch);
  expect(result.registered).toBe(true);
  // A stopped/unconfigured ZIP processor is reported, never required.
  expect(result.processing?.ready).toBe(false);
  expect(result.botUsername).toBe("kynx_bot");
  const body = JSON.parse(
    calls.find((c) => c.url.endsWith("/setWebhook")).init.body,
  );
  expect(body.secret_token).toBe(env.telegramWebhookSecret);
  expect(body.drop_pending_updates).toBe(false);
  expect(body.url).toBe(
    "https://bot-xsync-delta.vercel.app/api/telegram/webhook",
  );
  expect(JSON.stringify(result)).not.toContain(env.telegramBotToken);
  expect(JSON.stringify(result)).not.toContain(env.telegramWebhookSecret);
});
it("does not register anything when the deployed app/worker is not ready", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      Response.json({ status: "unavailable" }, { status: 503 }),
    );
  await expect(activateTelegram(env, fetcher)).rejects.toThrow();
  expect(
    fetcher.mock.calls.some((c) => String(c[0]).includes("/setWebhook")),
  ).toBe(false);
});
it("never exposes tokens from a transport error", async () => {
  await expect(
    activateTelegram(
      env,
      vi.fn().mockRejectedValue(new Error("leak " + env.telegramBotToken)),
    ),
  ).rejects.toThrow(/^Deployment probe failed/);
});

it("registers even when ZIP processing is unavailable but core is ready", async () => {
  const fetcher = vi.fn(async (url: string, init: any = {}) => {
    if (url.endsWith("/github/callback")) return new Response("x", { status: 400 });
    if (url.endsWith("/api/health?ready=1"))
      return Response.json({ status: "ready", core: { ready: true, problems: [] }, processing: { ready: false, problems: [] } });
    if (url.endsWith("/api/health")) return Response.json({ service: "github-manager-bot", version: 5 });
    if (url.endsWith("/api/telegram/webhook"))
      return init.headers?.["x-telegram-bot-api-secret-token"] === env.telegramWebhookSecret ? Response.json({ ok: true }) : new Response("no", { status: 401 });
    if (url.endsWith("/getMe")) return Response.json({ ok: true, result: {} });
    if (url.endsWith("/setMyCommands") || url.endsWith("/setWebhook")) return Response.json({ ok: true, result: true });
    if (url.endsWith("/getWebhookInfo")) return Response.json({ ok: true, result: { url: env.appUrl + "/api/telegram/webhook", last_error_message: "Wrong response from the webhook: 401 Unauthorized" } });
    throw new Error("unknown " + url);
  });
  const r = await activateTelegram(env, fetcher as typeof fetch);
  expect(r.registered).toBe(true);
  expect(r.lastDeliveryError).toContain("401");
});

it("refuses to register when CORE readiness fails and explains why", async () => {
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith("/github/callback")) return new Response("x", { status: 400 });
    if (url.endsWith("/api/health?ready=1"))
      return Response.json({ status: "unavailable", core: { ready: false, problems: [{ area: "database", code: "SELF_SIGNED_CERT_IN_CHAIN", hint: "set DATABASE_CA_CERT" }] } }, { status: 503 });
    if (url.endsWith("/api/health")) return Response.json({ service: "github-manager-bot", version: 5 });
    throw new Error("unexpected " + url);
  });
  await expect(activateTelegram(env, fetcher as typeof fetch)).rejects.toThrow(/DATABASE_CA_CERT/);
  expect(fetcher.mock.calls.some((c) => String(c[0]).includes("/setWebhook"))).toBe(false);
});
