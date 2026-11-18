import { describe, expect, it } from "vitest";
import { strToU8 } from "fflate";
import { gitBlobSha } from "@/lib/github/upload";

describe("gitBlobSha", () => {
  it("matches git's hash for 'hello\\n'", () => {
    expect(gitBlobSha(strToU8("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });
});
