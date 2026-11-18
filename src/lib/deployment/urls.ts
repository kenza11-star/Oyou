export const PRODUCTION_ORIGIN = "https://bot-xsync-delta.vercel.app";
export const CALLBACK_PATH = "/github/callback";
export const WEBHOOK_PATH = "/api/telegram/webhook";
export function deploymentUrls(origin: string) {
  const base = new URL(origin);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw new Error("Deployment APP_URL must be an HTTPS origin.");
  return {
    origin: base.origin,
    callback: new URL(CALLBACK_PATH, base).toString(),
    webhook: new URL(WEBHOOK_PATH, base).toString(),
    health: new URL("/api/health", base).toString(),
  };
}
