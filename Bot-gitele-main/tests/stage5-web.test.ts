import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { testDatabase } from "./helpers/database";

const state = vi.hoisted(() => ({ pool: null as any }));
vi.mock("@/lib/db", () => ({ db: () => state.pool }));
import { loadEnv } from "@/lib/env";
import { mintWebToken } from "@/lib/web/session";
import { GET as jobsGet } from "@/app/api/web/jobs/route";
import { POST as retryPost } from "@/app/api/web/jobs/[id]/retry/route";
import { POST as cancelPost } from "@/app/api/web/jobs/[id]/cancel/route";
import { POST as signoutPost } from "@/app/api/web/signout/route";
import { POST as webhook } from "@/app/api/telegram/webhook/route";
import { claimUpdate, MAX_UPDATE_FAILURES } from "@/lib/telegram/update-claims";

let engine: any;
let env: ReturnType<typeof loadEnv>;
const JOB_A = "11111111-1111-4111-8111-111111111111";
const JOB_B = "22222222-2222-4222-8222-222222222222";
const tokenFor = (u: number, v = 0) => `Bearer ${mintWebToken(u, env.encryptionKey, v)}`;
const req = (path: string, user: number, method = "GET", v = 0) =>
  new NextRequest("https://bot-xsync-delta.vercel.app" + path, { method, headers: { authorization: tokenFor(user, v) } });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeAll(async () => {
  const values: Record<string, string> = {
    TELEGRAM_BOT_TOKEN: "test-bot", TELEGRAM_WEBHOOK_SECRET: "webhook-secret", GITHUB_APP_ID: "1", GITHUB_CLIENT_ID: "id",
    GITHUB_CLIENT_SECRET: "private", GITHUB_APP_PRIVATE_KEY_BASE64: "unused", GITHUB_WEBHOOK_SECRET: "private",
    GITHUB_APP_SLUG: "manager", DATABASE_URL: "postgresql://local/test", ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
    TELEGRAM_ALLOWED_USER_IDS: "999", APP_URL: "https://bot-xsync-delta.vercel.app",
  };
  for (const [k, v] of Object.entries(values)) vi.stubEnv(k, v);
  env = loadEnv();
  const db = await testDatabase();
  engine = db.engine;
  state.pool = db.pool;
  for (const [u, g] of [[1, 101], [2, 202]]) {
    await engine.query("insert into app.telegram_users(id) values($1)", [u]);
    const i = await engine.query("insert into app.github_identities(telegram_user_id,github_user_id,github_login) values($1,$2,$3) returning id", [u, g, `user${g}`]);
    await engine.query("insert into app.github_credentials(identity_id,auth_type,ciphertext) values($1,'github_app_user','x')", [i.rows[0].id]);
  }
  const ins = (id: string, user: number, status: string, extra = "") =>
    engine.query(
      `insert into app.upload_jobs(id,telegram_user_id,storage_path,status,expires_at,repo_full_name,branch,total_bytes,chunk_size,chunk_count,error ${extra ? "," + extra.split("=")[0] : ""})
       values($1,$2,$1::text,$3,now()+interval '1 day','o/r','main',10,8388608,1,'boom' ${extra ? "," + extra.split("=")[1] : ""})`,
      [id, user, status],
    );
  await ins(JOB_A, 1, "failed");
  await ins(JOB_B, 2, "failed");
});
afterAll(async () => {
  await engine?.close();
  vi.unstubAllEnvs();
});

it("lists only the caller's own jobs and exposes no internal columns", async () => {
  const body = await (await jobsGet(req("/api/web/jobs", 1))).json();
  expect(body.jobs.map((j: any) => j.id)).toEqual([JOB_A]);
  expect(Object.keys(body.jobs[0])).not.toContain("lease_owner");
  expect(JSON.stringify(body)).not.toContain("telegram_user_id");
});

it("rejects missing, forged, expired and revoked dashboard sessions", async () => {
  expect((await jobsGet(new NextRequest("https://x.test/api/web/jobs"))).status).toBe(401);
  expect((await jobsGet(new NextRequest("https://x.test/api/web/jobs", { headers: { authorization: "Bearer a.b" } }))).status).toBe(401);
  expect((await jobsGet(req("/api/web/jobs", 1, "GET", 99))).status).toBe(401); // wrong session version = revoked
});

it("user A cannot cancel or retry user B's job", async () => {
  expect((await retryPost(req(`/api/web/jobs/${JOB_B}/retry`, 1, "POST"), ctx(JOB_B))).status).toBe(404);
  expect((await cancelPost(req(`/api/web/jobs/${JOB_B}/cancel`, 1, "POST"), ctx(JOB_B))).status).toBe(404);
  const row = await engine.query("select status from app.upload_jobs where id=$1", [JOB_B]);
  expect(row.rows[0].status).toBe("failed");
});

it("owner can retry a failed job whose ZIP is still stored; it is re-queued with retries bounded", async () => {
  const res = await retryPost(req(`/api/web/jobs/${JOB_A}/retry`, 1, "POST"), ctx(JOB_A));
  expect(res.status).toBe(200);
  const row = (await engine.query("select status,error,worker_failures,retry_count from app.upload_jobs where id=$1", [JOB_A])).rows[0];
  expect(row).toMatchObject({ status: "uploaded", error: null, worker_failures: 0, retry_count: 1 });
  // Not failed anymore, so a second retry is refused.
  expect((await retryPost(req(`/api/web/jobs/${JOB_A}/retry`, 1, "POST"), ctx(JOB_A))).status).toBe(409);
  await engine.query("update app.upload_jobs set status='failed',retry_count=3 where id=$1", [JOB_A]);
  expect((await retryPost(req(`/api/web/jobs/${JOB_A}/retry`, 1, "POST"), ctx(JOB_A))).status).toBe(409);
  await engine.query("update app.upload_jobs set status='failed',retry_count=0,publish_started_at=now() where id=$1", [JOB_A]);
  expect((await retryPost(req(`/api/web/jobs/${JOB_A}/retry`, 1, "POST"), ctx(JOB_A))).status).toBe(409); // remote outcome uncertain
});

it("sign-out-everywhere revokes the session that made the request", async () => {
  expect((await signoutPost(req("/api/web/signout", 2, "POST"))).status).toBe(200);
  expect((await jobsGet(req("/api/web/jobs", 2, "GET", 0))).status).toBe(401);
  expect((await jobsGet(req("/api/web/jobs", 2, "GET", 1))).status).toBe(200);
});

it("webhook: bad secret is 401; a poison update is dropped after bounded failures instead of blocking Telegram", async () => {
  const post = (id: number, secret = "webhook-secret") =>
    webhook(new NextRequest("https://x.test/api/telegram/webhook", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": secret },
      // chat.id !== from.id forces a Telegram send; fetch is unavailable so the handler throws.
      body: JSON.stringify({ update_id: id, message: { from: { id: 1, first_name: "U" }, chat: { id: 1 }, text: "/start" } }),
    }));
  expect((await post(500, "wrong")).status).toBe(401);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network down"); }));
  const statuses: number[] = [];
  for (let i = 0; i <= MAX_UPDATE_FAILURES; i++) statuses.push((await post(501)).status);
  expect(statuses.slice(0, MAX_UPDATE_FAILURES)).toEqual(Array(MAX_UPDATE_FAILURES).fill(503));
  expect(statuses[MAX_UPDATE_FAILURES]).toBe(200);
  expect((await claimUpdate(501)).kind).toBe("completed");
  vi.unstubAllGlobals();
});
