import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { extractZip, validateEntryPath } from "@/lib/github/upload";

describe("validateEntryPath", () => {
  it.each(["src/index.ts", "README.md", "a/b/c.txt"])("accepts %s", (name) => {
    expect(validateEntryPath(name).ok).toBe(true);
  });

  it.each(["../x", "a/../../b", "/etc/passwd", "C:/win", "a\\b", ".git/config", "dir/.GIT/x", "a//b", "./a"])(
    "rejects %s",
    (name) => {
      expect(validateEntryPath(name).ok).toBe(false);
    },
  );
});

describe("extractZip", () => {
  it("returns the files of a safe archive", () => {
    const zip = zipSync({ "README.md": strToU8("hi"), "src/a.ts": strToU8("x") });
    const files = extractZip(zip).map((f) => f.path).sort();
    expect(files).toEqual(["README.md", "src/a.ts"]);
  });

  it("rejects an archive containing a traversal entry", () => {
    const zip = zipSync({ "../evil.txt": strToU8("x") });
    expect(() => extractZip(zip)).toThrow(/Unsafe ZIP entry/);
  });

  it("rejects bytes that are not a ZIP", () => {
    expect(() => extractZip(strToU8("not a zip"))).toThrow();
  });
});
