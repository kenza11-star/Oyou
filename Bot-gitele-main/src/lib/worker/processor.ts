import { createHash } from "node:crypto";
import { db } from "../db";
import { loadEnv } from "../env";
import { getUsableToken } from "../github/credentials";
import { assertRepoAccessible } from "../github/repos";
import {
  extractZip,
  gitBlobSha,
  WORKFLOW_PERMISSION_HINT,
  type UploadFile,
} from "../github/upload";
import {
  GithubAuthError,
  GithubNotFoundError,
  GithubHttpError,
  GithubRateLimitError,
  UserFacingError,
} from "../github/client";
import {
  storageConfig,
  downloadObject,
  chunkObjectPath,
} from "../supabase/storage";
import { UPLOAD_LIMITS } from "../upload/limits";
import { planChunks } from "../upload/chunks";
import { runPool, HttpError, withRetry } from "../transfer/engine";
import {
  Lease,
  LostLease,
  Cancelled,
  Deferred,
  initializeFiles,
  acknowledgeBlob,
  finishJob,
  releaseJob,
  retryDelayMs,
  blockGithub,
  reserveMutation,
  type FileRecord,
  type WorkerJob,
} from "./state";
import {
  WorkerGithub,
  repositoryTree,
  ByteGate,
  type TreeEntry,
} from "./github";

export async function reconstructArchive(lease: Lease): Promise<Uint8Array> {
  const job = lease.job,
    total = Number(job.total_bytes);
  if (
    !Number.isSafeInteger(total) ||
    total <= 0 ||
    total > UPLOAD_LIMITS.webArchiveBytes
  )
    throw new UserFacingError("ZIP exceeds the 100 MiB limit");
  const expected = planChunks(total, job.chunk_size);
  const { rows } = await db().query<{
    chunk_index: number;
    size: string;
    status: string;
    sha256: string;
    object_path: string | null;
  }>(
    "select chunk_index,size,status,sha256,object_path from app.upload_job_chunks where job_id=$1 order by chunk_index",
    [job.id],
  );
  if (rows.length !== expected.length || job.chunk_count !== expected.length)
    throw new UserFacingError("Missing ZIP chunks");
  const archive = new Uint8Array(total),
    hash = createHash("sha256");
  let offset = 0;
  for (let i = 0; i < expected.length; i++) {
    await lease.check();
    const chunk = rows[i];
    if (
      chunk.chunk_index !== i ||
      Number(chunk.size) !== expected[i].size ||
      chunk.status !== "verified" ||
      !/^[0-9a-f]{64}$/.test(chunk.sha256 ?? "")
    )
      throw new UserFacingError("Missing, unordered or unverified ZIP chunk");
    const path = chunk.object_path ?? chunkObjectPath(job.id, i);
    if (!path.startsWith(`jobs/${job.id}/`))
      throw new UserFacingError("Invalid chunk ownership");
    let data: Uint8Array;
    try {
      data = await withRetry(
        () => downloadObject(storageConfig(), path, expected[i].size),
        { attempts: 4, baseMs: 500, maxMs: 5000, signal: lease.signal },
      );
    } catch (err) {
      if (err instanceof HttpError && [400, 404].includes(err.status))
        throw new UserFacingError(
          "A verified ZIP chunk is missing from private storage",
        );
      throw err;
    }
    if (
      data.length !== expected[i].size ||
      createHash("sha256").update(data).digest("hex") !== chunk.sha256
    )
      throw new UserFacingError("Stored ZIP chunk checksum mismatch");
    archive.set(data, offset);
    offset += data.length;
    hash.update(data);
  }
  if (offset !== total || hash.digest("hex") !== job.file_sha256)
    throw new UserFacingError("Complete ZIP checksum mismatch");
  return archive;
}
function repoPath(fullName: string): string {
  return fullName.split("/").map(encodeURIComponent).join("/");
}
export function compareFiles(
  files: UploadFile[],
  tree: TreeEntry[],
): FileRecord[] {
  const current = new Map(tree.map((e) => [e.path, e]));
  const remoteBlobs = new Set(
    tree.filter((e) => e.type === "blob").map((e) => e.sha),
  );
  return files.map((f) => {
    const old = current.get(f.path);
    if (
      old &&
      (old.type !== "blob" || !["100644", "100755"].includes(old.mode))
    )
      throw new UserFacingError(
        "Archive path conflicts with a repository directory, symlink or submodule: " +
          f.path,
      );
    const parts = f.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = current.get(parts.slice(0, i).join("/"));
      if (parent && parent.type !== "tree")
        throw new UserFacingError(
          "Archive path conflicts with a repository file or submodule: " +
            f.path,
        );
    }
    const sha = gitBlobSha(f.data),
      mode = f.mode ?? (old?.mode === "100755" ? "100755" : "100644");
    const kind = !old
      ? "added"
      : old.sha === sha && old.mode === mode
        ? "unchanged"
        : "updated";
    return {
      path: f.path,
      blob_sha: sha,
      size: f.data.length,
      mode,
      kind,
      blob_uploaded: kind === "unchanged" || remoteBlobs.has(sha),
    };
  });
}
async function authorize(job: WorkerJob): Promise<string> {
  const cred = await getUsableToken(Number(job.telegram_user_id), loadEnv());
  if (!cred)
    throw new GithubAuthError(
      "Connect your own GitHub account again using /login.",
    );
  const repo = await assertRepoAccessible(cred.token, Number(job.repo_id));
  if (repo.fullName !== job.repo_full_name)
    throw new UserFacingError(
      "Repository was renamed or moved. Select it again and start a new upload.",
    );
  return cred.token;
}
async function publishAndConfirm(api: WorkerGithub): Promise<void> {
  const lease = api.lease,
    job = lease.job,
    repo = repoPath(job.repo_full_name);
  api.token = await authorize(job); // Check the current user's access again immediately before publishing.
  const readRef = `/repos/${repo}/git/ref/heads/${job.branch.split("/").map(encodeURIComponent).join("/")}`;
  const writeRef = readRef.replace("/git/ref/", "/git/refs/");
  const getHead = async () => {
    const ref = await api.call<{ object: { sha: string } }>("GET", readRef);
    return ref.object.sha;
  };
  let head = await getHead();
  if (!job.commit_sha) {
    if (head !== job.base_head_sha)
      throw new UserFacingError(
        "The selected branch changed while comparing. No changes were committed. Upload again.",
      );
    await finishJob(lease, head);
    return;
  }
  const includesCommit = async (current: string) => {
    if (current === job.commit_sha) return true;
    if (current === job.base_head_sha) return false;
    const result = await api.call<{ status: string }>(
      "GET",
      `/repos/${repo}/compare/${job.commit_sha}...${current}`,
    );
    return result.status === "ahead" || result.status === "identical";
  };
  if (await includesCommit(head)) {
    await finishJob(lease, head);
    return;
  }
  if (head !== job.base_head_sha)
    throw new UserFacingError(
      "Branch conflict: the branch moved. No force push was attempted. Start a fresh upload.",
    );
  const wait = await reserveMutation(Number(job.telegram_user_id));
  if (wait > 0) throw new Deferred(Math.ceil(wait) + 1000);
  await lease.save({
    processing_stage: "updating_branch",
    publish_started_at: job.publish_started_at ?? new Date(),
  });
  // After this durable boundary, cancellation is rejected: the remote request may already succeed.
  try {
    await api.call(
      "PATCH",
      writeRef,
      { sha: job.commit_sha, force: false },
      true,
    );
  } catch (err) {
    if (err instanceof LostLease || lease.signal.aborted) throw err;
    // An ambiguous response can still mean the update succeeded. Always reconcile before failing.
    head = await getHead();
    if (await includesCommit(head)) {
      await finishJob(lease, head);
      return;
    }
    if (err instanceof GithubHttpError && [409, 422].includes(err.status))
      throw new UserFacingError(
        "Branch conflict or branch protection rejected the update. Nothing was force-pushed.",
      );
    throw err;
  }
  head = await getHead();
  if (!(await includesCommit(head)))
    throw new UserFacingError(
      "GitHub branch confirmation did not include the created commit. Result is unconfirmed; inspect the branch.",
    );
  const commit = await api.call<{
    sha: string;
    tree: { sha: string };
    parents: { sha: string }[];
  }>("GET", `/repos/${repo}/git/commits/${job.commit_sha}`);
  if (
    commit.sha !== job.commit_sha ||
    commit.tree.sha !== job.target_tree_sha ||
    !commit.parents.some((p) => p.sha === job.base_head_sha)
  )
    throw new UserFacingError("GitHub commit confirmation mismatch");
  await finishJob(lease, head);
}
export async function processClaimedJob(
  job: WorkerJob,
  signal?: AbortSignal,
): Promise<void> {
  const lease = new Lease(job);
  const onAbort = () => lease.abort.abort();
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  lease.startHeartbeat();
  try {
    if (new Date(job.expires_at).getTime() <= Date.now())
      throw new UserFacingError(
        "Upload expired before processing could finish.",
      );
    const api = new WorkerGithub(await authorize(job), lease),
      repo = repoPath(job.repo_full_name);
    if (!job.commit_sha && !job.target_tree_sha) {
      await lease.save({ processing_stage: "verifying", error: null });
      let archive: Uint8Array | null = await reconstructArchive(lease);
      await lease.save({ processing_stage: "extracting" });
      const files = extractZip(archive, UPLOAD_LIMITS.webArchiveBytes);
      archive = null;
      await lease.save({
        processing_stage: "validating",
        files_extracted: files.length,
      });
      await lease.check();
      if (!job.base_head_sha) {
        const ref = await api.call<{ object: { sha: string } }>(
          "GET",
          `/repos/${repo}/git/ref/heads/${job.branch.split("/").map(encodeURIComponent).join("/")}`,
        );
        const parent = await api.call<{ tree: { sha: string } }>(
          "GET",
          `/repos/${repo}/git/commits/${ref.object.sha}`,
        );
        const user = await api.call<{
          id: number;
          login: string;
          name: string | null;
        }>("GET", "/user");
        await lease.save({
          base_head_sha: ref.object.sha,
          base_tree_sha: parent.tree.sha,
          commit_timestamp: new Date(),
          commit_author: {
            name: user.name || user.login,
            email: `${user.id}+${user.login}@users.noreply.github.com`,
          },
        });
      }
      await lease.save({ processing_stage: "comparing" });
      const tree = await repositoryTree(api, repo, job.base_tree_sha!);
      await initializeFiles(lease, compareFiles(files, tree));
      const { rows: manifest } = await db().query<FileRecord>(
        "select path,blob_sha,size,mode,kind,blob_uploaded from app.upload_job_files where job_id=$1 order by path",
        [job.id],
      );
      const changed = manifest.filter((f) => f.kind !== "unchanged");
      if (!changed.length) {
        await publishAndConfirm(api);
        return;
      }
      await lease.save({ processing_stage: "uploading_blobs" });
      const byPath = new Map(files.map((f) => [f.path, f.data]));
      const groups = [
        ...new Map(
          changed.filter((f) => !f.blob_uploaded).map((f) => [f.blob_sha, f]),
        ).values(),
      ];
      const gate = new ByteGate();
      await runPool(
        groups,
        api.concurrency,
        async (file) => {
          await lease.check();
          const data = byPath.get(file.path)!;
          if (!data || gitBlobSha(data) !== file.blob_sha)
            throw new UserFacingError("File checkpoint checksum mismatch");
          const release = await gate.acquire(data.length, lease.signal);
          try {
            const blob = await api.call<{ sha: string }>(
              "POST",
              `/repos/${repo}/git/blobs`,
              {
                content: Buffer.from(data).toString("base64"),
                encoding: "base64",
              },
            );
            if (blob.sha !== file.blob_sha)
              throw new UserFacingError("GitHub blob checksum mismatch");
            await acknowledgeBlob(lease, file.blob_sha, data.length);
          } finally {
            release();
          }
        },
        lease.signal,
      );
      await lease.save({ processing_stage: "creating_commit" });
      const newTree = await api.call<{ sha: string }>(
        "POST",
        `/repos/${repo}/git/trees`,
        {
          base_tree: job.base_tree_sha,
          tree: changed.map((f) => ({
            path: f.path,
            mode: f.mode,
            type: "blob",
            sha: f.blob_sha,
          })),
        },
      );
      await lease.save({ target_tree_sha: newTree.sha });
    }
    if (!job.commit_sha) {
      await lease.save({ processing_stage: "creating_commit" });
      const date = new Date(job.commit_timestamp!).toISOString(),
        identity = { ...job.commit_author!, date };
      const commit = await api.call<{ sha: string }>(
        "POST",
        `/repos/${repo}/git/commits`,
        {
          message: `Update project via GitHub Manager Bot\n\nUpload-Job: ${job.id}`,
          tree: job.target_tree_sha,
          parents: [job.base_head_sha],
          author: identity,
          committer: identity,
        },
      );
      await lease.save({
        commit_sha: commit.sha,
        commit_url: `https://github.com/${repo}/commit/${commit.sha}`,
      });
    }
    await publishAndConfirm(api);
  } catch (err) {
    if (
      lease.signal.aborted ||
      err instanceof LostLease ||
      err instanceof Cancelled
    )
      return;
    if (err instanceof GithubRateLimitError) {
      await blockGithub(Number(job.telegram_user_id), err.retryAfterMs);
      await releaseJob(
        lease,
        "Waiting for GitHub rate limit",
        err.retryAfterMs,
        false,
      );
      return;
    }
    if (err instanceof Deferred) {
      await releaseJob(lease, err.message, err.delayMs, false);
      return;
    }
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? String(err.code)
        : "";
    const transient =
      err instanceof TypeError ||
      err instanceof HttpError ||
      err instanceof GithubRateLimitError ||
      (err instanceof Error &&
        ["TimeoutError", "AbortError"].includes(err.name)) ||
      /^(08|40P01|40001|53300|57P0)/.test(code);
    const terminal = !transient || job.worker_failures >= 7;
    let reason =
      err instanceof GithubAuthError
        ? "GitHub authentication expired or was disconnected. Send /login and retry."
        : err instanceof GithubNotFoundError
          ? "Repository or branch is unavailable through your own GitHub App. Check /repos; initialize an empty repository before uploading."
          : err instanceof UserFacingError
            ? err.message
            : transient
              ? terminal
                ? "Temporary network/API failure. Automatic retries exhausted; start a fresh upload."
                : "Temporary network/API failure. Processing will retry."
              : "Processing failed unexpectedly. Check worker logs using this job ID.";
    if (err instanceof GithubHttpError && [403, 404].includes(err.status)) {
      const workflows = await db().query(
        "select 1 from app.upload_job_files where job_id=$1 and path like '.github/workflows/%' and kind<>'unchanged' limit 1",
        [job.id],
      );
      if (workflows.rows.length) reason = WORKFLOW_PERMISSION_HINT;
    }
    if (job.publish_started_at && terminal)
      reason +=
        " Publication outcome may be uncertain; inspect the repository before retrying.";
    console.error(
      "worker job",
      job.id,
      err instanceof Error ? err.name : "unknown",
    );
    await releaseJob(
      lease,
      reason,
      transient
        ? retryDelayMs(
            job.worker_failures + 1,
            err instanceof GithubRateLimitError ? err.retryAfterMs : 0,
          )
        : 0,
      terminal,
    );
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await lease.close();
  }
}
