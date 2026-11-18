import { createHash } from "node:crypto";
import {
  github,
  githubRaw,
  GithubNotFoundError,
  UserFacingError,
} from "./client";
import { UPLOAD_LIMITS } from "../upload/limits";
import { readCentralDirectory, inflateZipEntry } from "../upload/zip-entries";

export const WORKFLOW_PERMISSION_HINT =
  "GitHub rejected a change under .github/workflows. The GitHub App needs 'Workflows: Read and write' permission, and the installation owner must accept the updated permissions.";

export type PathCheck =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/** Rejects absolute paths, traversal, backslashes, NUL bytes, empty segments, and .git entries. */
export function validateEntryPath(name: string): PathCheck {
  if (name.length === 0 || name.length > 500)
    return { ok: false, reason: "invalid path length" };
  if (/[\\\u0000]/.test(name))
    return { ok: false, reason: "invalid characters" };
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name))
    return { ok: false, reason: "absolute path" };
  const segments = name.split("/");
  if (segments.some((s) => s === "" || s === "." || s === ".."))
    return { ok: false, reason: "unsafe path segment" };
  if (
    segments.some((s) => /^\.git(?:[. :]|$)/i.test(s) || /^git~[1-9]$/i.test(s))
  )
    return { ok: false, reason: ".git entries are not allowed" };
  return { ok: true, path: segments.join("/") };
}

export interface UploadFile {
  path: string;
  data: Uint8Array;
  mode?: "100644" | "100755";
}

/**
 * Extracts a ZIP with all safety checks. Limits and paths are checked from headers before any file is
 * inflated. Nothing is skipped silently: any violation rejects the whole archive.
 */
export function extractZip(
  archive: Uint8Array,
  maxArchiveBytes: number = UPLOAD_LIMITS.telegramArchiveBytes,
): UploadFile[] {
  if (archive.length > maxArchiveBytes) {
    throw new UserFacingError(
      `ZIP is larger than the allowed ${(maxArchiveBytes / 1024 / 1024).toFixed(1)} MB.`,
    );
  }
  const entries = readCentralDirectory(archive);
  let total = 0,
    count = 0;
  const files = new Set<string>(),
    directories = new Set<string>();
  for (const entry of entries) {
    const path = entry.isDirectory ? entry.name.slice(0, -1) : entry.name;
    const check = validateEntryPath(path);
    if (!check.ok)
      throw new UserFacingError(
        `Unsafe ZIP entry rejected (${check.reason}): ${entry.name.slice(0, 80)}`,
      );
    if (entry.isSymlink)
      throw new UserFacingError("Symbolic links are not supported: " + path);
    if (entry.isDirectory) {
      directories.add(path);
      continue;
    }
    if (entry.size > UPLOAD_LIMITS.fileBytes)
      throw new UserFacingError(
        "A file is larger than the GitHub limit: " + path,
      );
    if (
      entry.size > 0 &&
      (entry.compressedSize === 0 ||
        entry.size / entry.compressedSize > UPLOAD_LIMITS.maxRatio)
    )
      throw new UserFacingError(
        "ZIP compression ratio is too high; the archive was rejected.",
      );
    count++;
    total += entry.size;
    files.add(path);
    if (count > UPLOAD_LIMITS.files)
      throw new UserFacingError(
        `ZIP contains more than ${UPLOAD_LIMITS.files} files.`,
      );
    if (total > UPLOAD_LIMITS.totalBytes)
      throw new UserFacingError("ZIP expands beyond the allowed size.");
  }
  if (!count) throw new UserFacingError("The ZIP contains no files.");
  for (const name of [...files, ...directories]) {
    if (files.has(name) && directories.has(name))
      throw new UserFacingError("ZIP file/directory conflict: " + name);
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++)
      if (files.has(parts.slice(0, i).join("/")))
        throw new UserFacingError("ZIP file/directory conflict: " + name);
  }
  return entries
    .filter((e) => !e.isDirectory)
    .map((entry) => {
      const data = inflateZipEntry(archive, entry, UPLOAD_LIMITS.fileBytes);
      return {
        path: entry.name,
        data,
        ...(entry.mode ? { mode: entry.mode } : {}),
      };
    });
}

/** Git's blob hash: sha1("blob <size>\0" + content). */
export function gitBlobSha(content: Uint8Array): string {
  const h = createHash("sha1");
  h.update(`blob ${content.length}\0`);
  h.update(content);
  return h.digest("hex");
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const idx = next++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

export interface CommitOutcome {
  commitSha: string | null;
  commitUrl: string | null;
  added: number;
  updated: number;
  unchanged: number;
}

export interface CommitOptions {
  blobConcurrency?: number;
  onBlobsUploaded?: (done: number, total: number) => void;
}

/**
 * Update-only commit: blobs for changed files, one tree, one commit, one ref update.
 * Files missing from the ZIP are kept. The ref update is not forced, so a concurrent change fails
 * instead of being overwritten. The result is returned only after GitHub accepts the ref update.
 */
export async function commitFiles(
  token: string,
  fullName: string,
  branch: string,
  files: UploadFile[],
  message: string,
  options: CommitOptions = {},
): Promise<CommitOutcome> {
  const refPath = `/repos/${fullName}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`;
  const readRefPath = refPath.replace("/git/refs/", "/git/ref/");
  const ref = await github<{ object: { sha: string } }>(token, readRefPath);
  const head = ref.object.sha;

  const headCommit = await github<{ tree: { sha: string } }>(
    token,
    `/repos/${fullName}/git/commits/${head}`,
  );
  const tree = await github<{
    truncated: boolean;
    tree: { path: string; type: string; sha: string }[];
  }>(token, `/repos/${fullName}/git/trees/${headCommit.tree.sha}?recursive=1`);
  if (tree.truncated)
    throw new UserFacingError(
      "This repository is too large for ZIP upload in this version.",
    );

  const current = new Map(
    tree.tree.filter((e) => e.type === "blob").map((e) => [e.path, e.sha]),
  );
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  const changed: UploadFile[] = [];
  for (const f of files) {
    const sha = gitBlobSha(f.data);
    const prev = current.get(f.path);
    if (prev === sha) {
      unchanged += 1;
      continue;
    }
    if (prev) updated += 1;
    else added += 1;
    changed.push(f);
  }
  if (changed.length === 0) {
    return { commitSha: null, commitUrl: null, added, updated, unchanged };
  }

  let blobsDone = 0;
  const entries = await mapLimit(
    changed,
    options.blobConcurrency ?? 8,
    async (f) => {
      const blob = await github<{ sha: string }>(
        token,
        `/repos/${fullName}/git/blobs`,
        {
          method: "POST",
          body: JSON.stringify({
            content: Buffer.from(f.data).toString("base64"),
            encoding: "base64",
          }),
        },
      );
      blobsDone += 1;
      options.onBlobsUploaded?.(blobsDone, changed.length);
      return { path: f.path, mode: "100644", type: "blob", sha: blob.sha };
    },
  );

  const touchesWorkflows = changed.some((f) =>
    f.path.startsWith(".github/workflows/"),
  );
  let commit: { sha: string; html_url: string };
  try {
    const newTree = await github<{ sha: string }>(
      token,
      `/repos/${fullName}/git/trees`,
      {
        method: "POST",
        body: JSON.stringify({ base_tree: headCommit.tree.sha, tree: entries }),
      },
    );
    commit = await github<{ sha: string; html_url: string }>(
      token,
      `/repos/${fullName}/git/commits`,
      {
        method: "POST",
        body: JSON.stringify({ message, tree: newTree.sha, parents: [head] }),
      },
    );
  } catch (err) {
    if (
      touchesWorkflows &&
      (err instanceof UserFacingError || err instanceof GithubNotFoundError)
    ) {
      throw new UserFacingError(WORKFLOW_PERMISSION_HINT);
    }
    throw err;
  }

  try {
    await githubRaw(token, refPath, {
      method: "PATCH",
      body: JSON.stringify({ sha: commit.sha, force: false }),
    });
  } catch (err) {
    if (err instanceof UserFacingError) {
      throw new UserFacingError(
        "The branch changed during the upload or does not accept direct pushes. Nothing was overwritten; run the upload again.",
      );
    }
    throw err;
  }

  const confirmed = await github<{ object: { sha: string } }>(
    token,
    readRefPath,
  );
  if (confirmed.object.sha !== commit.sha) {
    const included = await github<{ status: string }>(
      token,
      `/repos/${fullName}/compare/${commit.sha}...${confirmed.object.sha}`,
    );
    if (!["ahead", "identical"].includes(included.status))
      throw new UserFacingError(
        "The created commit could not be confirmed on the branch. Inspect GitHub before retrying.",
      );
  }
  return {
    commitSha: commit.sha,
    commitUrl: commit.html_url,
    added,
    updated,
    unchanged,
  };
}
