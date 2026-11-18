import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { beforeAll, afterAll, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  pool: null as any,
  engine: null as any,
  objects: new Map<string, Uint8Array>(),
  tokens: ["token-one", "token-two"],
  head: "a".repeat(40),
  baseTree: "b".repeat(40),
  remote: new Map<string, { sha: string; mode: string }>(),
  commits: new Map<string, any>(),
  trees: new Map<string, any>(),
  blobCalls: [] as string[],
  commitBodies: [] as any[],
  patches: 0,
  failMode: "",
  crashed: false,
  jobId: "",
  messages: [] as any[],
  animationFail: false,
  reposRevoked: false,
  refreshCalls: 0,
  refreshMode: "",
  downloadGate: null as null | (() => Promise<void>),
}));
vi.mock("@/lib/db", () => ({ db: () => state.pool }));
import { unlinkGithubAccount } from "@/lib/github/linking";
import { getUsableToken } from "@/lib/github/credentials";
import { encryptSecret } from "@/lib/crypto";
import {
  createOrResumeJob,
  issueChunkUrl,
  completeChunk,
  markReady,
  getJobSummary,
  cancelJob,
} from "@/lib/upload/service";
import {
  claimJob,
  Lease,
  LostLease,
  reserveMutation,
} from "@/lib/worker/state";
import { processClaimedJob } from "@/lib/worker/processor";
import { runOneJob } from "@/lib/worker/runtime";
import { deliverOneNotice } from "@/lib/worker/notifications";
import { gitBlobSha } from "@/lib/github/upload";
const key = Buffer.alloc(32, 3),
  scope = { repoId: 42, repoFullName: "owner/project", branch: "main" };
const digest = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const sha = (s: string) => createHash("sha1").update(s).digest("hex");
// PGlite has one connection. Serialize transactions so its behavior matches a pool for these tests.
function poolFor(engine: PGlite) {
  let tail = Promise.resolve();
  const lock = async () => {
    const previous = tail;
    let unlock!: () => void;
    tail = new Promise((r) => (unlock = r));
    await previous;
    return unlock;
  };
  const query = async (sql: string, args?: any[]) => {
    const r = await engine.query(sql, args);
    return { ...r, rowCount: r.affectedRows ?? r.rows.length };
  };
  return {
    query: async (sql: string, args?: any[]) => {
      const unlock = await lock();
      try {
        return await query(sql, args);
      } finally {
        unlock();
      }
    },
    connect: async () => {
      const unlock = await lock();
      return { query, release: unlock };
    },
  };
}
function response(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
) {
  return Response.json(body, { status, headers });
}
async function fakeFetch(urlInput: unknown, init: RequestInit = {}) {
  const url = new URL(String(urlInput)),
    method = init.method ?? "GET",
    headers = new Headers(init.headers);
  if (
    url.origin === "https://github.com" &&
    url.pathname === "/login/oauth/access_token"
  ) {
    state.refreshCalls++;
    if (state.refreshMode === "transient")
      return response({ error: "temporarily_unavailable" }, 503);
    if (state.refreshMode === "auth")
      return response({ error: "bad_refresh_token" }, 400);
    return response({
      access_token: "refreshed-token",
      expires_in: 3600,
      refresh_token: "rotated-refresh",
      refresh_token_expires_in: 36000,
    });
  }
  if (url.origin === "https://storage.test") {
    const prefix = "/storage/v1/object/authenticated/github-uploads/";
    if (url.pathname.startsWith(prefix)) {
      await state.downloadGate?.();
      const data = state.objects.get(
        decodeURIComponent(url.pathname.slice(prefix.length)),
      );
      return data
        ? new Response(data as BodyInit)
        : response({ statusCode: "404" }, 400);
    }
    if (url.pathname.startsWith("/storage/v1/object/upload/sign/"))
      return response({
        url: url.pathname.replace("/storage/v1", "") + "?token=opaque",
      });
    if (method === "DELETE") {
      for (const p of JSON.parse(String(init.body)).prefixes)
        state.objects.delete(p);
      return response([]);
    }
  }
  if (url.origin === "https://api.telegram.org") {
    if (state.failMode === "telegram-rate")
      return response(
        {
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
          parameters: { retry_after: 12 },
        },
        429,
      );
    if (url.pathname.endsWith("/sendAnimation")) {
      if (state.animationFail)
        return response(
          { ok: false, description: "animation unavailable" },
          400,
        );
      state.messages.push({ method: "animation", form: init.body });
      return response({ ok: true, result: { message_id: 100 } });
    }
    const body = JSON.parse(String(init.body));
    state.messages.push({ method: url.pathname.split("/").pop(), body });
    return response({
      ok: true,
      result: { message_id: state.messages.length },
    });
  }
  if (url.origin !== "https://api.github.com")
    throw new Error("Unexpected URL " + url.origin);
  const token = headers.get("authorization");
  expect(["Bearer token-one", "Bearer token-two"]).toContain(token);
  const second = token === "Bearer token-two",
    repoId = second ? 43 : 42;
  const path = url.pathname,
    b = init.body ? JSON.parse(String(init.body)) : null;
  if (path === "/user/installations")
    return response({ installations: [{ id: second ? 2 : 1 }] });
  if (path.match(/^\/user\/installations\/\d+\/repositories/))
    return response({
      repositories: state.reposRevoked
        ? []
        : [
            {
              id: repoId,
              full_name: second ? "other/private" : "owner/project",
              default_branch: "main",
              private: true,
            },
          ],
    });
  if (path === "/user")
    return response({ id: 101, login: "one", name: "User One" });
  expect(path.startsWith("/repos/owner/project/")).toBe(true);
  expect(second).toBe(false);
  if (path.includes("/git/ref/heads/"))
    return response({ object: { sha: state.head } });
  if (path.endsWith("/git/trees/" + state.baseTree))
    return response({
      truncated: false,
      tree: [...state.remote].map(([path, e]) => ({
        path,
        type: "blob",
        ...e,
      })),
    });
  if (path.endsWith("/git/commits/" + "a".repeat(40)))
    return response({
      sha: "a".repeat(40),
      tree: { sha: state.baseTree },
      parents: [],
    });
  if (method === "POST" && path.endsWith("/git/blobs")) {
    if (state.failMode === "rate")
      return response({ message: "secondary rate limit" }, 403, {
        "retry-after": "17",
      });
    if (
      state.failMode === "interrupt" &&
      !state.crashed &&
      state.blobCalls.length > 0
    ) {
      state.crashed = true;
      throw new LostLease("Simulated worker exit");
    }
    const bytes = Buffer.from(b.content, "base64"),
      hash = gitBlobSha(bytes);
    state.blobCalls.push(hash);
    if (state.failMode === "cancel") {
      state.failMode = "";
      await cancelJob(1, state.jobId);
    }
    return response({ sha: hash }, 201);
  }
  if (method === "POST" && path.endsWith("/git/trees")) {
    if (state.failMode === "permission")
      return response({ message: "Resource not accessible" }, 403);
    expect(b.base_tree).toBe(state.baseTree);
    expect(b.tree.every((e: any) => e.sha && e.type === "blob")).toBe(true);
    const hash = sha(JSON.stringify(b));
    state.trees.set(hash, b);
    return response({ sha: hash }, 201);
  }
  if (method === "POST" && path.endsWith("/git/commits")) {
    state.commitBodies.push(b);
    const hash = sha(JSON.stringify(b));
    state.commits.set(hash, b);
    if (state.failMode === "crash-after-commit" && !state.crashed) {
      state.crashed = true;
      throw new LostLease("Worker exited before commit checkpoint");
    }
    return response({ sha: hash }, 201);
  }
  if (method === "PATCH" && path.includes("/git/refs/heads/")) {
    expect(b.force).toBe(false);
    state.patches++;
    if (state.failMode === "conflict")
      return response({ message: "not fast-forward" }, 422);
    state.head = b.sha;
    if (state.failMode === "crash-after-push" && !state.crashed) {
      state.crashed = true;
      throw new LostLease("Worker died after remote success");
    }
    if (state.failMode === "cancel-publish")
      await expect(cancelJob(1, state.jobId)).rejects.toMatchObject({
        status: 409,
      });
    return response({ object: { sha: state.head } });
  }
  if (path.includes("/git/commits/")) {
    const hash = path.split("/").pop()!,
      commit = state.commits.get(hash);
    if (commit)
      return response({
        sha: hash,
        tree: { sha: commit.tree },
        parents: commit.parents.map((sha: string) => ({ sha })),
      });
  }
  if (path.includes("/compare/")) return response({ status: "diverged" });
  throw new Error("Unexpected GitHub request " + method + " " + path);
}
beforeAll(async () => {
  const values = {
    TELEGRAM_BOT_TOKEN: "test-bot",
    TELEGRAM_WEBHOOK_SECRET: "secret",
    GITHUB_APP_ID: "1",
    GITHUB_CLIENT_ID: "id",
    GITHUB_CLIENT_SECRET: "secret",
    GITHUB_APP_PRIVATE_KEY_BASE64: "unused",
    GITHUB_WEBHOOK_SECRET: "secret",
    GITHUB_APP_SLUG: "manager",
    DATABASE_URL: "postgresql://local/test",
    ENCRYPTION_KEY: key.toString("base64"),
    TELEGRAM_ALLOWED_USER_IDS: "999",
    APP_URL: "https://app.test",
    SUPABASE_URL: "https://storage.test",
    SUPABASE_SECRET_KEY: "sb_secret_test",
    SUPABASE_STORAGE_BUCKET: "github-uploads",
  };
  for (const [k, v] of Object.entries(values)) vi.stubEnv(k, v);
  state.engine = new PGlite();
  state.pool = poolFor(state.engine);
  await state.engine.exec("create role anon; create role authenticated;");
  for (const file of readdirSync("db/migrations").sort())
    await state.engine.exec(readFileSync("db/migrations/" + file, "utf8"));
  await state.pool.query("insert into app.telegram_users(id) values (1),(2)");
  for (const user of [1, 2]) {
    const { rows } = await state.pool.query(
      "insert into app.github_identities(telegram_user_id,github_user_id,github_login) values ($1,$2,$3) returning id",
      [user, user + 100, "user" + user],
    );
    await state.pool.query(
      "insert into app.github_credentials(identity_id,auth_type,ciphertext) values ($1,'github_app_user',$2)",
      [rows[0].id, encryptSecret(state.tokens[user - 1], key)],
    );
  }
}, 30000);
afterAll(async () => {
  await state.engine?.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
beforeEach(async () => {
  await state.pool.query("delete from app.upload_jobs");
  await state.pool.query("delete from app.worker_github_budgets");
  await state.pool.query("delete from app.worker_notify_chats");
  state.objects.clear();
  state.remote.clear();
  state.commits.clear();
  state.trees.clear();
  state.blobCalls = [];
  state.commitBodies = [];
  state.patches = 0;
  state.head = "a".repeat(40);
  state.failMode = "";
  state.crashed = false;
  state.messages = [];
  state.animationFail = false;
  state.reposRevoked = false;
  state.refreshCalls = 0;
  state.refreshMode = "";
  state.downloadGate = null;
  await state.pool.query(
    "update app.github_identities set disconnected_at=null",
  );
  for (const user of [1, 2])
    await state.pool.query(
      "insert into app.github_credentials(identity_id,auth_type,ciphertext) select id,'github_app_user',$2 from app.github_identities where telegram_user_id=$1 on conflict(identity_id) do update set ciphertext=excluded.ciphertext,expires_at=null,refresh_ciphertext=null,refresh_expires_at=null,revoked_at=null",
      [user, encryptSecret(state.tokens[user - 1], key)],
    );
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
});
async function queue(
  entries: Record<string, Uint8Array> = {
    "src/main.ts": strToU8("export const n=1;"),
    "assets/logo.png": new Uint8Array([137, 80, 78, 71, 0, 255]),
    ".github/workflows/build.yaml": strToU8("on: push\n"),
  },
) {
  const archive = zipSync(entries, { level: 0 }),
    data = {
      fileName: "p.zip",
      totalBytes: archive.length,
      clientKey: randomUUID(),
      fileSha256: digest(archive),
    };
  const job = await createOrResumeJob(1, data, scope);
  state.jobId = job.id;
  for (let i = 0; i < job.chunkCount; i++) {
    const signed = await issueChunkUrl(1, job.id, i);
    if (signed.verified) throw new Error("unexpected");
    const path = decodeURIComponent(
      new URL(signed.url).pathname.split("/github-uploads/")[1],
    );
    const bytes = archive.slice(i * job.chunkSize, (i + 1) * job.chunkSize);
    state.objects.set(path, bytes);
    await completeChunk(1, job.id, i, {
      attemptId: signed.attemptId,
      sha256: digest(bytes),
      size: bytes.length,
    });
  }
  await markReady(1, job.id);
  return { job, archive, data };
}
async function process() {
  const claimed = await claimJob();
  expect(claimed).not.toBeNull();
  await processClaimedJob(claimed!);
  return getJobSummary(1, claimed!.id);
}
async function recover() {
  await state.pool.query(
    "update app.upload_jobs set lease_until=now()-interval '1 second',next_attempt_at=now() where status='processing'",
  );
  return process();
}
it("connects browser chunk APIs through storage, worker, update-only confirmed commit and Telegram text/GIF", async () => {
  state.remote.set("keep.txt", {
    sha: gitBlobSha(strToU8("keep")),
    mode: "100644",
  });
  const { job } = await queue();
  expect(await runOneJob()).toBe(true);
  const result = await getJobSummary(1, job.id);
  expect(result.status).toBe("completed");
  expect(state.patches).toBe(1);
  expect(state.trees.values().next().value.base_tree).toBe(state.baseTree);
  expect(
    [...state.trees.values()][0].tree.some((e: any) => e.path === "keep.txt"),
  ).toBe(false);
  expect(state.blobCalls).toHaveLength(3);
  expect(result.added).toBe(3);
  expect(result.filesProcessed).toBe(3);
  await deliverOneNotice("test-bot");
  expect(
    state.messages.some((m) => m.body?.text.includes("UPLOAD COMPLETED")),
  ).toBe(true);
  const success = state.messages.find((m) =>
    m.body?.text.includes("UPLOAD COMPLETED"),
  );
  expect(success.body.chat_id).toBe(1);
  expect(success.body.reply_markup.inline_keyboard[0][0].url).toContain(
    "/commit/" + result.commitSha,
  );
  await state.pool.query("delete from app.worker_notify_chats");
  await state.pool.query("update app.upload_jobs set notify_after=now()");
  await deliverOneNotice("test-bot");
  expect(state.messages.some((m) => m.method === "animation")).toBe(true);
});
it("deduplicates blobs while preserving every project path and exact PNG/YAML bytes", async () => {
  const data = new Uint8Array([137, 80, 78, 71, 255]);
  await queue({
    "a.png": data,
    "nested/b.png": data,
    ".github/workflows/x.yml": strToU8("on: push\n"),
  });
  expect((await process()).status).toBe("completed");
  expect(state.blobCalls).toHaveLength(2);
  expect([...state.trees.values()][0].tree).toHaveLength(3);
});
it("unchanged projects create no commit and report already up to date", async () => {
  const bytes = strToU8("same");
  state.remote.set("x.txt", { sha: gitBlobSha(bytes), mode: "100644" });
  await queue({ "x.txt": bytes });
  const result = await process();
  expect(result.status).toBe("completed");
  expect(result.commitSha).toBeNull();
  expect(state.patches).toBe(0);
  expect(state.commitBodies).toHaveLength(0);
  await deliverOneNotice("test-bot");
  expect(state.messages[0].body.text).toContain("ALREADY UP TO DATE");
});
it("missing/corrupted storage chunks fail before any Git mutation", async () => {
  await queue();
  state.objects.clear();
  const result = await process();
  expect(result.status).toBe("failed");
  expect(state.blobCalls).toHaveLength(0);
  expect(state.patches).toBe(0);
});
it("worker reclaims expired leases and skips acknowledged blobs after interruption", async () => {
  await queue({
    "a.txt": strToU8("one"),
    "b.txt": strToU8("two"),
    "c.txt": strToU8("three"),
  });
  state.failMode = "interrupt";
  await process();
  const checkpoint = await state.pool.query(
    "select count(*) as n from app.upload_job_files where blob_uploaded",
  );
  expect(Number(checkpoint.rows[0].n)).toBeGreaterThan(0);
  const before = [...state.blobCalls];
  state.failMode = "";
  expect((await recover()).status).toBe("completed");
  for (const hash of before)
    expect(state.blobCalls.filter((s) => s === hash)).toHaveLength(1);
});
it("recovery after successful push confirms the checkpoint without a second commit or patch", async () => {
  await queue();
  state.failMode = "crash-after-push";
  await process();
  expect(state.patches).toBe(1);
  state.failMode = "";
  const result = await recover();
  expect(result.status).toBe("completed");
  expect(state.patches).toBe(1);
  expect(state.commitBodies).toHaveLength(1);
});
it("rate limits persist Retry-After and resume instead of fabricating progress", async () => {
  await queue();
  state.failMode = "rate";
  const result = await process();
  expect(result.status).toBe("processing");
  expect(result.filesProcessed).toBe(0);
  expect(result.commitSha).toBeNull();
  const rows = await state.pool.query(
    "select next_attempt_at>now()+interval '15 seconds' as waiting from app.upload_jobs",
  );
  expect(rows.rows[0].waiting).toBe(true);
});
it("branch conflicts fail with no success notification or force push", async () => {
  await queue();
  state.failMode = "conflict";
  const result = await process();
  expect(result.status).toBe("failed");
  expect(state.head).toBe("a".repeat(40));
  await deliverOneNotice("test-bot");
  expect(state.messages[0].body.text).toContain("UPLOAD FAILED");
  expect(state.messages[0].body.text).not.toContain("UPLOAD COMPLETED");
});
it("workflow permission failures provide the required GitHub App permission hint", async () => {
  await queue();
  state.failMode = "permission";
  const result = await process();
  expect(result.status).toBe("failed");
  expect(result.error).toContain("Workflows: Read and write");
});
it("cancellation while blobs are in flight fences the worker before tree/commit publication", async () => {
  await queue();
  state.failMode = "cancel";
  const result = await process();
  expect(result.status).toBe("cancelled");
  expect(state.patches).toBe(0);
  expect(state.commitBodies).toHaveLength(0);
});
it("publication boundary rejects cancellation and waits for confirmed GitHub completion", async () => {
  await queue();
  state.failMode = "cancel-publish";
  expect((await process()).status).toBe("completed");
});
it("cross-user job access, duplicate claims and revoked repository permission are blocked", async () => {
  const { job, data } = await queue();
  await expect(getJobSummary(2, job.id)).rejects.toMatchObject({ status: 404 });
  await expect(cancelJob(2, job.id)).rejects.toMatchObject({ status: 404 });
  expect((await createOrResumeJob(1, data, scope)).id).toBe(job.id);
  const first = await claimJob();
  expect(await claimJob()).toBeNull();
  state.reposRevoked = true;
  await processClaimedJob(first!);
  expect((await getJobSummary(1, job.id)).status).toBe("failed");
  expect(state.blobCalls).toHaveLength(0);
});
it("lost workers cannot save with an old lease after another worker owns the job", async () => {
  await queue();
  const first = await claimJob();
  await state.pool.query(
    "update app.upload_jobs set lease_until=now()-interval '1 second'",
  );
  const second = await claimJob();
  expect(second!.lease_owner).not.toBe(first!.lease_owner);
  await expect(
    new Lease(first!).save({ processing_stage: "completed" }),
  ).rejects.toBeInstanceOf(LostLease);
});
it("failed optional animation never suppresses the delivered success summary", async () => {
  await queue();
  await process();
  state.animationFail = true;
  await deliverOneNotice("test-bot");
  await state.pool.query("delete from app.worker_notify_chats");
  await state.pool.query("update app.upload_jobs set notify_after=now()");
  await deliverOneNotice("test-bot");
  expect(
    state.messages.some((m) => m.body?.text.includes("UPLOAD COMPLETED")),
  ).toBe(true);
  expect(
    (
      await state.pool.query(
        "select terminal_notified_at is not null as sent from app.upload_jobs",
      )
    ).rows[0].sent,
  ).toBe(true);
});
it("persistent mutation budgets are shared and bounded across worker restarts", async () => {
  for (let i = 0; i < 60; i++) expect(await reserveMutation(1)).toBe(0);
  expect(await reserveMutation(1)).toBeGreaterThan(0);
});

it("processes an exact 100 MiB ZIP from verified chunks to a confirmed GitHub commit", async () => {
  const count = 13,
    entries: Record<string, Uint8Array> = {};
  for (let i = 0; i < count; i++) entries[`data/${i}.bin`] = new Uint8Array();
  const overhead = zipSync(entries, { level: 0 }).length;
  let remaining = 100 * 1024 * 1024 - overhead;
  for (let i = 0; i < count; i++) {
    const size = Math.min(8 * 1024 * 1024, remaining);
    entries[`data/${i}.bin`] = new Uint8Array(size);
    remaining -= size;
  }
  expect(remaining).toBe(0);
  const { archive, job } = await queue(entries);
  expect(archive.length).toBe(100 * 1024 * 1024);
  expect(job.chunkCount).toBe(13);
  const result = await process();
  expect(result.status).toBe("completed");
  expect(result.filesTotal).toBe(13);
  expect(result.bytesVerified).toBe(100 * 1024 * 1024);
}, 120000);
it("processes thousands of paths without duplicate blob operations", async () => {
  const entries: Record<string, Uint8Array> = {};
  const data = strToU8("shared project data");
  for (let i = 0; i < 3000; i++) entries[`src/file-${i}.txt`] = data;
  await queue(entries);
  const result = await process();
  expect(result.status).toBe("completed");
  expect(result.filesProcessed).toBe(3000);
  expect(result.added).toBe(3000);
  expect(state.blobCalls).toHaveLength(1);
  expect([...state.trees.values()][0].tree).toHaveLength(3000);
}, 30000);
it("one persistent progress message is edited after worker restart before the terminal notice", async () => {
  await queue();
  await deliverOneNotice("test-bot");
  const message = state.messages[0];
  expect(message.method).toBe("sendMessage");
  expect(message.body.text).toContain("Queued for GitHub worker");
  await process();
  await state.pool.query("delete from app.worker_notify_chats");
  await state.pool.query("update app.upload_jobs set notify_after=now()");
  await deliverOneNotice("test-bot");
  expect(state.messages[1].method).toBe("editMessageText");
  expect(state.messages[1].body.message_id).toBe(1);
  expect(state.messages[1].body.text).toContain("UPLOAD COMPLETED");
});

it("replays an unacknowledged commit request with identical timestamp, parent and identity", async () => {
  await queue();
  state.failMode = "crash-after-commit";
  await process();
  expect(state.commits.size).toBe(1);
  expect(state.patches).toBe(0);
  state.failMode = "";
  expect((await recover()).status).toBe("completed");
  expect(state.commitBodies).toHaveLength(2);
  expect(state.commitBodies[0]).toEqual(state.commitBodies[1]);
  expect(state.commits.size).toBe(1);
  expect(state.patches).toBe(1);
});
it("full-archive checksum mismatch is rejected by the worker before GitHub writes", async () => {
  await queue();
  await state.pool.query("update app.upload_jobs set file_sha256=$1", [
    "f".repeat(64),
  ]);
  const result = await process();
  expect(result.status).toBe("failed");
  expect(result.error).toContain("Complete ZIP checksum mismatch");
  expect(state.blobCalls).toHaveLength(0);
});

async function expireCredential() {
  await state.pool.query(
    "update app.github_credentials set expires_at=now()-interval '1 minute',refresh_ciphertext=$1,refresh_expires_at=now()+interval '1 day' where identity_id in(select id from app.github_identities where telegram_user_id=1)",
    [encryptSecret("old-refresh", key)],
  );
}
it("concurrent worker/browser token renewal rotates a refresh token exactly once", async () => {
  await expireCredential();
  const tokens = await Promise.all([getUsableToken(1), getUsableToken(1)]);
  expect(tokens.map((t) => t?.token)).toEqual([
    "refreshed-token",
    "refreshed-token",
  ]);
  expect(state.refreshCalls).toBe(1);
});
it("temporary OAuth failures do not erase the user credential", async () => {
  await expireCredential();
  state.refreshMode = "transient";
  await expect(getUsableToken(1)).rejects.toThrow();
  const result = await state.pool.query(
    "select revoked_at,ciphertext from app.github_credentials where identity_id in(select id from app.github_identities where telegram_user_id=1)",
  );
  expect(result.rows[0].revoked_at).toBeNull();
  expect(result.rows[0].ciphertext).not.toBe("");
});

it("Telegram Retry-After persists across notification loop restarts", async () => {
  await queue();
  state.failMode = "telegram-rate";
  await deliverOneNotice("test-bot");
  const result = await state.pool.query(
    "select telegram_message_id,notify_after>now()+interval '10 seconds' as waiting from app.upload_jobs",
  );
  expect(result.rows[0].telegram_message_id).toBeNull();
  expect(result.rows[0].waiting).toBe(true);
  state.failMode = "";
  expect(await deliverOneNotice("test-bot")).toBe(false);
});

it("disconnecting GitHub cancels that user pending processing without exposing another user job", async () => {
  const { job } = await queue();
  await unlinkGithubAccount(1);
  expect((await getJobSummary(1, job.id)).status).toBe("cancelled");
  expect(await claimJob()).toBeNull();
  expect(state.patches).toBe(0);
});

it("chunk verification downloads proceed in parallel without holding the job transaction open", async () => {
  const bytes = new Uint8Array(9 * 1024 * 1024);
  const job = await createOrResumeJob(
    1,
    {
      fileName: "parallel.zip",
      totalBytes: bytes.length,
      fileSha256: digest(bytes),
      clientKey: randomUUID(),
    },
    scope,
  );
  const bodies = [];
  for (let i = 0; i < job.chunkCount; i++) {
    const signed = await issueChunkUrl(1, job.id, i);
    if (signed.verified) throw new Error("unexpected");
    const path = decodeURIComponent(
      new URL(signed.url).pathname.split("/github-uploads/")[1],
    );
    const part = bytes.slice(i * job.chunkSize, (i + 1) * job.chunkSize);
    state.objects.set(path, part);
    bodies.push({
      attemptId: signed.attemptId,
      size: part.length,
      sha256: digest(part),
    });
  }
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let entered = 0;
  state.downloadGate = async () => {
    entered++;
    await gate;
  };
  const pending = Promise.all(
    bodies.map((body, i) => completeChunk(1, job.id, i, body)),
  );
  for (let i = 0; i < 25 && entered < 2; i++)
    await new Promise((r) => setTimeout(r, 20));
  const count = entered;
  release();
  await pending;
  expect(count).toBe(2);
});
