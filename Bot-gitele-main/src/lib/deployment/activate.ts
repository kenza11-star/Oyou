import type { AppEnv } from "../env";
import { deploymentUrls } from "./urls";
type ActivationEnv = Pick<AppEnv, "telegramBotToken" | "telegramWebhookSecret" | "appUrl">;

export interface ActivationResult {
  registered: boolean;
  registrationVerified: boolean;
  deploymentProbeVerified: boolean;
  webhookUrl: string;
  callbackUrl: string;
  botUsername: string | null;
  pendingUpdates: number;
  /** Telegram's own last delivery error text (contains no token). Null when none. */
  lastDeliveryError: string | null;
  lastDeliveryErrorAt: number | null;
  /** Reported separately. Never blocks registration. */
  processing: { ready: boolean; problems: { area: string; code: string; hint: string }[] } | null;
  publicUserTestRequired: true;
}

/**
 * Essential readiness (app routes + core database) gates registration.
 * ZIP-processing readiness is reported but can never prevent /start from working.
 * Only fixed messages leave this module; fetch errors may contain bot URLs.
 */
export async function activateTelegram(
  env: ActivationEnv,
  fetcher: typeof fetch = fetch,
  register = true,
): Promise<ActivationResult> {
  const urls = deploymentUrls(env.appUrl);
  const probe = async (url: string, init: RequestInit = {}) => {
    try {
      return await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new Error("Deployment probe failed: network, TLS or redirect error.");
    }
  };
  const live = await probe(urls.health);
  const info = (await live.json().catch(() => null)) as { service?: string; version?: number } | null;
  if (!live.ok || info?.service !== "github-manager-bot" || !(Number(info.version) >= 4))
    throw new Error("Deployment probe failed: application health route is not available at APP_URL.");
  const callbackProbe = await probe(urls.callback);
  if (callbackProbe.status !== 400)
    throw new Error("Deployment probe failed: OAuth callback route is missing or does not reject an empty callback.");

  const ready = await probe(urls.health + "?ready=1", {
    headers: { "x-telegram-bot-api-secret-token": env.telegramWebhookSecret },
  });
  if (ready.status === 401)
    throw new Error(
      "Deployment probe failed: TELEGRAM_WEBHOOK_SECRET in this environment differs from the one deployed on Vercel.",
    );
  const readyData = (await ready.json().catch(() => null)) as {
    core?: { ready?: boolean; problems?: { area: string; code: string; hint: string }[] };
    processing?: { ready?: boolean; problems?: { area: string; code: string; hint: string }[] };
  } | null;
  if (!ready.ok || !readyData?.core?.ready) {
    const detail = (readyData?.core?.problems ?? []).map((p) => `${p.area}/${p.code}: ${p.hint}`).join(" | ");
    throw new Error(
      "Deployment probe failed: core readiness (environment, database, schema) is not satisfied. " + (detail || "No detail returned."),
    );
  }

  const post = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
  const denied = await probe(urls.webhook, post);
  if (denied.status !== 401) throw new Error("Deployment probe failed: webhook does not reject unauthenticated requests.");
  const accepted = await probe(urls.webhook, {
    ...post,
    headers: { ...post.headers, "x-telegram-bot-api-secret-token": env.telegramWebhookSecret },
  });
  if (!accepted.ok || (await accepted.json().catch(() => null))?.ok !== true)
    throw new Error("Deployment probe failed: webhook did not accept the authenticated no-op probe.");

  const api = async (method: string, body: unknown) => {
    let res: Response;
    try {
      res = await fetcher(`https://api.telegram.org/bot${env.telegramBotToken}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error(`Telegram ${method} failed: network or TLS error; token omitted.`);
    }
    const data = (await res.json().catch(() => null)) as { ok?: boolean; result?: unknown; description?: string } | null;
    if (!res.ok || !data?.ok)
      throw new Error(
        `Telegram ${method} failed (HTTP ${res.status})${res.status === 401 ? ": TELEGRAM_BOT_TOKEN was rejected" : ""}; token omitted.`,
      );
    return data.result;
  };

  const me = (await api("getMe", {})) as { username?: string };
  if (register) {
    await api("setWebhook", {
      url: urls.webhook,
      secret_token: env.telegramWebhookSecret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
      max_connections: 10,
    });
    await api("setMyCommands", {
      commands: [
        { command: "start", description: "Mulai" },
        { command: "login", description: "Hubungkan akun GitHub" },
        { command: "repos", description: "Pilih repositori" },
        { command: "upload", description: "Unggah ZIP" },
        { command: "web", description: "Buka dashboard web" },
        { command: "status", description: "Status akun & repo" },
        { command: "help", description: "Bantuan" },
      ],
    }).catch(() => undefined);
  }
  const webhook = (await api("getWebhookInfo", {})) as {
    url?: string;
    pending_update_count?: number;
    last_error_date?: number;
    last_error_message?: string;
  };
  if (webhook.url !== urls.webhook)
    throw new Error("Telegram registration verification failed: getWebhookInfo URL does not match APP_URL and the webhook route.");
  return {
    registered: register,
    registrationVerified: true,
    deploymentProbeVerified: true,
    webhookUrl: urls.webhook,
    callbackUrl: urls.callback,
    botUsername: me.username ?? null,
    pendingUpdates: webhook.pending_update_count ?? 0,
    lastDeliveryError: webhook.last_error_message?.slice(0, 200) ?? null,
    lastDeliveryErrorAt: webhook.last_error_date ?? null,
    processing: readyData.processing
      ? { ready: Boolean(readyData.processing.ready), problems: readyData.processing.problems ?? [] }
      : null,
    publicUserTestRequired: true,
  };
}
