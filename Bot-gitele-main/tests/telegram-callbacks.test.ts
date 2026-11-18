import { describe, expect, it } from "vitest";
import { parseCallbackData } from "@/lib/telegram/callbacks";

describe("parseCallbackData", () => {
  it("parses repository picks and pages", () => {
    expect(parseCallbackData("pick:42")).toEqual({ kind: "pick", repoId: 42 });
    expect(parseCallbackData("repos:0")).toEqual({ kind: "repos", page: 0 });
  });

  it("rejects anything else", () => {
    expect(parseCallbackData("pick:abc")).toBeNull();
    expect(parseCallbackData("pick:1;DROP")).toBeNull();
    expect(parseCallbackData(undefined)).toBeNull();
  });
});
