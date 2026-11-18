import { describe, expect, it } from "vitest";
import { mintSessionToken, userFromBearer } from "@/lib/upload/session";
import { signUploadToken } from "@/lib/upload/token";

const secret = Buffer.alloc(32, 5);
const NOW = 1_000_000;

describe("session tokens", () => {
  it("identifies the Telegram user from a fresh session token", () => {
    const t = mintSessionToken(42, secret, NOW);
    expect(userFromBearer(`Bearer ${t}`, secret, NOW + 1000)).toBe(42);
  });

  it("rejects an expired session token", () => {
    const t = mintSessionToken(42, secret, NOW);
    expect(userFromBearer(`Bearer ${t}`, secret, NOW + 31 * 60_000)).toBeNull();
  });

  it("rejects a token issued for a job rather than a session", () => {
    const jobToken = signUploadToken(
      { jobId: "123e4567-e89b-42d3-a456-426614174000", telegramUserId: 42 },
      secret,
      NOW,
    );
    expect(userFromBearer(`Bearer ${jobToken}`, secret, NOW)).toBeNull();
  });

  it("rejects a missing or malformed header", () => {
    const t = mintSessionToken(42, secret, NOW);
    expect(userFromBearer(null, secret, NOW)).toBeNull();
    expect(userFromBearer(t, secret, NOW)).toBeNull();
    expect(userFromBearer("Bearer nope", secret, NOW)).toBeNull();
  });
});
