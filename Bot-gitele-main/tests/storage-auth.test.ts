import { describe, expect, it } from "vitest";
import { authHeadersFor, chunkObjectPath, storageConfig } from "@/lib/supabase/storage";
import { planChunks } from "@/lib/upload/chunks";

describe("authHeadersFor", () => {
  it("sends sb_secret keys in apikey only", () => {
    expect(authHeadersFor("sb_secret_example")).toEqual({ apikey: "sb_secret_example" });
  });

  it("also sends legacy JWT keys as a Bearer token", () => {
    expect(authHeadersFor("eyJhbGciOi...")).toEqual({ apikey: "eyJhbGciOi...", authorization: "Bearer eyJhbGciOi..." });
  });
});

describe("storageConfig", () => {
  it("reads the deployed variable names", () => {
    const cfg = storageConfig({
      SUPABASE_URL: "https://x.supabase.co/",
      SUPABASE_SECRET_KEY: "sb_secret_abc",
      SUPABASE_STORAGE_BUCKET: "github-uploads",
    });
    expect(cfg).toEqual({ url: "https://x.supabase.co", secretKey: "sb_secret_abc", bucket: "github-uploads" });
  });

  it("names every missing variable", () => {
    expect(() => storageConfig({})).toThrow(/SUPABASE_URL, SUPABASE_SECRET_KEY, SUPABASE_STORAGE_BUCKET/);
  });
});

describe("100 MiB upload layout", () => {
  const MiB = 1024 * 1024;

  it("gives every chunk a unique object path", () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const paths = planChunks(100 * MiB).map((p) => chunkObjectPath(id, p.index));
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("keeps every chunk under the 50 MB Free-plan object limit", () => {
    for (const p of planChunks(100 * MiB, 8 * MiB)) expect(p.size).toBeLessThan(50 * MiB);
  });
});
