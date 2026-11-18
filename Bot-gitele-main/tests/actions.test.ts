import { describe, expect, it } from "vitest";
import { runStatusLabel } from "@/lib/github/actions";

describe("runStatusLabel", () => {
  it("labels in-flight runs", () => {
    expect(runStatusLabel("queued", null)).toBe("Queued");
    expect(runStatusLabel("in_progress", null)).toBe("In progress");
  });

  it("maps completed conclusions", () => {
    expect(runStatusLabel("completed", "success")).toBe("Success");
    expect(runStatusLabel("completed", "failure")).toBe("Failed");
    expect(runStatusLabel("completed", "cancelled")).toBe("Cancelled");
  });
});
