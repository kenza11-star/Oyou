import { afterEach, expect, it, vi } from "vitest";
import {
  createSignedUploadUrl,
  downloadObject,
  removeObjects,
} from "@/lib/supabase/storage";
const cfg = {
  url: "https://example.supabase.co",
  secretKey: "sb_secret_test",
  bucket: "github-uploads",
};
afterEach(() => vi.unstubAllGlobals());
it("downloads private objects through the authenticated endpoint without caching", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(new Uint8Array([1, 2])));
  vi.stubGlobal("fetch", fetcher);
  expect(await downloadObject(cfg, "jobs/x.bin")).toEqual(
    new Uint8Array([1, 2]),
  );
  expect(fetcher.mock.calls[0][0]).toBe(
    cfg.url + "/storage/v1/object/authenticated/github-uploads/jobs/x.bin",
  );
  expect(fetcher.mock.calls[0][1].cache).toBe("no-store");
});
it("creates non-upsert signed URLs and handles relative storage paths", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      Response.json({ url: "/object/upload/sign/github-uploads/x?token=t" }),
    );
  vi.stubGlobal("fetch", fetcher);
  expect(await createSignedUploadUrl(cfg, "x")).toBe(
    cfg.url + "/storage/v1/object/upload/sign/github-uploads/x?token=t",
  );
  expect(fetcher.mock.calls[0][1].headers["x-upsert"]).toBe("false");
});
it("rejects signed URLs pointing outside configured storage", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ url: "https://evil.test/upload?token=t" }),
      ),
  );
  await expect(createSignedUploadUrl(cfg, "x")).rejects.toThrow(/signed URL/i);
});
it("deletes only supplied prefixes with server credentials", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json([]));
  vi.stubGlobal("fetch", fetcher);
  await removeObjects(cfg, ["jobs/a"]);
  expect(fetcher.mock.calls[0][1].body).toBe(
    JSON.stringify({ prefixes: ["jobs/a"] }),
  );
});
it("does not buffer oversized objects during server verification", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(new Uint8Array(10), {
          headers: { "content-length": "10" },
        }),
      ),
  );
  await expect(downloadObject(cfg, "x", 3)).rejects.toThrow(/size|large/i);
});
it("maps storage JSON error codes and Retry-After without exposing signed URLs", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { statusCode: "404", error: "not found" },
          { status: 400, headers: { "retry-after": "2" } },
        ),
      ),
  );
  await expect(downloadObject(cfg, "x")).rejects.toMatchObject({
    status: 404,
    retryAfterMs: 2000,
  });
});
