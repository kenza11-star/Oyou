import { describe, expect, it } from "vitest";
import {
  authorizeUploadToken,
  signUploadToken,
  verifyUploadToken,
} from "@/lib/upload/token";

const secret = Buffer.alloc(32, 3);
const jobId = "123e4567-e89b-42d3-a456-426614174000";
const NOW = 1_000_000;

describe("upload tokens", () => {
  it("verifies a fresh token", () => {
    const t = signUploadToken({ jobId, telegramUserId: 42 }, secret, NOW);
    expect(verifyUploadToken(t, secret, NOW + 1000)?.telegramUserId).toBe(42);
  });

  it("rejects an expired token", () => {
    const t = signUploadToken(
      { jobId, telegramUserId: 42 },
      secret,
      NOW,
      60_000,
    );
    expect(verifyUploadToken(t, secret, NOW + 60_000)).toBeNull();
  });

  it("rejects a token signed with another secret", () => {
    const t = signUploadToken({ jobId, telegramUserId: 42 }, secret, NOW);
    expect(verifyUploadToken(t, Buffer.alloc(32, 9), NOW)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const t = signUploadToken({ jobId, telegramUserId: 42 }, secret, NOW);
    const [, sig] = t.split(".");
    const forged = Buffer.from(
      JSON.stringify({ jobId, telegramUserId: 999, exp: NOW + 900_000 }),
    ).toString("base64url");
    expect(verifyUploadToken(`${forged}.${sig}`, secret, NOW)).toBeNull();
  });

  it("binds the token to one user and one job", () => {
    const t = signUploadToken({ jobId, telegramUserId: 42 }, secret, NOW);
    expect(authorizeUploadToken(t, secret, jobId, 42, NOW)).toBe(true);
    expect(authorizeUploadToken(t, secret, jobId, 43, NOW)).toBe(false);
    expect(
      authorizeUploadToken(
        t,
        secret,
        "00000000-0000-4000-8000-000000000000",
        42,
        NOW,
      ),
    ).toBe(false);
  });
});
