import { activateTelegram } from "../src/lib/deployment/activate";
import { deploymentUrls, PRODUCTION_ORIGIN } from "../src/lib/deployment/urls";
/** Activation needs only three values, so it works from CI without the full application environment. */
function activationEnv() {
  const need = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "APP_URL"].filter((k) => !process.env[k]?.trim());
  if (need.length) throw new Error(`Missing required environment variables: ${need.join(", ")}`);
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(process.env.TELEGRAM_WEBHOOK_SECRET!.trim()))
    throw new Error("TELEGRAM_WEBHOOK_SECRET must use letters, digits, underscore or hyphen only.");
  return {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN!.trim(),
    telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET!.trim(),
    appUrl: new URL(process.env.APP_URL!.trim()).origin,
  };
}
async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help")) {
    console.log(
      "Usage: npm run telegram:activate -- [--check | --dry-run | --soft]\nDefault: probes core readiness, then setWebhook + getWebhookInfo. --check: no setWebhook. --dry-run: print public URLs. --soft: never exit non-zero (used by the Vercel build). ZIP-processing readiness is reported, never required. Secrets come from ENV and are never printed.",
    );
    return;
  }
  if ([...args].some((a) => !["--check", "--dry-run", "--soft"].includes(a))) throw new Error("Unknown option; use --help.");
  if (args.has("--dry-run")) {
    console.log(JSON.stringify({ registered: false, ...deploymentUrls(process.env.APP_URL ?? PRODUCTION_ORIGIN) }, null, 2));
    return;
  }
  try {
    const result = await activateTelegram(activationEnv(), fetch, !args.has("--check"));
    console.log(JSON.stringify(result, null, 2));
    if (result.lastDeliveryError) console.log("Telegram reports a past delivery error (above). Send /start and re-run with --check to see whether it is current.");
    if (result.processing && !result.processing.ready) console.log("ZIP processing is not fully ready (reported only; /start is unaffected).");
  } catch (err) {
    console.error(err instanceof Error ? err.message : "Activation failed; details omitted.");
    process.exitCode = args.has("--soft") ? 0 : 1;
  }
}
main();
