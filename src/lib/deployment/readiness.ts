import { db } from "../db";
import { loadEnv } from "../env";
import { storageConfig, authHeadersFor } from "../supabase/storage";
import { dispatchConfigured } from "../actions-worker/dispatch";
import {
  describeDbError,
  describeEnvError,
  type Problem,
} from "./diagnostics";

/**
 * Two independent verdicts:
 *  - core: what /start, /login and the website need. A stopped ZIP processor never affects this.
 *  - processing: ZIP storage, job tables and the GitHub Actions processor. Reported separately.
 */
export interface CoreReadiness {
  ready: boolean;
  checks: { env: boolean; database: boolean; schema: boolean };
  problems: Problem[];
}
export interface ProcessingReadiness {
  ready: boolean;
  checks: { storage: boolean; schema: boolean; dispatch: boolean };
  queuedJobs: number | null;
  oldestQueuedSeconds: number | null;
  lastProcessorSeenAt: string | null;
  problems: Problem[];
}

export async function coreReadiness(): Promise<CoreReadiness> {
  const checks = { env: false, database: false, schema: false };
  const problems: Problem[] = [];
  try {
    loadEnv();
    checks.env = true;
  } catch (err) {
    problems.push(describeEnvError(err));
  }
  try {
    const { rows } = await db().query<{ ready: boolean }>(
      `select exists(select 1 from information_schema.columns where table_schema='app' and table_name='processed_updates' and column_name='processing_status')
        and exists(select 1 from information_schema.columns where table_schema='app' and table_name='telegram_users' and column_name='upload_session_version')
        and to_regclass('app.rate_limits') is not null and to_regclass('app.oauth_states') is not null as ready`,
    );
    checks.database = true;
    checks.schema = Boolean(rows[0]?.ready);
    if (!checks.schema)
      problems.push({
        area: "schema",
        code: "MIGRATIONS_MISSING",
        hint: "Core tables/columns are missing. Run db/migrations 0001–0007, then db/verify-migrations.sql.",
      });
  } catch (err) {
    problems.push(describeDbError(err));
  }
  return { ready: checks.env && checks.database && checks.schema, checks, problems };
}

async function storageOk(): Promise<boolean> {
  const cfg = storageConfig();
  const res = await fetch(
    `${cfg.url}/storage/v1/bucket/${encodeURIComponent(cfg.bucket)}`,
    {
      headers: authHeadersFor(cfg.secretKey),
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
      redirect: "error",
    },
  );
  const bucket = (await res.json().catch(() => null)) as {
    id?: string;
    name?: string;
    public?: boolean;
    file_size_limit?: number | null;
    allowed_mime_types?: string[] | null;
  } | null;
  const capacity =
    bucket?.file_size_limit == null || bucket.file_size_limit >= 8 * 1024 * 1024;
  const mimes = bucket?.allowed_mime_types;
  const acceptsBytes =
    mimes == null ||
    mimes.some((m) => ["application/octet-stream", "application/*", "*/*"].includes(m));
  return (
    res.ok &&
    bucket?.public === false &&
    (bucket.id === cfg.bucket || bucket.name === cfg.bucket) &&
    capacity &&
    acceptsBytes
  );
}

export async function processingReadiness(): Promise<ProcessingReadiness> {
  const checks = { storage: false, schema: false, dispatch: dispatchConfigured() };
  const problems: Problem[] = [];
  let queuedJobs: number | null = null;
  let oldestQueuedSeconds: number | null = null;
  let lastProcessorSeenAt: string | null = null;
  try {
    checks.storage = await storageOk();
    if (!checks.storage)
      problems.push({
        area: "storage",
        code: "BUCKET_UNUSABLE",
        hint: "Bucket must exist, be private, and accept application/octet-stream (≥ 8 MiB per object).",
      });
  } catch (err) {
    problems.push(
      err instanceof Error && /^Missing Supabase/.test(err.message)
        ? { area: "storage", code: "ENV_MISSING", hint: err.message.slice(0, 200) }
        : { area: "storage", code: "UNREACHABLE", hint: "Supabase Storage could not be reached." },
    );
  }
  try {
    const { rows } = await db().query<{ ready: boolean }>(
      `select (to_regclass('app.upload_job_files') is not null
          and exists(select 1 from information_schema.columns where table_schema='app' and table_name='upload_jobs' and column_name='lease_owner')
          and exists(select 1 from information_schema.columns where table_schema='app' and table_name='upload_jobs' and column_name='actions_run_id')) as ready`,
    );
    checks.schema = Boolean(rows[0]?.ready);
    if (checks.schema) {
      const q = await db().query<{ queued: string; oldest: number | null }>(
        `select count(*)::text as queued,
           extract(epoch from now() - min(next_attempt_at))::float8 as oldest
         from app.upload_jobs
         where status in ('uploaded','processing') and cancel_requested_at is null
           and (lease_until is null or lease_until < now())`,
      );
      queuedJobs = Number(q.rows[0]?.queued ?? 0);
      oldestQueuedSeconds =
        queuedJobs > 0 && q.rows[0]?.oldest != null ? Math.max(0, Math.round(q.rows[0].oldest)) : null;
      const beat = await db().query<{ seen: Date | null }>(
        "select max(last_seen_at) as seen from app.worker_heartbeats",
      );
      lastProcessorSeenAt = beat.rows[0]?.seen ? new Date(beat.rows[0].seen).toISOString() : null;
    } else {
      problems.push({
        area: "schema",
        code: "MIGRATION_0008_MISSING",
        hint: "Apply db/migrations 0006–0008 for ZIP processing.",
      });
    }
  } catch (err) {
    problems.push(describeDbError(err));
  }
  if (!checks.dispatch)
    problems.push({
      area: "dispatch",
      code: "ACTIONS_DISPATCH_TOKEN_MISSING",
      hint: "Optional: set ACTIONS_DISPATCH_TOKEN for instant processing. Without it the scheduled GitHub Actions sweep still processes jobs (up to ~30 min delay).",
    });
  return {
    ready: checks.storage && checks.schema,
    checks,
    queuedJobs,
    oldestQueuedSeconds,
    lastProcessorSeenAt,
    problems,
  };
}

export async function readiness() {
  const [core, processing] = await Promise.all([coreReadiness(), processingReadiness()]);
  return { status: core.ready ? "ready" : "unavailable", core, processing };
}
