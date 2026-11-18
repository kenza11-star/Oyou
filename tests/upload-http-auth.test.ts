import { expect, it, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  credential: vi.fn(),
  limit: vi.fn(),
}));
const key = Buffer.alloc(32, 1);
vi.mock("@/lib/env", () => ({
  loadEnv: () => ({ encryptionKey: Buffer.alloc(32, 1) }),
}));
vi.mock("@/lib/db", () => ({ db: () => ({ query: mocks.query }) }));
vi.mock("@/lib/github/linking", () => ({
  getActiveGithubLogin: mocks.credential,
}));
vi.mock("@/lib/rate-limit", () => ({ consumeRateLimit: mocks.limit }));
import { withUser } from "@/lib/upload/http";
import { mintSessionToken } from "@/lib/upload/session";
const scope = { repoId: 42, repoFullName: "a/b", branch: "main" };
const id = "123e4567-e89b-42d3-a456-426614174000";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.credential.mockResolvedValue({ token: "private" });
  mocks.limit.mockResolvedValue(true);
  mocks.query.mockImplementation(async (sql: string) => ({
    rows: sql.includes("select upload_session_version")
      ? [{ upload_session_version: 0 }]
      : [],
  }));
});
function request(token: string, path = `/api/upload/jobs/${id}/ready`) {
  return new NextRequest("https://app.test" + path, {
    headers: { authorization: `Bearer ${token}` },
  });
}
it("rejects missing and expired upload credentials before database access", async () => {
  const handler = vi.fn();
  expect((await withUser(request("invalid"), handler)).status).toBe(401);
  expect(
    (await withUser(request(mintSessionToken(1, key, 0, scope)), handler))
      .status,
  ).toBe(401);
  expect(handler).not.toHaveBeenCalled();
  expect(mocks.query).not.toHaveBeenCalled();
});
it("rejects jobs not owned by the signed user AND original scope", async () => {
  const handler = vi.fn();
  expect(
    (
      await withUser(
        request(mintSessionToken(1, key, Date.now(), scope)),
        handler,
      )
    ).status,
  ).toBe(404);
  expect(
    mocks.query.mock.calls.find((call) =>
      String(call[0]).includes("repo_id"),
    )![1],
  ).toEqual([id, 1, 42, "a/b", "main"]);
  expect(handler).not.toHaveBeenCalled();
});
it("blocks upload sessions after GitHub disconnection", async () => {
  mocks.credential.mockResolvedValue(null);
  expect(
    (
      await withUser(
        request(mintSessionToken(1, key, Date.now(), scope)),
        vi.fn(),
      )
    ).status,
  ).toBe(401);
});
it("uses the signed user, allows normal users, and marks responses private", async () => {
  mocks.query.mockResolvedValue({ rows: [{ id, upload_session_version: 0 }] });
  const handler = vi.fn(async () => NextResponse.json({ ok: true }));
  const res = await withUser(
    request(mintSessionToken(1, key, Date.now(), scope)),
    handler,
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(handler).toHaveBeenCalledWith(1, { telegramUserId: 1, ...scope });
});
it("does not revive a signed upload session after logout and reauthentication", async () => {
  mocks.query.mockResolvedValue({ rows: [{ id, upload_session_version: 1 }] });
  const handler = vi.fn(async () => NextResponse.json({ ok: true }));
  expect(
    (
      await withUser(
        request(mintSessionToken(1, key, Date.now(), scope)),
        handler,
      )
    ).status,
  ).toBe(401);
  expect(handler).not.toHaveBeenCalled();
});
