import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, expect, it, vi } from "vitest";
// Real SQL and constraints, with a single-connection adapter for PGlite.
// This does not simulate multi-connection Postgres lock contention.
const state = vi.hoisted(() => ({
  engine: null as any,
  objects: new Map<string, Uint8Array>(),
  onDownload: null as null | (() => Promise<void>),
}));
vi.mock("@/lib/db", () => ({
  db: () => ({
    query: (s: string, p?: unknown[]) => state.engine.query(s, p),
    connect: async () => ({
      query: (s: string, p?: unknown[]) => state.engine.query(s, p),
      release: () => {},
    }),
  }),
}));
vi.mock("@/lib/env", () => ({ loadEnv: () => ({}) }));
vi.mock("@/lib/github/credentials", () => ({
  getUsableToken: async () => ({ token: "test" }),
}));
vi.mock("@/lib/github/repos", () => ({
  assertRepoAccessible: async () => ({}),
}));
vi.mock("@/lib/supabase/storage", async (original) => ({
  ...(await original<typeof import("@/lib/supabase/storage")>()),
  storageConfig: () => ({}),
  createSignedUploadUrl: async (_: unknown, path: string) =>
    `https://storage.test/${path}`,
  downloadObject: async (_: unknown, path: string) => {
    await state.onDownload?.();
    const b = state.objects.get(path);
    if (!b) throw new Error("missing object");
    return b;
  },
  removeObjects: async (_: unknown, paths: string[]) => {
    paths.forEach((p) => state.objects.delete(p));
  },
}));
import {
  createOrResumeJob,
  issueChunkUrl,
  completeChunk,
  markReady,
  cancelJob,
  getJobSummary,
  expireStaleUploads,
} from "@/lib/upload/service";
const scope = { repoId: 42, repoFullName: "owner/repo", branch: "main" };
const bytes = new Uint8Array([1, 2, 3]);
const sha = createHash("sha256").update(bytes).digest("hex");
const input = () => ({
  fileName: "p.zip",
  totalBytes: 3,
  clientKey: randomUUID(),
  fileSha256: sha,
});
beforeAll(async () => {
  state.engine = new PGlite();
  await state.engine.exec("create role anon; create role authenticated;");
  for (const name of readdirSync("db/migrations").sort())
    await state.engine.exec(readFileSync(`db/migrations/${name}`, "utf8"));
  await state.engine.query("insert into app.telegram_users(id) values (1),(2)");
}, 30000);
afterAll(async () => {
  await state.engine?.close();
});
beforeEach(async () => {
  state.objects.clear();
  state.onDownload = null;
  await state.engine.query("delete from app.upload_jobs");
});
async function upload(id: string, index = 0, data = bytes) {
  const signed = await issueChunkUrl(1, id, index);
  if (signed.verified) throw new Error("already verified");
  const path = decodeURI(new URL(signed.url).pathname.slice(1));
  state.objects.set(path, data);
  return {
    attemptId: signed.attemptId,
    sha256: createHash("sha256").update(data).digest("hex"),
    size: data.length,
  };
}
it("runs all migrations and preserves legacy rows when 0004/0005 are re-run", async () => {
  const legacy = randomUUID();
  await state.engine.query(
    "insert into app.upload_jobs(id,telegram_user_id,storage_path,status,expires_at) values ($1,1,$2,'awaiting_upload',now()+interval '1 day')",
    [legacy, legacy],
  );
  await state.engine.exec(
    readFileSync("db/migrations/0004_upload_jobs.sql", "utf8"),
  );
  await state.engine.exec(
    readFileSync("db/migrations/0005_upload_safety.sql", "utf8"),
  );
  expect(
    (
      await state.engine.query(
        "select status from app.upload_jobs where id=$1",
        [legacy],
      )
    ).rows[0].status,
  ).toBe("awaiting_upload");
});
it("resumes the same file while rejecting a different user/repo/branch/checksum", async () => {
  const data = input(),
    job = await createOrResumeJob(1, data, scope);
  expect((await createOrResumeJob(1, data, scope)).id).toBe(job.id);
  for (const other of [
    { ...scope, repoId: 43 },
    { ...scope, branch: "dev" },
  ])
    await expect(createOrResumeJob(1, data, other)).rejects.toThrow(
      /different file or repository/,
    );
  await expect(
    createOrResumeJob(1, { ...data, fileSha256: "a".repeat(64) }, scope),
  ).rejects.toThrow(/different file/);
  await expect(getJobSummary(2, job.id)).rejects.toThrow(/not found/);
});
it("verifies actual bytes, completes idempotently, and never re-signs verified chunks", async () => {
  const job = await createOrResumeJob(1, input(), scope);
  const body = await upload(job.id);
  await expect(
    completeChunk(1, job.id, 0, { ...body, sha256: "a".repeat(64) }),
  ).rejects.toThrow(/Checksum/);
  expect((await getJobSummary(1, job.id)).bytesVerified).toBe(0);
  await completeChunk(1, job.id, 0, body);
  await completeChunk(1, job.id, 0, body);
  expect((await getJobSummary(1, job.id)).bytesVerified).toBe(3);
  expect(await issueChunkUrl(1, job.id, 0)).toEqual({ verified: true });
  await expect(
    completeChunk(1, job.id, 0, { ...body, sha256: "b".repeat(64) }),
  ).rejects.toThrow(/different checksum/);
  expect((await markReady(1, job.id)).status).toBe("uploaded");
  await expect(completeChunk(1, job.id, 0, body)).resolves.toEqual({
    verified: true,
  });
  expect((await markReady(1, job.id)).status).toBe("uploaded");
});
it("prevents missing chunks from enqueueing; whole-file verification belongs to the worker", async () => {
  const job = await createOrResumeJob(
    1,
    { ...input(), fileSha256: "a".repeat(64) },
    scope,
  );
  await expect(markReady(1, job.id)).rejects.toThrow(/incomplete/);
  await completeChunk(1, job.id, 0, await upload(job.id));
  expect((await markReady(1, job.id)).status).toBe("uploaded");
  // Stage 3 worker checks the full archive before any Git mutation.
});
it("stale attempts cannot change the winning verified object", async () => {
  const job = await createOrResumeJob(1, input(), scope);
  const older = await upload(job.id, 0, new Uint8Array([4, 5, 6]));
  const winner = await upload(job.id);
  await completeChunk(1, job.id, 0, winner);
  await expect(completeChunk(1, job.id, 0, older)).rejects.toThrow(
    /different checksum/,
  );
  expect(state.objects.size).toBe(2);
  expect((await markReady(1, job.id)).status).toBe("uploaded");
});
it("rejects cross-job attempts, cancellation races and expired sessions", async () => {
  const job = await createOrResumeJob(1, input(), scope),
    other = await createOrResumeJob(1, input(), scope);
  const body = await upload(job.id);
  await expect(completeChunk(1, other.id, 0, body)).rejects.toThrow(
    /attempt not found/,
  );
  await cancelJob(1, job.id);
  await expect(completeChunk(1, job.id, 0, body)).rejects.toThrow(/cancelled/);
  expect(await expireStaleUploads()).toBe(0);
  await state.engine.query(
    "update app.upload_jobs set expires_at=now()-interval '1 day' where id=$1",
    [other.id],
  );
  await expect(issueChunkUrl(1, other.id, 0)).rejects.toThrow(/expired/);
});
it("cleanup removes abandoned attempts after the signed URL safety window", async () => {
  const job = await createOrResumeJob(1, input(), scope);
  await upload(job.id);
  await cancelJob(1, job.id);
  await state.engine.query(
    "update app.upload_jobs set expires_at=now()-interval '1 day'",
  );
  await state.engine.query(
    "update app.upload_chunk_attempts set created_at=now()-interval '4 hours'",
  );
  expect(await expireStaleUploads()).toBe(1);
  expect(state.objects.size).toBe(0);
  expect((await getJobSummary(1, job.id)).status).toBe("expired");
});
it("enforces the active-job quota and recovers expired keys safely", async () => {
  const data = input(),
    job = await createOrResumeJob(1, data, scope);
  await createOrResumeJob(1, input(), scope);
  await createOrResumeJob(1, input(), scope);
  await expect(createOrResumeJob(1, input(), scope)).rejects.toThrow(
    /unfinished uploads/,
  );
  await state.engine.query(
    "update app.upload_jobs set expires_at=now()-interval '1 day' where id=$1",
    [job.id],
  );
  await expect(createOrResumeJob(1, data, scope)).rejects.toThrow(/expired/);
  expect((await createOrResumeJob(1, input(), scope)).status).toBe("created");
});
it("bounds abandoned signed upload attempts for each chunk", async () => {
  const job = await createOrResumeJob(1, input(), scope);
  for (let i = 0; i < 20; i++) await issueChunkUrl(1, job.id, 0);
  await expect(issueChunkUrl(1, job.id, 0)).rejects.toThrow(/attempt limit/i);
});

it("queued cancellation prevents re-enqueueing or reviving the job", async () => {
  const job = await createOrResumeJob(1, input(), scope);
  await completeChunk(1, job.id, 0, await upload(job.id));
  expect((await markReady(1, job.id)).status).toBe("uploaded");
  await cancelJob(1, job.id);
  await expect(markReady(1, job.id)).rejects.toMatchObject({ status: 409 });
  expect((await getJobSummary(1, job.id)).status).toBe("cancelled");
});

it("corrected 0004 keeps unknown historical statuses without permitting new invalid writes", async () => {
  await state.engine.exec(
    "alter table app.upload_jobs drop constraint upload_jobs_status_check",
  );
  const legacy = randomUUID();
  await state.engine.query(
    "insert into app.upload_jobs(id,telegram_user_id,storage_path,status,expires_at) values ($1,1,$2,'legacy_custom',now()+interval '1 day')",
    [legacy, legacy],
  );
  await state.engine.exec(
    readFileSync("db/migrations/0004_upload_jobs.sql", "utf8"),
  );
  expect(
    (
      await state.engine.query(
        "select status from app.upload_jobs where id=$1",
        [legacy],
      )
    ).rows[0].status,
  ).toBe("legacy_custom");
  await expect(
    state.engine.query(
      "insert into app.upload_jobs(telegram_user_id,storage_path,status,expires_at) values (1,'invalid-new','invalid',now())",
    ),
  ).rejects.toThrow(/check constraint/);
});
