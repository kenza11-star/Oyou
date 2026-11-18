import { dispatchProcessor } from "../actions-worker/dispatch";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { UploadScope } from "./session";
import { db } from "../db";
import { loadEnv } from "../env";
import { getUsableToken } from "../github/credentials";
import { assertRepoAccessible } from "../github/repos";
import {
  GithubAuthError,
  GithubNotFoundError,
  GithubRateLimitError,
  UserFacingError,
} from "../github/client";
import { getUserState } from "../telegram/state";
import { planChunks } from "./chunks";
import { CHUNK_LIMITS, UPLOAD_LIMITS } from "./limits";
import {
  chunkObjectPath,
  createSignedUploadUrl,
  downloadObject,
  removeObjects,
  storageConfig,
} from "../supabase/storage";
import { HttpError } from "../transfer/engine";

export class UploadError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const MAX_ACTIVE_JOBS = 3;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export interface NewJobInput {
  fileName: string;
  totalBytes: number;
  clientKey: string;
  fileSha256: string;
}

/** Validates client input. Everything the browser sends is untrusted until it passes here. */
export function validateNewJob(body: unknown): NewJobInput {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.fileName !== "string")
    throw new UploadError(400, "fileName is required");
  const fileName = b.fileName.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (fileName.length === 0 || fileName.length > 200)
    throw new UploadError(400, "fileName must be 1-200 characters");
  if (/[\\/]/.test(fileName))
    throw new UploadError(400, "fileName must not contain path separators");
  if (!fileName.toLowerCase().endsWith(".zip"))
    throw new UploadError(400, "Only .zip files are accepted");
  if (
    typeof b.totalBytes !== "number" ||
    !Number.isSafeInteger(b.totalBytes) ||
    b.totalBytes <= 0
  ) {
    throw new UploadError(400, "totalBytes must be a positive integer");
  }
  if (b.totalBytes > UPLOAD_LIMITS.webArchiveBytes) {
    throw new UploadError(
      413,
      "The ZIP is larger than the 100 MB browser upload limit",
    );
  }
  if (typeof b.clientKey !== "string" || !UUID_RE.test(b.clientKey))
    throw new UploadError(400, "clientKey must be a UUID");
  if (typeof b.fileSha256 !== "string" || !SHA256_RE.test(b.fileSha256))
    throw new UploadError(
      400,
      "fileSha256 must be 64 lowercase hex characters",
    );
  return {
    fileName,
    totalBytes: b.totalBytes,
    clientKey: b.clientKey,
    fileSha256: b.fileSha256,
  };
}

interface JobRow {
  id: string;
  telegram_user_id: string;
  status: string;
  file_name: string;
  repo_full_name: string;
  branch: string;
  total_bytes: string;
  chunk_size: number;
  chunk_count: number;
  expires_at: Date;
  idempotency_key: string | null;
  file_sha256: string | null;
  repo_id: string;
  processing_stage?: string | null;
  publish_started_at?: Date | null;
  commit_sha?: string | null;
  commit_url?: string | null;
  files_total?: number | null;
  files_processed?: number;
  files_extracted?: number;
  files_added?: number;
  files_updated?: number;
  files_unchanged?: number;
  error?: string | null;
}

interface ChunkRow {
  chunk_index: number;
  size: string;
  status: string;
  sha256: string | null;
  object_path: string | null;
}

export interface JobSummary {
  id: string;
  status: string;
  fileName: string;
  repoFullName: string;
  branch: string;
  totalBytes: number;
  chunkSize: number;
  chunkCount: number;
  bytesVerified: number;
  expiresAt: string;
  chunks: { index: number; size: number; status: string }[];
  missing: number[];
  stage: string | null;
  filesTotal: number | null;
  filesProcessed: number;
  filesExtracted: number;
  added: number;
  updated: number;
  unchanged: number;
  commitSha: string | null;
  commitUrl: string | null;
  error: string | null;
  canCancel: boolean;
}

function summarize(job: JobRow, chunks: ChunkRow[]): JobSummary {
  const list = chunks.map((c) => ({
    index: c.chunk_index,
    size: Number(c.size),
    status: c.status,
  }));
  return {
    id: job.id,
    status: job.status,
    stage: job.processing_stage ?? null,
    filesTotal: job.files_total ?? null,
    filesProcessed: job.files_processed ?? 0,
    filesExtracted: job.files_extracted ?? 0,
    added: job.files_added ?? 0,
    updated: job.files_updated ?? 0,
    unchanged: job.files_unchanged ?? 0,
    commitSha: job.commit_sha ?? null,
    commitUrl: job.commit_url ?? null,
    error: job.error ?? null,
    canCancel:
      ["created", "uploading", "uploaded", "processing"].includes(job.status) &&
      !job.publish_started_at,
    fileName: job.file_name,
    repoFullName: job.repo_full_name,
    branch: job.branch,
    totalBytes: Number(job.total_bytes),
    chunkSize: job.chunk_size,
    chunkCount: job.chunk_count,
    bytesVerified: list
      .filter((c) => c.status === "verified")
      .reduce((s, c) => s + c.size, 0),
    expiresAt: new Date(job.expires_at).toISOString(),
    chunks: list,
    missing: list.filter((c) => c.status !== "verified").map((c) => c.index),
  };
}

async function loadOwned(
  jobId: string,
  userId: number,
): Promise<{ job: JobRow; chunks: ChunkRow[] }> {
  if (!isUuid(jobId)) throw new UploadError(404, "Upload not found");
  const { rows } = await db().query<JobRow>(
    `select * from app.upload_jobs where id = $1 and telegram_user_id = $2`,
    [jobId, userId],
  );
  // Same response for "missing" and "belongs to someone else": no existence leak across users.
  if (rows.length === 0) throw new UploadError(404, "Upload not found");
  const ch = await db().query<ChunkRow>(
    `select chunk_index, size, status, sha256, object_path from app.upload_job_chunks where job_id = $1 order by chunk_index`,
    [jobId],
  );
  return { job: rows[0], chunks: ch.rows };
}

function mapGithubError(err: unknown): never {
  if (err instanceof GithubAuthError) {
    throw new UploadError(
      401,
      "Your GitHub session expired. Send /login in the bot to reconnect.",
    );
  }
  if (err instanceof GithubNotFoundError) {
    throw new UploadError(
      403,
      "That repository is not available through your GitHub App installation. Check /repos.",
    );
  }
  if (err instanceof GithubRateLimitError)
    throw new UploadError(503, "GitHub rate limit reached. Try again later.");
  if (err instanceof UserFacingError) throw new UploadError(502, err.message);
  throw err;
}

/**
 * Creates a job, or returns the existing job for the same client key (idempotent retries and resume).
 * The repository and branch come from the server-side selection, never from the request.
 */
export async function createOrResumeJob(
  userId: number,
  input: NewJobInput,
  scope?: UploadScope,
): Promise<JobSummary> {
  const state = scope
    ? {
        repoId: scope.repoId,
        repoFullName: scope.repoFullName,
        repoBranch: scope.branch,
      }
    : await getUserState(userId);
  if (!state.repoId || !state.repoFullName || !state.repoBranch)
    throw new UploadError(
      409,
      "Select a repository first with /repos in the bot",
    );
  const cred = await getUsableToken(userId, loadEnv());
  if (!cred)
    throw new UploadError(
      401,
      "Connect your GitHub account first with /login in the bot",
    );
  try {
    await assertRepoAccessible(cred.token, state.repoId);
  } catch (err) {
    mapGithubError(err);
  }
  const validateExisting = (job: JobRow) => {
    if (
      Number(job.total_bytes) !== input.totalBytes ||
      job.file_name !== input.fileName ||
      job.file_sha256 !== input.fileSha256 ||
      Number(job.repo_id) !== state.repoId ||
      job.repo_full_name !== state.repoFullName ||
      job.branch !== state.repoBranch
    ) {
      throw new UploadError(
        409,
        "This upload key belongs to a different file or repository",
      );
    }
    if (
      new Date(job.expires_at).getTime() <= Date.now() ||
      ["expired", "cancelled", "failed"].includes(job.status)
    ) {
      throw new UploadError(
        410,
        "Upload expired or closed. Retry to create a fresh job.",
      );
    }
  };
  const existing = await findByKey(userId, input.clientKey);
  if (existing) {
    const { job, chunks } = await loadOwned(existing, userId);
    validateExisting(job);
    return summarize(job, chunks);
  }

  const plan = planChunks(input.totalBytes, CHUNK_LIMITS.defaultBytes);
  const jobId = randomUUID();
  const client = await db().connect();
  try {
    await client.query("begin");
    // Serialize creations for one user so the active-job quota is atomic.
    await client.query(
      "select id from app.telegram_users where id = $1 for update",
      [userId],
    );
    const racedId = await client.query<{ id: string }>(
      "select id from app.upload_jobs where telegram_user_id=$1 and idempotency_key=$2",
      [userId, input.clientKey],
    );
    if (racedId.rows[0]) {
      const { rows: jobs } = await client.query<JobRow>(
        "select * from app.upload_jobs where id=$1 and telegram_user_id=$2",
        [racedId.rows[0].id, userId],
      );
      const { rows: chunks } = await client.query<ChunkRow>(
        "select chunk_index,size,status,sha256,object_path from app.upload_job_chunks where job_id=$1 order by chunk_index",
        [racedId.rows[0].id],
      );
      validateExisting(jobs[0]);
      await client.query("commit");
      return summarize(jobs[0], chunks);
    }
    const active = await client.query<{ n: string }>(
      "select count(*) as n from app.upload_jobs where telegram_user_id=$1 and status in ('created','uploading','uploaded','processing') and expires_at > now()",
      [userId],
    );
    if (Number(active.rows[0].n) >= MAX_ACTIVE_JOBS)
      throw new UploadError(
        429,
        `You have ${MAX_ACTIVE_JOBS} unfinished uploads. Finish or cancel one first.`,
      );
    await client.query(
      `insert into app.upload_jobs
         (id, telegram_user_id, storage_path, declared_size, status, expires_at, file_name,
          repo_id, repo_full_name, branch, total_bytes, chunk_size, chunk_count, idempotency_key, file_sha256)
       values ($1, $2, $3, $4, 'created', now() + interval '24 hours', $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        jobId,
        userId,
        `jobs/${jobId}`,
        input.totalBytes,
        input.fileName,
        state.repoId,
        state.repoFullName,
        state.repoBranch,
        input.totalBytes,
        CHUNK_LIMITS.defaultBytes,
        plan.length,
        input.clientKey,
        input.fileSha256,
      ],
    );
    await client.query(
      `insert into app.upload_job_chunks (job_id, chunk_index, size, status)
       select $1, i, s, 'pending' from unnest($2::int[], $3::bigint[]) as t(i, s)`,
      [jobId, plan.map((p) => p.index), plan.map((p) => p.size)],
    );
    await client.query(
      "update app.upload_jobs set telegram_chat_id=telegram_user_id where id=$1",
      [jobId],
    );
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  const { job, chunks } = await loadOwned(jobId, userId);
  return summarize(job, chunks);
}

async function findByKey(userId: number, key: string): Promise<string | null> {
  const { rows } = await db().query<{ id: string }>(
    `select id from app.upload_jobs where telegram_user_id = $1 and idempotency_key = $2`,
    [userId, key],
  );
  return rows[0]?.id ?? null;
}

export async function getJobSummary(
  userId: number,
  jobId: string,
): Promise<JobSummary> {
  const { job, chunks } = await loadOwned(jobId, userId);
  return summarize(job, chunks);
}

function parseIndex(job: JobRow, index: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= job.chunk_count) {
    throw new UploadError(400, "Chunk index is out of range");
  }
}

/** Lock the owned job for each state change. All writers use this order (job, then chunks).
 * Storage uploads use distinct non-upsert paths; stale URLs cannot mutate verified objects.
 */
async function locked<T>(
  userId: number,
  jobId: string,
  fn: (client: PoolClient, job: JobRow) => Promise<T>,
): Promise<T> {
  if (!isUuid(jobId)) throw new UploadError(404, "Upload not found");
  const client = await db().connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<JobRow>(
      "select * from app.upload_jobs where id=$1 and telegram_user_id=$2 for update",
      [jobId, userId],
    );
    if (!rows[0]) throw new UploadError(404, "Upload not found");
    const result = await fn(client, rows[0]);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
function requireOpen(job: JobRow, allowUploaded = false): void {
  if (new Date(job.expires_at).getTime() <= Date.now())
    throw new UploadError(
      410,
      "Upload expired. Open /upload in Telegram again.",
    );
  if (
    ![
      "created",
      "uploading",
      ...(allowUploaded ? ["uploaded", "processing", "completed"] : []),
    ].includes(job.status)
  )
    throw new UploadError(409, `This upload is ${job.status}`);
}
async function readChunk(
  client: PoolClient,
  job: JobRow,
  index: number,
): Promise<ChunkRow> {
  parseIndex(job, index);
  const { rows } = await client.query<ChunkRow>(
    "select * from app.upload_job_chunks where job_id=$1 and chunk_index=$2 for update",
    [job.id, index],
  );
  if (!rows[0]) throw new UploadError(404, "Chunk not found");
  return rows[0];
}
export async function issueChunkUrl(
  userId: number,
  jobId: string,
  index: number,
): Promise<
  { verified: true } | { verified: false; url: string; attemptId: string }
> {
  return locked(userId, jobId, async (client, job) => {
    requireOpen(job, true);
    const chunk = await readChunk(client, job, index);
    if (chunk.status === "verified") return { verified: true };
    requireOpen(job);
    const { rows: counts } = await client.query<{ n: string }>(
      "select count(*) as n from app.upload_chunk_attempts where job_id=$1 and chunk_index=$2",
      [job.id, index],
    );
    if (Number(counts[0]?.n ?? 0) >= 20)
      throw new UploadError(
        429,
        "Upload attempt limit reached. Cancel this job and start a fresh upload.",
      );
    const attemptId = randomUUID();
    const path = `jobs/${job.id}/attempts/${attemptId}/chunk-${index}.bin`;
    // Persist every issued path, including abandoned attempts, for reliable cleanup.
    await client.query(
      "insert into app.upload_chunk_attempts (id,job_id,chunk_index,object_path) values ($1,$2,$3,$4)",
      [attemptId, job.id, index, path],
    );
    const url = await createSignedUploadUrl(storageConfig(), path);
    await client.query(
      "update app.upload_job_chunks set attempts=attempts+1 where job_id=$1 and chunk_index=$2",
      [job.id, index],
    );
    await client.query(
      "update app.upload_jobs set status='uploading', updated_at=now(), version=version+1 where id=$1",
      [job.id],
    );
    return { verified: false, url, attemptId };
  });
}
export async function completeChunk(
  userId: number,
  jobId: string,
  index: number,
  body: { sha256: unknown; size: unknown; attemptId?: unknown },
): Promise<{ verified: true }> {
  if (typeof body.sha256 !== "string" || !SHA256_RE.test(body.sha256))
    throw new UploadError(400, "sha256 must be 64 lowercase hex characters");
  if (
    typeof body.size !== "number" ||
    !Number.isSafeInteger(body.size) ||
    body.size <= 0
  )
    throw new UploadError(400, "size must be a positive integer");
  if (typeof body.attemptId !== "string" || !isUuid(body.attemptId))
    throw new UploadError(400, "A valid upload attemptId is required");
  const attempt = await locked(userId, jobId, async (client, job) => {
    requireOpen(job, true);
    const chunk = await readChunk(client, job, index);
    if (Number(chunk.size) !== body.size)
      throw new UploadError(400, "size does not match the planned chunk size");
    const { rows } = await client.query<{ object_path: string }>(
      "select object_path from app.upload_chunk_attempts where id=$1 and job_id=$2 and chunk_index=$3",
      [body.attemptId, job.id, index],
    );
    if (!rows[0]) throw new UploadError(409, "Upload attempt not found");
    if (chunk.status === "verified" && chunk.sha256 !== body.sha256)
      throw new UploadError(
        409,
        "Chunk was already verified with a different checksum",
      );
    if (chunk.status !== "verified") requireOpen(job);
    return {
      path: rows[0].object_path,
      size: Number(chunk.size),
      verified: chunk.status === "verified",
    };
  });
  if (attempt.verified) return { verified: true };
  // Attempt paths are immutable. Download/hash outside the transaction so other chunks,
  // cancellation and users are not blocked behind a slow Storage response.
  let bytes: Uint8Array;
  try {
    bytes = await downloadObject(storageConfig(), attempt.path, attempt.size);
  } catch (err) {
    if (err instanceof HttpError && [400, 404].includes(err.status))
      throw new UploadError(425, "Chunk not available yet; retry completion");
    throw err;
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== body.size || actual !== body.sha256)
    throw new UploadError(
      422,
      "Checksum mismatch. Retry with a fresh upload attempt.",
    );
  return locked(userId, jobId, async (client, job) => {
    requireOpen(job, true);
    const chunk = await readChunk(client, job, index);
    if (chunk.status === "verified") {
      if (chunk.sha256 !== actual)
        throw new UploadError(
          409,
          "Chunk was already verified with a different checksum",
        );
      return { verified: true };
    }
    requireOpen(job);
    if (Number(chunk.size) !== attempt.size)
      throw new UploadError(409, "Chunk plan changed");
    await client.query(
      "update app.upload_job_chunks set status='verified',sha256=$3,object_path=$4,uploaded_at=now() where job_id=$1 and chunk_index=$2",
      [job.id, index, actual, attempt.path],
    );
    await client.query(
      "update app.upload_jobs set bytes_received=(select coalesce(sum(size),0) from app.upload_job_chunks where job_id=$1 and status='verified'),updated_at=now(),version=version+1 where id=$1",
      [job.id],
    );
    return { verified: true };
  });
}
/** Finalizes the upload transaction and durably enqueues processing. Worker verifies whole ZIP. */
export async function markReady(
  userId: number,
  jobId: string,
): Promise<JobSummary> {
  await locked(userId, jobId, async (client, job) => {
    if (["uploaded", "processing", "completed"].includes(job.status)) return;
    requireOpen(job);
    const { rows: chunks } = await client.query<ChunkRow>(
      "select chunk_index,size,status,sha256,object_path from app.upload_job_chunks where job_id=$1 order by chunk_index",
      [job.id],
    );
    if (
      chunks.length !== job.chunk_count ||
      chunks.some(
        (c, i) => c.chunk_index !== i || c.status !== "verified" || !c.sha256,
      ) ||
      chunks.reduce((n, c) => n + Number(c.size), 0) !== Number(job.total_bytes)
    )
      throw new UploadError(
        409,
        "Upload is incomplete: every chunk must be verified",
      );
    if (!job.file_sha256)
      throw new UploadError(
        409,
        "Legacy upload has no file identity. Start a new upload.",
      );
    await client.query(
      `update app.upload_jobs set status='uploaded',processing_stage='verifying',telegram_chat_id=telegram_user_id,
   next_attempt_at=now(),notify_after=now(),expires_at=now()+interval '72 hours',updated_at=now(),version=version+1 where id=$1`,
      [job.id],
    );
  });
  await notifyProcessor(jobId);
  return getJobSummary(userId, jobId);
}
/**
 * Publishes the uploaded ZIP to GitHub right away, inside this request, instead of waiting for the scheduled
 * Actions sweep. If this request is cut short the lease expires and the sweep resumes from the saved checkpoints.
 */
export async function processJobNow(userId: number, jobId: string): Promise<JobSummary> {
  const { claimJobById } = await import("../worker/state");
  const { processClaimedJob } = await import("../worker/processor");
  const { deliverOneNotice } = await import("../worker/notifications");
  const { loadEnv } = await import("../env");
  const owned = await db().query("select 1 from app.upload_jobs where id=$1 and telegram_user_id=$2", [jobId, userId]);
  if (owned.rowCount) {
    const job = await claimJobById(jobId);
    if (job) {
      try {
        await processClaimedJob(job);
      } catch (e) {
        console.error("inline processing", e instanceof Error ? e.name : "unknown");
      }
      try {
        const token = loadEnv().telegramBotToken;
        for (let i = 0; i < 6; i++) if (!(await deliverOneNotice(token))) break;
      } catch {
        /* Telegram notices are best effort; the sweep delivers leftovers. */
      }
    }
  }
  return getJobSummary(userId, jobId);
}
/** Best effort. The job is already durable; a failed dispatch is recovered by the scheduled sweep. */
async function notifyProcessor(jobId: string): Promise<void> {
  try {
    const result = await dispatchProcessor();
    await db().query(
      "update app.upload_jobs set dispatched_at=case when $2 then now() else dispatched_at end,dispatch_error=$3 where id=$1 and status='uploaded'",
      [jobId, result.ok, result.ok ? null : `dispatch_${result.reason}${"status" in result && result.status ? `_${result.status}` : ""}`],
    );
  } catch {
    /* Columns from migration 0008 may be absent; never fail an upload over bookkeeping. */
  }
}
export async function cancelJob(
  userId: number,
  jobId: string,
): Promise<JobSummary> {
  await locked(userId, jobId, async (client, job) => {
    if (job.status === "cancelled") return;
    if (
      !["created", "uploading", "uploaded", "processing"].includes(job.status)
    )
      throw new UploadError(
        409,
        `This upload is ${job.status} and cannot be cancelled`,
      );
    if (job.publish_started_at)
      throw new UploadError(
        409,
        "GitHub publication is already in progress. Wait for confirmation; cancellation cannot safely undo a remote commit.",
      );
    // Signed upload URLs live for two hours and cannot be individually revoked.
    // Delay deletion until ALL issued URLs have expired, preventing late orphan writes.
    await client.query(
      "update app.upload_jobs set status='cancelled', processing_stage='cancelled',cancel_requested_at=now(),lease_owner=null,lease_until=null,notify_after=now(), expires_at=greatest(now(),coalesce((select max(created_at) from app.upload_chunk_attempts where job_id=$1),now()))+interval '3 hours', updated_at=now(),version=version+1 where id=$1",
      [job.id],
    );
  });
  return getJobSummary(userId, jobId);
}
export async function expireStaleUploads(limit = 20): Promise<number> {
  const { rows } = await db().query<{ id: string; telegram_user_id: string }>(
    `select id,telegram_user_id from app.upload_jobs j where status in ('created','uploading','uploaded','cancelled','completed','failed') and expires_at<now() and storage_cleaned_at is null
    and not exists(select 1 from app.upload_chunk_attempts a where a.job_id=j.id and a.created_at>now()-interval '3 hours') order by expires_at limit $1`,
    [limit],
  );
  let done = 0;
  for (const row of rows) {
    try {
      await locked(
        Number(row.telegram_user_id),
        row.id,
        async (client, job) => {
          if (
            ![
              "created",
              "uploading",
              "uploaded",
              "cancelled",
              "completed",
              "failed",
            ].includes(job.status) ||
            new Date(job.expires_at).getTime() > Date.now()
          )
            return;
          const { rows: attempts } = await client.query<{
            object_path: string;
            created_at: Date;
          }>(
            "select object_path,created_at from app.upload_chunk_attempts where job_id=$1",
            [job.id],
          );
          if (
            attempts.some(
              (a) =>
                new Date(a.created_at).getTime() > Date.now() - 3 * 60 * 60_000,
            )
          )
            return;
          const paths = [
            ...new Set([
              ...attempts.map((a) => a.object_path),
              ...Array.from({ length: job.chunk_count ?? 0 }, (_, i) =>
                chunkObjectPath(job.id, i),
              ),
            ]),
          ];
          for (let offset = 0; offset < paths.length; offset += 100)
            await removeObjects(
              storageConfig(),
              paths.slice(offset, offset + 100),
            );
          await client.query(
            "update app.upload_jobs set status=case when status in ('completed','failed') then status else 'expired' end,storage_cleaned_at=now(),updated_at=now(),version=version+1 where id=$1",
            [job.id],
          );
          done++;
        },
      );
    } catch {
      /* Leave retryable cleanup in place. */
    }
  }
  return done;
}

export interface JobListItem {
  id: string;
  fileName: string | null;
  repoFullName: string | null;
  branch: string | null;
  status: string;
  stage: string | null;
  totalBytes: number;
  bytesVerified: number;
  filesTotal: number | null;
  filesProcessed: number;
  added: number;
  updated: number;
  unchanged: number;
  commitSha: string | null;
  commitUrl: string | null;
  error: string | null;
  actionsRunUrl: string | null;
  createdAt: string;
  completedAt: string | null;
  canCancel: boolean;
  canRetry: boolean;
}

/** Only the caller's own jobs. Internal columns (lease owners, notification state, user ids) are never returned. */
export async function listJobs(userId: number, limit = 30): Promise<JobListItem[]> {
  const { rows } = await db().query(
    `select id,file_name,repo_full_name,branch,status,processing_stage,total_bytes,bytes_received,files_total,files_processed,
            files_added,files_updated,files_unchanged,commit_sha,commit_url,error,actions_run_url,created_at,completed_at,
            publish_started_at,storage_cleaned_at,expires_at,retry_count,github_confirmed_at
     from app.upload_jobs where telegram_user_id=$1 and repo_full_name is not null order by created_at desc limit $2`,
    [userId, Math.min(Math.max(limit, 1), 100)],
  );
  return rows.map((r) => {
    const open = ["created", "uploading", "uploaded", "processing"].includes(r.status);
    const confirmed = r.status === "completed" && r.github_confirmed_at;
    return {
      id: r.id,
      fileName: r.file_name,
      repoFullName: r.repo_full_name,
      branch: r.branch,
      status: r.status === "completed" && !confirmed ? "processing" : r.status,
      stage: r.processing_stage,
      totalBytes: Number(r.total_bytes ?? 0),
      bytesVerified: Number(r.bytes_received ?? 0),
      filesTotal: r.files_total,
      filesProcessed: r.files_processed ?? 0,
      added: r.files_added ?? 0,
      updated: r.files_updated ?? 0,
      unchanged: r.files_unchanged ?? 0,
      commitSha: confirmed ? r.commit_sha : null,
      commitUrl: confirmed ? r.commit_url : null,
      error: r.error,
      actionsRunUrl: r.actions_run_url ?? null,
      createdAt: new Date(r.created_at).toISOString(),
      completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
      canCancel: open && !r.publish_started_at,
      canRetry: canRetry(r),
    };
  });
}

export function canRetry(r: {
  status: string;
  publish_started_at: unknown;
  storage_cleaned_at: unknown;
  expires_at: Date | string;
  retry_count?: number | null;
}): boolean {
  return (
    r.status === "failed" &&
    !r.publish_started_at &&
    !r.storage_cleaned_at &&
    new Date(r.expires_at).getTime() > Date.now() &&
    (r.retry_count ?? 0) < MAX_MANUAL_RETRIES
  );
}
export const MAX_MANUAL_RETRIES = 3;

/**
 * Re-queues a failed job whose ZIP is still in private storage. Refused when GitHub publication had started
 * (the remote outcome is uncertain), when storage was cleaned, or after MAX_MANUAL_RETRIES attempts.
 */
export async function retryJob(userId: number, jobId: string): Promise<void> {
  await locked(userId, jobId, async (client, job) => {
    const { rows } = await client.query(
      "select status,publish_started_at,storage_cleaned_at,expires_at,retry_count from app.upload_jobs where id=$1",
      [job.id],
    );
    if (!rows[0] || !canRetry(rows[0]))
      throw new UploadError(409, "Unggahan ini tidak dapat dicoba ulang. Mulai unggahan baru.");
    await client.query(
      `update app.upload_jobs set status='uploaded',processing_stage='verifying',error=null,worker_failures=0,
       next_attempt_at=now(),lease_owner=null,lease_until=null,retry_count=retry_count+1,
       terminal_notified_at=null,terminal_message_id=null,animation_attempted_at=null,notify_after=now(),
       dispatched_at=null,dispatch_error=null,expires_at=now()+interval '72 hours',updated_at=now(),version=version+1 where id=$1`,
      [job.id],
    );
  });
  await notifyProcessor(jobId);
}
