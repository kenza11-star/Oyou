import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { zipSync, strToU8 } from "fflate";
import { testDatabase } from "./helpers/database";
const state = vi.hoisted(() => ({
  pool: null as any,
  env: null as any,
  messages: [] as any[],
  docs: [] as any[],
  account: 101,
  artifactZip: zipSyncPlaceholder(),
  jobId: "",
}));
// Hoisted state cannot call imported helpers.
function zipSyncPlaceholder() {
  return new Uint8Array();
}
vi.mock("@/lib/db", () => ({ db: () => state.pool }));
import { handleMessage } from "@/lib/telegram/handlers";
import { handleCallback } from "@/lib/telegram/callbacks";
import { GET as callback } from "@/app/github/callback/route";
import { getUserState } from "@/lib/telegram/state";
import { loadEnv } from "@/lib/env";
import { verifyUploadToken } from "@/lib/upload/token";
import { claimUpdate, finishUpdate } from "@/lib/telegram/update-claims";
import { POST as webhook } from "@/app/api/telegram/webhook/route";
import { readiness } from "@/lib/deployment/readiness";
let engine: any;
const api = async (urlInput: unknown, init: RequestInit = {}) => {
  const url = new URL(String(urlInput)),
    path = url.pathname,
    body = init.body;
  if (url.origin === "https://api.telegram.org") {
    if (path.endsWith("/sendDocument")) {
      const form = body as FormData;
      state.docs.push({
        name: (form.get("document") as File).name,
        bytes: new Uint8Array(
          await (form.get("document") as File).arrayBuffer(),
        ),
      });
      return Response.json({ ok: true, result: { message_id: 90 } });
    }
    if (path.endsWith("/answerCallbackQuery"))
      return Response.json({ ok: true, result: true });
    const message = JSON.parse(String(body));
    state.messages.push(message);
    return Response.json({
      ok: true,
      result: { message_id: state.messages.length },
    });
  }
  if (url.origin === "https://github.com")
    return Response.json({ access_token: "user-" + state.account });
  if (url.origin === "https://storage.test")
    return Response.json({ id: "github-uploads", public: false });
  if (url.origin !== "https://api.github.com")
    throw new Error("Unexpected host");
  const auth = new Headers(init.headers).get("authorization");
  const user = auth === "Bearer user-202" ? 202 : 101,
    repo = user === 202 ? 43 : 42,
    full = user === 202 ? "other/private" : "owner/project";
  if (path === "/user")
    return Response.json({ id: user, login: "user" + user });
  if (path === "/user/installations")
    return Response.json({ installations: [{ id: user }] });
  if (path.includes("/repositories"))
    return Response.json({
      repositories: [
        { id: repo, full_name: full, default_branch: "main", private: true },
      ],
    });
  if (path.endsWith("/branches"))
    return Response.json([{ name: "main" }, { name: "develop" }]);
  if (path.includes("/git/ref/heads/"))
    return ["main", "develop"].includes(path.split("/").pop()!)
      ? Response.json({ object: { sha: "a".repeat(40) } })
      : Response.json({}, { status: 404 });
  if (path.endsWith("/actions/runs"))
    return Response.json({
      workflow_runs: [
        {
          name: "Build",
          run_number: 2,
          head_branch: "develop",
          head_sha: "a".repeat(40),
          status: "completed",
          conclusion: "success",
          html_url: "https://github.com/" + full + "/actions/runs/2",
        },
      ],
    });
  if (path.endsWith("/actions/artifacts"))
    return Response.json({
      artifacts: [
        {
          id: 1,
          name: "logs",
          size_in_bytes: state.artifactZip.length,
          expired: false,
          archive_download_url:
            "https://api.github.com/repos/" + full + "/actions/artifacts/1/zip",
        },
      ],
    });
  if (path.endsWith("/artifacts/1/zip"))
    return new Response(state.artifactZip as BodyInit);
  if (path.endsWith("/releases/latest"))
    return Response.json({
      assets: [
        {
          name: "release.apk",
          size: 4,
          url: "https://api.github.com/repos/" + full + "/releases/assets/1",
        },
      ],
    });
  if (path.endsWith("/releases/assets/1"))
    return new Response(new Uint8Array([1, 2, 3, 255]));
  throw new Error("Unexpected API " + path);
};
beforeAll(async () => {
  const values = {
    TELEGRAM_BOT_TOKEN: "test-bot",
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    GITHUB_APP_ID: "1",
    GITHUB_CLIENT_ID: "id",
    GITHUB_CLIENT_SECRET: "private",
    GITHUB_APP_PRIVATE_KEY_BASE64: "unused",
    GITHUB_WEBHOOK_SECRET: "private",
    GITHUB_APP_SLUG: "manager",
    DATABASE_URL: "postgresql://local/test",
    ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
    TELEGRAM_ALLOWED_USER_IDS: "999",
    APP_URL: "https://bot-xsync-delta.vercel.app",
    SUPABASE_URL: "https://storage.test",
    SUPABASE_SECRET_KEY: "sb_secret_private",
    SUPABASE_STORAGE_BUCKET: "github-uploads",
  };
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
  state.env = loadEnv();
  const db = await testDatabase();
  engine = db.engine;
  state.pool = db.pool;
  state.artifactZip = zipSync({ "logs.txt": strToU8("build output") });
  vi.stubGlobal("fetch", vi.fn(api));
}, 30000);
afterAll(async () => {
  await engine?.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const message = (id: number, text: string) =>
  handleMessage(
    { from: { id, first_name: "User" }, chat: { id }, text },
    state.env,
  );
async function login(id: number, account: number) {
  await message(id, "/login");
  const link = state.messages.at(-1).text.split("\n\n").at(-1);
  const nonce = new URL(link).searchParams.get("state")!;
  state.account = account;
  const result = await callback(
    new NextRequest(
      state.env.appUrl + "/github/callback?code=valid&state=" + nonce,
    ),
  );
  return { result, nonce };
}
it("new public user can start, authenticate, select a private repository/branch and open scoped upload", async () => {
  await message(1, "/start");
  expect(state.messages.at(-1).text).toContain("/login");
  const { result, nonce } = await login(1, 101);
  expect(result.status).toBe(200);
  const replay = await callback(
    new NextRequest(
      state.env.appUrl + "/github/callback?code=valid&state=" + nonce,
    ),
  );
  expect(replay.status).toBe(400);
  await message(1, "/repos");
  expect(
    state.messages.at(-1).reply_markup.inline_keyboard[0][0].callback_data,
  ).toBe("pick:42");
  await handleCallback(
    {
      id: "callback-1",
      from: { id: 1 },
      message: { chat: { id: 1 } },
      data: "pick:42",
    },
    state.env,
  );
  await message(1, "/branch develop");
  expect((await getUserState(1)).repoBranch).toBe("develop");
  await message(1, "/upload");
  const link = state.messages.at(-1).reply_markup.inline_keyboard[0][0].url;
  const token = new URLSearchParams(new URL(link).hash.slice(1)).get("t")!;
  const claims = verifyUploadToken(token, state.env.encryptionKey);
  expect(claims?.telegramUserId).toBe(1);
  expect(claims?.scope?.branch).toBe("develop");
  expect(claims?.scope?.sessionVersion).toBe(1);
});
it("second public user cannot connect another user account or select another user private repo", async () => {
  const conflict = await login(2, 101);
  expect(conflict.result.status).toBe(409);
  expect((await login(2, 202)).result.status).toBe(200);
  await handleCallback(
    {
      id: "callback-2",
      from: { id: 2 },
      message: { chat: { id: 2 } },
      data: "pick:42",
    },
    state.env,
  );
  expect((await getUserState(2)).repoId).toBeNull();
  expect(state.messages.at(-1).chat_id).toBe(2);
});
it("status, owner-only admin, Actions and release APK fallback are functional", async () => {
  await message(1, "/status");
  expect(state.messages.at(-1).text).toContain("user101");
  await message(1, "/admin");
  expect(state.messages.at(-1).text).toContain("not available");
  await message(999, "/admin");
  expect(state.messages.at(-1).text).toContain("Users:");
  await message(1, "/actions");
  expect(state.messages.at(-1).text).toContain("Build #2");
  await message(1, "/apk");
  expect(state.docs.at(-1).name).toBe("release.apk");
  expect([...state.docs.at(-1).bytes]).toEqual([1, 2, 3, 255]);
});
it("webhook claims can recover after a crash and stale claims cannot acknowledge the new owner", async () => {
  const first = await claimUpdate(123);
  expect(first.kind).toBe("claimed");
  expect((await claimUpdate(123)).kind).toBe("busy");
  await state.pool.query(
    "update app.processed_updates set lease_until=now()-interval '1 second' where update_id=123",
  );
  const next = await claimUpdate(123);
  expect(next.kind).toBe("claimed");
  if (first.kind === "claimed" && next.kind === "claimed") {
    expect(await finishUpdate(123, first.token, true)).toBe(false);
    expect(await finishUpdate(123, next.token, true)).toBe(true);
  }
  expect((await claimUpdate(123)).kind).toBe("completed");
});
it("webhook rejects invalid secrets and accepts the authenticated deployment no-op", async () => {
  expect(
    (
      await webhook(
        new NextRequest(state.env.appUrl + "/api/telegram/webhook", {
          method: "POST",
          body: "{}",
        }),
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await webhook(
        new NextRequest(state.env.appUrl + "/api/telegram/webhook", {
          method: "POST",
          body: "{}",
          headers: { "x-telegram-bot-api-secret-token": "webhook-secret" },
        }),
      )
    ).status,
  ).toBe(200);
});
it("core readiness never depends on a running processor; processing readiness is reported separately", async () => {
  const r = await readiness();
  expect(r.status).toBe("ready");
  expect(r.core).toEqual({ ready: true, checks: { env: true, database: true, schema: true }, problems: [] });
  expect(r.processing.checks.storage).toBe(true);
  expect(r.processing.checks.schema).toBe(true);
  expect(r.processing.ready).toBe(true);
  // No heartbeat, no dispatch token: still ready for /start, and the optional gap is explained.
  expect(r.processing.lastProcessorSeenAt).toBeNull();
  expect(r.processing.problems.map((p) => p.code)).toContain("ACTIONS_DISPATCH_TOKEN_MISSING");
});
it("logout and reauthentication increment revocation versions without exposing the other account", async () => {
  const before = (await getUserState(1)).sessionVersion;
  await message(1, "/logout");
  expect((await getUserState(1)).sessionVersion).toBeGreaterThan(before);
  expect((await login(1, 101)).result.status).toBe(200);
  await message(2, "/status");
  expect(state.messages.at(-1).text).toContain("user202");
});
