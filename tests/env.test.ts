import { describe, expect, it } from "vitest";
import { loadEnv, EnvError } from "@/lib/env";

const key = Buffer.alloc(32, 7).toString("base64");
const valid = {
  TELEGRAM_BOT_TOKEN: "123:abc",
  TELEGRAM_WEBHOOK_SECRET: "secret",
  GITHUB_APP_ID: "1",
  GITHUB_CLIENT_ID: "Iv1.x",
  GITHUB_CLIENT_SECRET: "s",
  GITHUB_APP_PRIVATE_KEY_BASE64: "a",
  GITHUB_WEBHOOK_SECRET: "w",
  GITHUB_APP_SLUG: "gm",
  DATABASE_URL: "postgres://x",
  ENCRYPTION_KEY: key,
  TELEGRAM_ALLOWED_USER_IDS: "111, 222",
  APP_URL: "https://example.vercel.app",
};

describe("loadEnv", () => {
  it("accepts a complete environment", () => {
    const env = loadEnv(valid);
    expect(env.allowedAdminIds.has("222")).toBe(true);
    expect(env.encryptionKey.length).toBe(32);
  });

  it("lists every missing variable", () => {
    expect(() => loadEnv({ ...valid, TELEGRAM_BOT_TOKEN: "", DATABASE_URL: undefined })).toThrow(
      /TELEGRAM_BOT_TOKEN, DATABASE_URL/,
    );
  });

  it("rejects an encryption key that is not 32 bytes", () => {
    expect(() => loadEnv({ ...valid, ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") })).toThrow(EnvError);
  });

  it("rejects non-numeric admin IDs", () => {
    expect(() => loadEnv({ ...valid, TELEGRAM_ALLOWED_USER_IDS: "alice" })).toThrow(EnvError);
  });

  it("rejects plain http APP_URL", () => {
    expect(() => loadEnv({ ...valid, APP_URL: "http://example.com" })).toThrow(EnvError);
  });
});
