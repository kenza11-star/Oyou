import { describe, expect, it } from "vitest";
import { isAdmin } from "@/lib/auth/admin";
import { authorizeUrl } from "@/lib/github/oauth";
import { hashState } from "@/lib/auth/oauth-state";
import type { AppEnv } from "@/lib/env";

const env: AppEnv = {
  telegramBotToken: "t",
  telegramWebhookSecret: "s",
  githubAppSlug: "test-app",
  githubClientId: "Iv1.abc",
  githubClientSecret: "super-secret-value",
  databaseUrl: "postgres://x",
  encryptionKey: Buffer.alloc(32),
  allowedAdminIds: new Set(["111"]),
  appUrl: "https://example.vercel.app",
};

describe("admin gating", () => {
  it("allows only listed Telegram IDs", () => {
    expect(isAdmin(env, "111")).toBe(true);
    expect(isAdmin(env, "999")).toBe(false);
  });
});

describe("GitHub authorize URL", () => {
  const url = new URL(authorizeUrl(env, "state-abc"));

  it("targets GitHub with the client ID, state, and callback", () => {
    expect(url.origin).toBe("https://github.com");
    expect(url.searchParams.get("client_id")).toBe("Iv1.abc");
    expect(url.searchParams.get("state")).toBe("state-abc");
    expect(url.searchParams.get("redirect_uri")).toBe("https://example.vercel.app/github/callback");
  });

  it("never includes the client secret", () => {
    expect(authorizeUrl(env, "state-abc")).not.toContain("super-secret-value");
  });
});

describe("state hashing", () => {
  it("is deterministic and does not equal the raw state", () => {
    expect(hashState("abc")).toBe(hashState("abc"));
    expect(hashState("abc")).not.toBe("abc");
  });
});
