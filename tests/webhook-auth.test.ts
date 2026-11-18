import { describe, expect, it } from "vitest";
import { verifyTelegramSecret } from "@/lib/telegram/webhook-auth";

describe("verifyTelegramSecret", () => {
  it("accepts the matching secret", () => {
    expect(verifyTelegramSecret("abc123", "abc123")).toBe(true);
  });

  it("rejects a different secret of the same length", () => {
    expect(verifyTelegramSecret("abc124", "abc123")).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyTelegramSecret(null, "abc123")).toBe(false);
  });

  it("rejects a secret of a different length", () => {
    expect(verifyTelegramSecret("abc", "abc123")).toBe(false);
  });
});
