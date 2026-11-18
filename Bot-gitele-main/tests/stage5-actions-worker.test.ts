import { expect, it, vi } from "vitest";
import { dispatchConfig, dispatchProcessor, WORKFLOW_FILE } from "@/lib/actions-worker/dispatch";
import { actionsRunInfo } from "@/lib/actions-worker/run-info";
import { describeDbError, describeEnvError } from "@/lib/deployment/diagnostics";
import { formatBytes, formatTime, jobProgress, statusInfo } from "@/lib/web/format";
import { mintWebToken, webClaimsFromBearer } from "@/lib/web/session";
import { mintSessionToken, scopeFromBearer } from "@/lib/upload/session";

const key = Buffer.alloc(32, 7);

it("dispatch is off without a token and rejects malformed repo/ref values", () => {
  expect(dispatchConfig({})).toBeNull();
  expect(dispatchConfig({ ACTIONS_DISPATCH_TOKEN: "t", WORKER_REPO: "a/b/c" })).toBeNull();
  expect(dispatchConfig({ ACTIONS_DISPATCH_TOKEN: "t", WORKER_REF: "../x" })).toBeNull();
  expect(dispatchConfig({ ACTIONS_DISPATCH_TOKEN: "t" })).toMatchObject({ repo: "kenza11-star/Bot-gitele", ref: "main" });
});

it("dispatch sends no inputs and never puts the token in the URL or body", async () => {
  const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
  expect(await dispatchProcessor({ ACTIONS_DISPATCH_TOKEN: "SECRET-TOKEN" }, fetcher as typeof fetch)).toEqual({ ok: true });
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe(`https://api.github.com/repos/kenza11-star/Bot-gitele/actions/workflows/${WORKFLOW_FILE}/dispatches`);
  expect(url).not.toContain("SECRET");
  expect(JSON.parse(String(init.body))).toEqual({ ref: "main" });
  expect((init.headers as Record<string, string>).authorization).toBe("Bearer SECRET-TOKEN");
});

it("dispatch failures are reported, never thrown", async () => {
  const cfg = { ACTIONS_DISPATCH_TOKEN: "t" };
  expect(await dispatchProcessor({}, vi.fn() as unknown as typeof fetch)).toEqual({ ok: false, reason: "not_configured" });
  expect(await dispatchProcessor(cfg, (async () => new Response("no", { status: 403 })) as typeof fetch)).toEqual({ ok: false, reason: "rejected", status: 403 });
  expect(await dispatchProcessor(cfg, (async () => { throw new Error("leak SECRET"); }) as typeof fetch)).toEqual({ ok: false, reason: "network" });
});

it("run info is built only from well-formed GitHub Actions variables", () => {
  expect(actionsRunInfo({ GITHUB_RUN_ID: "123", GITHUB_REPOSITORY: "o/r" })).toEqual({ id: 123, url: "https://github.com/o/r/actions/runs/123" });
  expect(actionsRunInfo({ GITHUB_RUN_ID: "12x", GITHUB_REPOSITORY: "o/r" })).toBeNull();
  expect(actionsRunInfo({ GITHUB_RUN_ID: "1", GITHUB_REPOSITORY: "o/r", GITHUB_SERVER_URL: "https://evil.test" })).toBeNull();
  expect(actionsRunInfo({})).toBeNull();
});

it("diagnostics expose driver codes and hints but never messages", () => {
  const e = Object.assign(new Error("connect postgres://user:pw@host/db failed"), { code: "SELF_SIGNED_CERT_IN_CHAIN" });
  const p = describeDbError(e);
  expect(p.code).toBe("SELF_SIGNED_CERT_IN_CHAIN");
  expect(p.hint).toContain("DATABASE_CA_CERT");
  expect(JSON.stringify(p)).not.toContain("pw@host");
  expect(describeEnvError(new Error("Missing required environment variables: DATABASE_URL")).hint).toContain("DATABASE_URL");
  expect(describeEnvError(new Error("secret=abc")).hint).toBe("Environment validation failed.");
});

it("dashboard tokens and upload tokens are not interchangeable", () => {
  const web = `Bearer ${mintWebToken(5, key, 3)}`;
  const upload = `Bearer ${mintSessionToken(5, key, Date.now(), { repoId: 1, repoFullName: "a/b", branch: "main", sessionVersion: 3 })}`;
  expect(webClaimsFromBearer(web, key)).toEqual({ telegramUserId: 5, sessionVersion: 3 });
  expect(webClaimsFromBearer(upload, key)).toBeNull();
  expect(scopeFromBearer(web, key)).toBeNull();
  expect(webClaimsFromBearer(web, Buffer.alloc(32, 8))).toBeNull();
  expect(webClaimsFromBearer(`Bearer ${mintWebToken(5, key, 3, Date.now() - 9 * 3600_000)}`, key)).toBeNull();
  expect(webClaimsFromBearer(null, key)).toBeNull();
});

it("formats bytes, relative times and statuses for the Indonesian UI", () => {
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(1536)).toBe("1,50 KiB");
  expect(formatBytes(100 * 1024 * 1024)).toBe("100 MiB");
  expect(formatBytes(-1)).toBe("—");
  const now = Date.parse("2026-01-01T12:00:00Z");
  expect(formatTime("2026-01-01T11:59:30Z", now)).toBe("baru saja");
  expect(formatTime("2026-01-01T11:55:00Z", now)).toBe("5 menit lalu");
  expect(formatTime(null)).toBe("—");
  expect(statusInfo("uploaded")).toMatchObject({ label: "Antre di GitHub Actions", open: true });
  expect(statusInfo("failed")).toMatchObject({ tone: "bad", open: false });
});

it("progress is measured or honestly null, never invented", () => {
  const base = { stage: null, totalBytes: 0, bytesVerified: 0, filesTotal: null, filesProcessed: 0 };
  expect(jobProgress({ ...base, status: "uploaded" })).toBeNull();
  expect(jobProgress({ ...base, status: "processing", stage: "extracting" })).toBeNull();
  expect(jobProgress({ ...base, status: "processing", filesTotal: 10, filesProcessed: 5 })).toBe(50);
  expect(jobProgress({ ...base, status: "uploading", totalBytes: 200, bytesVerified: 50 })).toBe(25);
});
