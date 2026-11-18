import { expect, it } from "vitest";
import { resumeStorageKey } from "@/lib/upload/resume";
const scope = {
  telegramUserId: 1,
  repoId: 2,
  repoFullName: "a/b",
  branch: "main",
};
const file = { name: "p.zip", size: 10, lastModified: 100 };
it("separates users, repos, branches, and file bytes", () => {
  const base = resumeStorageKey(scope, file, "a".repeat(64));
  for (const s of [
    { ...scope, telegramUserId: 3 },
    { ...scope, repoId: 3 },
    { ...scope, branch: "dev" },
  ])
    expect(resumeStorageKey(s, file, "a".repeat(64))).not.toBe(base);
  expect(resumeStorageKey(scope, file, "b".repeat(64))).not.toBe(base);
});
