import { afterEach, expect, it, vi } from "vitest";
import { loadEnv } from "@/lib/env";
import { extractApk, downloadBinary } from "@/lib/github/actions";
import { zipSync, strToU8 } from "fflate";
const env = {
  TELEGRAM_BOT_TOKEN: "1:test",
  TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
  GITHUB_APP_ID: "1",
  GITHUB_CLIENT_ID: "id",
  GITHUB_CLIENT_SECRET: "s",
  GITHUB_APP_PRIVATE_KEY_BASE64: "x",
  GITHUB_WEBHOOK_SECRET: "s",
  GITHUB_APP_SLUG: "manager",
  DATABASE_URL: "postgresql://db/x",
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  TELEGRAM_ALLOWED_USER_IDS: "999",
  APP_URL: "https://bot-xsync-delta.vercel.app",
};
afterEach(() => vi.unstubAllGlobals());
it("rejects localhost HTTP in production and non-HTTP origin schemes", () => {
  expect(() =>
    loadEnv({
      ...env,
      APP_URL: "http://localhost:3000",
      NODE_ENV: "production",
    }),
  ).toThrow(/https/i);
  expect(() => loadEnv({ ...env, APP_URL: "ftp://localhost" })).toThrow();
});
it("rejects APP_URL credentials/path/query instead of silently dropping configuration", () => {
  for (const APP_URL of [
    "https://user:pass@bot-xsync-delta.vercel.app",
    "https://bot-xsync-delta.vercel.app/wrong",
    "https://bot-xsync-delta.vercel.app?secret=x",
  ])
    expect(() => loadEnv({ ...env, APP_URL })).toThrow();
});
it("rejects an artifact APK with corrupt CRC", () => {
  const zip = zipSync({ "app.apk": strToU8("unique-apk-bytes") }, { level: 0 });
  const at = Buffer.from(zip).indexOf("unique-apk-bytes");
  zip[at] ^= 1;
  expect(() => extractApk(zip)).toThrow(/CRC|checksum/i);
});
it("cancels a streamed download at the byte cap without buffering the entire response", async () => {
  let cancelled = false;
  // The finite safeguard makes the old arrayBuffer implementation fail rather than hang indefinitely.
  let chunks = 0;
  const finite = new ReadableStream<Uint8Array>({
    pull(c) {
      if (chunks++ < 10) c.enqueue(new Uint8Array(4));
      else c.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(finite)));
  await expect(
    downloadBinary(
      "private",
      "https://api.github.com/repos/a/b/releases/assets/1",
      3,
    ),
  ).rejects.toThrow(/large/i);
  expect(cancelled).toBe(true);
});
it("rejects unsafe asset redirects before following them", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/private" },
      }),
    );
  vi.stubGlobal("fetch", fetcher);
  await expect(
    downloadBinary(
      "private",
      "https://api.github.com/repos/a/b/releases/assets/1",
      20,
    ),
  ).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
