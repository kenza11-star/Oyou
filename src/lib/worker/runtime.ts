import { randomUUID } from "node:crypto";
import { db } from "../db";
import { loadEnv } from "../env";
import { storageConfig } from "../supabase/storage";
import { expireStaleUploads } from "../upload/service";
import { claimJob, pause } from "./state";
import { processClaimedJob } from "./processor";
import { deliverOneNotice } from "./notifications";
import { actionsRunInfo, DEFAULT_BATCH, type BatchOptions } from "../actions-worker/run-info";

export async function verifyWorkerConfiguration(): Promise<void> {
  loadEnv();
  storageConfig();
  const { rows } = await db().query<{ ready: boolean }>(
    `select to_regclass('app.upload_job_files') is not null and to_regclass('app.worker_heartbeats') is not null
 and exists(select 1 from information_schema.columns where table_schema='app' and table_name='upload_jobs' and column_name='actions_run_id') as ready`,
  );
  if (!rows[0]?.ready) throw new Error("Apply migrations through 0008 before running the processor");
}

export async function runOneJob(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  const job = await claimJob();
  if (!job) return false;
  const run = actionsRunInfo();
  if (run)
    await db()
      .query("update app.upload_jobs set actions_run_id=$2,actions_run_url=$3 where id=$1 and lease_owner=$4", [
        job.id,
        run.id,
        run.url,
        job.lease_owner,
      ])
      .catch(() => undefined);
  await processClaimedJob(job, signal);
  return true;
}

async function flushNotices(token: string, max: number, signal?: AbortSignal) {
  for (let i = 0; i < max && !signal?.aborted; i++) if (!(await deliverOneNotice(token))) break;
}

/**
 * Drains the queue inside one GitHub Actions run, then exits. Bounded by claimWindowMs; a run that
 * is killed leaves its lease to expire and another run (dispatch or schedule) resumes from checkpoints.
 */
export async function runBatch(
  signal: AbortSignal,
  options: BatchOptions = DEFAULT_BATCH,
  deps = { runOneJob, flush: flushNotices, now: () => Date.now() },
): Promise<{ processed: number }> {
  const env = loadEnv();
  const instance = randomUUID();
  const started = deps.now();
  let processed = 0;
  const beat = () =>
    db()
      .query(
        "insert into app.worker_heartbeats(instance_id) values($1) on conflict(instance_id) do update set last_seen_at=now()",
        [instance],
      )
      .catch(() => undefined);
  await beat();
  // Telegram/website progress is delivered concurrently with processing.
  const stopNotices = new AbortController();
  const notices = (async () => {
    while (!stopNotices.signal.aborted && !signal.aborted) {
      try {
        await deps.flush(env.telegramBotToken, 10, stopNotices.signal);
        await beat();
      } catch (e) {
        console.error("notification loop", e instanceof Error ? e.name : "unknown");
      }
      try {
        await pause(1500, stopNotices.signal);
      } catch {
        break;
      }
    }
  })();
  try {
    let idleSince: number | null = null;
    while (!signal.aborted) {
      const now = deps.now();
      if (now - started > options.claimWindowMs) break;
      const worked = await deps.runOneJob(signal);
      if (worked) {
        processed++;
        idleSince = null;
        continue;
      }
      idleSince ??= deps.now();
      if (deps.now() - idleSince >= options.idleExitMs) break;
      try {
        await pause(3000, signal);
      } catch {
        break;
      }
    }
    await expireStaleUploads(10).catch(() => undefined);
  } finally {
    stopNotices.abort();
    await notices;
    // Final delivery so terminal states (completed / failed) always reach Telegram before the runner exits.
    if (!signal.aborted) await flushNotices(env.telegramBotToken, 20).catch(() => undefined);
    await db().query("delete from app.worker_heartbeats where instance_id=$1", [instance]).catch(() => undefined);
  }
  return { processed };
}
