import { describe, expect, it } from "vitest";
import { planChunks } from "@/lib/upload/chunks";
import { chunkObjectPath } from "@/lib/supabase/storage";
import { CHUNK_LIMITS, UPLOAD_LIMITS } from "@/lib/upload/limits";

const MiB = 1024 * 1024;

describe("planChunks", () => {
  it("covers every byte exactly once for a 100 MiB archive", () => {
    const plans = planChunks(100 * MiB, 8 * MiB);
    expect(plans).toHaveLength(13);
    expect(plans.reduce((s, p) => s + p.size, 0)).toBe(100 * MiB);
    plans.forEach((p, i) => {
      expect(p.index).toBe(i);
      if (i > 0) expect(p.start).toBe(plans[i - 1].end);
    });
    expect(plans[12].size).toBe(4 * MiB);
  });

  it("produces exact multiples without a short tail", () => {
    const plans = planChunks(16 * MiB, 8 * MiB);
    expect(plans.map((p) => p.size)).toEqual([8 * MiB, 8 * MiB]);
  });

  it("keeps every chunk under the Supabase Free 50 MB object limit", () => {
    expect(CHUNK_LIMITS.maxBytes).toBeLessThan(50 * MiB);
    expect(() => planChunks(MiB, 46 * MiB)).toThrow();
  });

  it("rejects archives above the web limit", () => {
    expect(() => planChunks(UPLOAD_LIMITS.webArchiveBytes + 1)).toThrow();
  });
});

describe("chunkObjectPath", () => {
  it("accepts server-generated ids only", () => {
    expect(chunkObjectPath("123e4567-e89b-42d3-a456-426614174000", 3)).toBe(
      "jobs/123e4567-e89b-42d3-a456-426614174000/chunk-00003.bin",
    );
    expect(() => chunkObjectPath("../etc", 0)).toThrow();
  });
});
