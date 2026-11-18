export class EnvError extends Error {}

const REQUIRED = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "GITHUB_APP_ID",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY_BASE64",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_APP_SLUG",
  "DATABASE_URL",
  "ENCRYPTION_KEY",
  "TELEGRAM_ALLOWED_USER_IDS",
  "APP_URL",
] as const;

export interface AppEnv {
  telegramBotToken: string;
  telegramWebhookSecret: string;
  githubClientId: string;
  githubClientSecret: string;
  githubAppSlug: string;
  databaseUrl: string;
  encryptionKey: Buffer;
  /** Gates owner/admin commands only. Never gates normal bot usage. */
  allowedAdminIds: ReadonlySet<string>;
  appUrl: string;
}

export function loadEnv(
  source: Record<string, string | undefined> = process.env,
): AppEnv {
  const missing = REQUIRED.filter((name) => !source[name]?.trim());
  if (missing.length > 0) {
    throw new EnvError(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }

  const encryptionKey = Buffer.from(source.ENCRYPTION_KEY!.trim(), "base64");
  if (encryptionKey.length !== 32) {
    throw new EnvError(
      "ENCRYPTION_KEY must decode to exactly 32 bytes (base64).",
    );
  }

  const adminIds = source
    .TELEGRAM_ALLOWED_USER_IDS!.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!adminIds.every((id) => /^\d+$/.test(id))) {
    throw new EnvError(
      "TELEGRAM_ALLOWED_USER_IDS must be a comma-separated list of numeric Telegram IDs.",
    );
  }

  let appUrl: URL;
  try {
    appUrl = new URL(source.APP_URL!);
  } catch {
    throw new EnvError(
      "APP_URL must be an absolute URL, e.g. https://your-app.vercel.app",
    );
  }
  const developmentLoopback =
    source.NODE_ENV !== "production" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(appUrl.hostname) &&
    appUrl.protocol === "http:";
  if (appUrl.protocol !== "https:" && !developmentLoopback) {
    throw new EnvError("APP_URL must use https in production.");
  }

  if (
    appUrl.username ||
    appUrl.password ||
    appUrl.pathname !== "/" ||
    appUrl.search ||
    appUrl.hash
  )
    throw new EnvError(
      "APP_URL must be an origin only, without credentials, path, query or fragment.",
    );
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(source.TELEGRAM_WEBHOOK_SECRET!.trim()))
    throw new EnvError(
      "TELEGRAM_WEBHOOK_SECRET must use Telegram's permitted letters, digits, underscore or hyphen (1–256 characters).",
    );
  return {
    telegramBotToken: source.TELEGRAM_BOT_TOKEN!.trim(),
    telegramWebhookSecret: source.TELEGRAM_WEBHOOK_SECRET!.trim(),
    githubClientId: source.GITHUB_CLIENT_ID!.trim(),
    githubClientSecret: source.GITHUB_CLIENT_SECRET!.trim(),
    githubAppSlug: source.GITHUB_APP_SLUG!.trim(),
    databaseUrl: source.DATABASE_URL!.trim(),
    encryptionKey,
    allowedAdminIds: new Set(adminIds),
    appUrl: appUrl.origin,
  };
}
