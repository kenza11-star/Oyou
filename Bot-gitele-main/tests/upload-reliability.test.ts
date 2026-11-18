import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  download: vi.fn(),
  remove: vi.fn(),
  sign: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: () => ({
    query: mocks.query,
    connect: async () => ({ query: mocks.query, release: () => {} }),
  }),
}));
vi.mock("@/lib/supabase/storage", async (original) => ({
  ...(await original<typeof import("@/lib/supabase/storage")>()),
  storageConfig: () => ({}),
  downloadObject: mocks.download,
  removeObjects: mocks.remove,
  createSignedUploadUrl: mocks.sign,
}));
import { issueChunkUrl, completeChunk } from "@/lib/upload/service";
const id = "123e4567-e89b-42d3-a456-426614174000";
const job = {
  id,
  telegram_user_id: "1",
  status: "uploading",
  chunk_count: 1,
  total_bytes: "3",
  expires_at: new Date(Date.now() + 60000),
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.sign.mockResolvedValue("https://storage.test");
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes("select * from app.upload_jobs")) return { rows: [job] };
    if (sql.includes("select chunk_index"))
      return {
        rows: [{ chunk_index: 0, size: "3", status: "pending", sha256: null }],
      };
    if (sql.includes("select * from app.upload_job_chunks"))
      return {
        rows: [{ chunk_index: 0, size: "3", status: "pending", sha256: null }],
      };
    return { rows: [], rowCount: 1 };
  });
});
it("signing never deletes an object another request might be writing", async () => {
  await issueChunkUrl(1, id, 0);
  expect(mocks.remove).not.toHaveBeenCalled();
});
it("each concurrent sign owns a distinct immutable attempt path", async () => {
  const [a, b] = await Promise.all([
    issueChunkUrl(1, id, 0),
    issueChunkUrl(1, id, 0),
  ]);
  expect(a).toHaveProperty("attemptId");
  expect(b).toHaveProperty("attemptId");
  expect((a as any).attemptId).not.toBe((b as any).attemptId);
  expect(mocks.sign.mock.calls[0][1]).not.toBe(mocks.sign.mock.calls[1][1]);
});
it("rejects expired jobs before signing", async () => {
  const old = job.expires_at;
  job.expires_at = new Date(0);
  try {
    await expect(issueChunkUrl(1, id, 0)).rejects.toThrow(/expired/i);
  } finally {
    job.expires_at = old;
  }
});
it("completion requires an owned upload attempt before reading storage", async () => {
  await expect(
    completeChunk(1, id, 0, { sha256: "a".repeat(64), size: 3 }),
  ).rejects.toThrow(/attempt/i);
  expect(mocks.download).not.toHaveBeenCalled();
});
