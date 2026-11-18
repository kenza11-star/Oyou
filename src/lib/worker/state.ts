import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { PoolClient } from "pg";
import { db } from "../db";

export interface WorkerJob {
  id: string;
  telegram_user_id: string;
  telegram_chat_id: string | null;
  telegram_message_id: number | null;
  repo_id: string;
  repo_full_name: string;
  branch: string;
  status: string;
  processing_stage: string | null;
  total_bytes: string;
  bytes_received: string;
  chunk_count: number;
  chunk_size: number;
  file_sha256: string | null;
  files_total: number | null;
  files_extracted: number;
  files_processed: number;
  files_added: number;
  files_updated: number;
  files_unchanged: number;
  files_failed: number;
  github_bytes_total: string;
  github_bytes_uploaded: string;
  base_head_sha: string | null;
  base_tree_sha: string | null;
  target_tree_sha: string | null;
  commit_sha: string | null;
  commit_url: string | null;
  commit_timestamp: Date | null;
  commit_author: { name: string; email: string } | null;
  confirmed_head_sha: string | null;
  github_confirmed_at: Date | null;
  publish_started_at: Date | null;
  lease_owner: string | null;
  lease_until: Date | null;
  worker_attempts: number;
  worker_failures: number;
  next_attempt_at: Date;
  expires_at: Date;
  error: string | null;
}
export interface FileRecord {
  path: string;
  blob_sha: string;
  size: number;
  mode: "100644" | "100755";
  kind: "added" | "updated" | "unchanged";
  blob_uploaded: boolean;
}
export class LostLease extends Error {}
export class Cancelled extends Error {}
export class Deferred extends Error {
  constructor(
    public readonly delayMs: number,
    message = "Waiting for GitHub rate budget",
  ) {
    super(message);
  }
}
export function retryDelayMs(
  attempt: number,
  hint = 0,
  random = Math.random,
): number {
  return Math.max(
    hint,
    Math.min(300_000, 1000 * 2 ** Math.min(attempt, 8)) *
      (0.5 + random() * 0.5),
  );
}
export async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  await delay(ms, undefined, { signal });
}
export async function claimJob(leaseSeconds = 90): Promise<WorkerJob | null> {
  const owner = randomUUID();
  const { rows } = await db().query<WorkerJob>(
    `update app.upload_jobs set status='processing',lease_owner=$1,
 lease_until=now()+$2*interval '1 second',processing_started_at=coalesce(processing_started_at,now()),
 worker_attempts=worker_attempts+1,updated_at=now(),telegram_chat_id=coalesce(telegram_chat_id,telegram_user_id)
 where id=(select id from app.upload_jobs where status in ('uploaded','processing')
 and chunk_count is not null and file_sha256 is not null and cancel_requested_at is null and next_attempt_at<=now()
 and (lease_until is null or lease_until<now()) order by next_attempt_at,created_at for update skip locked limit 1) returning *`,
    [owner, leaseSeconds],
  );
  return rows[0] ?? null;
}
/** Claims one specific job (used for immediate processing right after upload). Null if another worker already holds it. */
export async function claimJobById(id: string, leaseSeconds = 90): Promise<WorkerJob | null> {
  const owner = randomUUID();
  const { rows } = await db().query<WorkerJob>(
    `update app.upload_jobs set status='processing',lease_owner=$1,
 lease_until=now()+$2*interval '1 second',processing_started_at=coalesce(processing_started_at,now()),
 worker_attempts=worker_attempts+1,updated_at=now(),telegram_chat_id=coalesce(telegram_chat_id,telegram_user_id)
 where id=$3 and status in ('uploaded','processing')
 and chunk_count is not null and file_sha256 is not null and cancel_requested_at is null and next_attempt_at<=now()
 and (lease_until is null or lease_until<now()) returning *`,
    [owner, leaseSeconds, id],
  );
  return rows[0] ?? null;
}
const mutable = new Set([
  "processing_stage",
  "files_total",
  "files_extracted",
  "files_processed",
  "files_added",
  "files_updated",
  "files_unchanged",
  "files_failed",
  "github_bytes_total",
  "github_bytes_uploaded",
  "base_head_sha",
  "base_tree_sha",
  "target_tree_sha",
  "commit_sha",
  "commit_url",
  "commit_timestamp",
  "commit_author",
  "confirmed_head_sha",
  "github_confirmed_at",
  "publish_started_at",
  "error",
]);
export class Lease {
  readonly abort = new AbortController();
  private stop = new AbortController();
  private heartbeat: Promise<void> | null = null;
  constructor(
    public readonly job: WorkerJob,
    private readonly seconds = 90,
  ) {}
  get signal() {
    return this.abort.signal;
  }
  async check(): Promise<void> {
    if (this.signal.aborted)
      throw new LostLease("Worker stopped or lease lost");
    const { rows } = await db().query<{ status: string; valid: boolean }>(
      `select status,lease_owner=$2 and lease_until>now() as valid from app.upload_jobs where id=$1`,
      [this.job.id, this.job.lease_owner],
    );
    if (rows[0]?.status === "cancelled") {
      this.abort.abort();
      throw new Cancelled("Upload cancelled");
    }
    if (rows[0]?.status !== "processing" || !rows[0].valid) {
      this.abort.abort();
      throw new LostLease("Worker lease lost");
    }
  }
  async save(fields: Record<string, unknown>): Promise<void> {
    const entries = Object.entries(fields);
    if (entries.some(([key]) => !mutable.has(key)))
      throw new Error("Invalid checkpoint field");
    if (!entries.length) return;
    const { rowCount } = await db().query(
      `update app.upload_jobs set ${entries.map(([k], i) => `${k}=$${i + 3}`).join(",")},version=version+1,updated_at=now()
   where id=$1 and lease_owner=$2 and lease_until>now() and status='processing' and cancel_requested_at is null`,
      [this.job.id, this.job.lease_owner, ...entries.map(([, v]) => v)],
    );
    if (!rowCount) throw new LostLease("Checkpoint rejected");
    Object.assign(this.job, fields);
  }
  startHeartbeat(): void {
    this.heartbeat = (async () => {
      while (!this.stop.signal.aborted) {
        try {
          await pause((this.seconds * 1000) / 3, this.stop.signal);
        } catch {
          break;
        }
        try {
          const { rowCount } = await db().query(
            `update app.upload_jobs set lease_until=now()+$3*interval '1 second'
      where id=$1 and lease_owner=$2 and lease_until>now() and status='processing' and cancel_requested_at is null`,
            [this.job.id, this.job.lease_owner, this.seconds],
          );
          if (!rowCount) {
            this.abort.abort();
            break;
          }
        } catch {
          this.abort.abort();
          break;
        }
      }
    })();
  }
  async close(): Promise<void> {
    this.stop.abort();
    await this.heartbeat;
  }
}
export async function withLeaseLock<T>(
  lease: Lease,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db().connect();
  try {
    await client.query("begin");
    const { rows } = await client.query(
      `select id from app.upload_jobs where id=$1 and lease_owner=$2 and lease_until>now() and status='processing' and cancel_requested_at is null for update`,
      [lease.job.id, lease.job.lease_owner],
    );
    if (!rows[0]) throw new LostLease("Lease no longer owns this job");
    const value = await fn(client);
    await client.query("commit");
    return value;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
export async function initializeFiles(
  lease: Lease,
  files: FileRecord[],
): Promise<void> {
  await withLeaseLock(lease, async (c) => {
    const old = await c.query<{ n: string }>(
      "select count(*) as n from app.upload_job_files where job_id=$1",
      [lease.job.id],
    );
    if (Number(old.rows[0].n) > 0) {
      if (Number(old.rows[0].n) !== files.length)
        throw new Error("Manifest checkpoint mismatch");
      return;
    }
    await c.query(
      `insert into app.upload_job_files(job_id,path,blob_sha,size,mode,kind,blob_uploaded)
   select $1,path,blob_sha,size,mode,kind,blob_uploaded from jsonb_to_recordset($2::jsonb)
   as f(path text,blob_sha text,size bigint,mode text,kind text,blob_uploaded boolean)`,
      [lease.job.id, JSON.stringify(files)],
    );
    await c.query(
      `update app.upload_jobs set files_total=$2,files_processed=$7,files_added=$4,files_updated=$5,files_unchanged=$3,
   github_bytes_total=$6,updated_at=now(),version=version+1 where id=$1`,
      [
        lease.job.id,
        files.length,
        files.filter((f) => f.kind === "unchanged").length,
        files.filter((f) => f.kind === "added").length,
        files.filter((f) => f.kind === "updated").length,
        [
          ...new Map(
            files
              .filter((f) => f.kind !== "unchanged" && !f.blob_uploaded)
              .map((f) => [f.blob_sha, f.size]),
          ).values(),
        ].reduce((a, b) => a + b, 0),
        files.filter((f) => f.blob_uploaded).length,
      ],
    );
  });
}
export async function acknowledgeBlob(
  lease: Lease,
  sha: string,
  size: number,
): Promise<void> {
  await withLeaseLock(lease, async (c) => {
    const result = await c.query(
      `update app.upload_job_files set blob_uploaded=true where job_id=$1 and blob_sha=$2 and kind<>'unchanged' and not blob_uploaded returning path`,
      [lease.job.id, sha],
    );
    if (result.rows.length)
      await c.query(
        `update app.upload_jobs set files_processed=files_processed+$2,github_bytes_uploaded=github_bytes_uploaded+$3,worker_failures=0,updated_at=now(),version=version+1 where id=$1`,
        [lease.job.id, result.rows.length, size],
      );
  });
}
export async function finishJob(lease: Lease, head: string): Promise<void> {
  await withLeaseLock(lease, async (c) => {
    await c.query(
      `update app.upload_jobs set status='completed',processing_stage='completed',confirmed_head_sha=$3,
   github_confirmed_at=now(),completed_at=now(),lease_owner=null,lease_until=null,error=null,notify_after=now(),
   expires_at=now()+interval '72 hours',updated_at=now(),version=version+1 where id=$1 and lease_owner=$2`,
      [lease.job.id, lease.job.lease_owner, head],
    );
  });
}
export async function releaseJob(
  lease: Lease,
  error: string,
  delayMs: number,
  terminal: boolean,
): Promise<void> {
  await db().query(
    `update app.upload_jobs set status=case when $5 then 'failed' else 'processing' end,
 processing_stage=case when $5 then 'failed' else processing_stage end,error=$3,next_attempt_at=now()+$4*interval '1 millisecond',
 worker_failures=worker_failures+case when $6 then 0 else 1 end,lease_owner=null,lease_until=null,
 expires_at=case when $5 then now()+interval '72 hours' else expires_at end,notify_after=now(),updated_at=now(),version=version+1
 where id=$1 and lease_owner=$2 and lease_until>now() and status='processing'`,
    [
      lease.job.id,
      lease.job.lease_owner,
      error.slice(0, 1000),
      delayMs,
      terminal,
      error.startsWith("Waiting for GitHub"),
    ],
  );
}
/** Per-user persistent, conservative content-creation budget shared across workers. */
export async function reserveMutation(userId: number): Promise<number> {
  const c = await db().connect();
  try {
    await c.query("begin");
    await c.query(
      "insert into app.worker_github_budgets(user_id) values ($1) on conflict do nothing",
      [userId],
    );
    const { rows } = await c.query<{ wait_ms: number }>(
      `select greatest(0,extract(epoch from (greatest(blocked_until,
   case when minute_count>=60 and minute_start>now()-interval '1 minute' then minute_start+interval '1 minute' else now() end,
   case when hour_count>=400 and hour_start>now()-interval '1 hour' then hour_start+interval '1 hour' else now() end)-now()))*1000)::float8 as wait_ms
   from app.worker_github_budgets where user_id=$1 for update`,
      [userId],
    );
    const wait = Number(rows[0].wait_ms);
    if (wait <= 0)
      await c.query(
        `update app.worker_github_budgets set
   minute_count=case when minute_start<=now()-interval '1 minute' then 1 else minute_count+1 end,
   minute_start=case when minute_start<=now()-interval '1 minute' then now() else minute_start end,
   hour_count=case when hour_start<=now()-interval '1 hour' then 1 else hour_count+1 end,
   hour_start=case when hour_start<=now()-interval '1 hour' then now() else hour_start end where user_id=$1`,
        [userId],
      );
    await c.query("commit");
    return wait;
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
export async function blockGithub(userId: number, ms: number): Promise<void> {
  await db().query(
    `insert into app.worker_github_budgets(user_id,blocked_until) values ($1,now()+$2*interval '1 millisecond')
 on conflict(user_id) do update set blocked_until=greatest(app.worker_github_budgets.blocked_until,excluded.blocked_until)`,
    [userId, ms],
  );
}
