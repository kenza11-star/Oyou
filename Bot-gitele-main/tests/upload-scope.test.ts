import { expect, it } from "vitest";
import { mintSessionToken, scopeFromBearer } from "@/lib/upload/session";
const key = Buffer.alloc(32, 1),
  scope = { repoId: 42, repoFullName: "owner/repo", branch: "main" };
it("authenticates the signed user and original repository scope", () => {
  const token = mintSessionToken(123, key, 1000, scope);
  expect(scopeFromBearer(`Bearer ${token}`, key, 1001)).toEqual({
    telegramUserId: 123,
    ...scope,
  });
  expect(scopeFromBearer(`Bearer ${token}`, key, 1000 + 30 * 60000)).toBeNull();
});
it("rejects old unscoped links for browser operations", () => {
  expect(
    scopeFromBearer(`Bearer ${mintSessionToken(123, key, 1000)}`, key, 1001),
  ).toBeNull();
});
