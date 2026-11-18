import { expect, it, vi } from "vitest";
import { validateBranchName, getBranch } from "@/lib/github/branches";
it("accepts nested branch names and rejects path/ref injection", () => {
  for (const name of ["main", "feature/mobile", "release/v2.0"])
    expect(validateBranchName(name)).toBe(name);
  for (const name of [
    "../other",
    "a/../../b",
    "/main",
    "main?x=y",
    "main#hash",
    "a//b",
    "x.lock",
    "a@{b",
    "-bad",
  ])
    expect(() => validateBranchName(name)).toThrow();
});
