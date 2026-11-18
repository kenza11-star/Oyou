import { readCentralDirectory, inflateZipEntry } from "../upload/zip-entries";
import { validateEntryPath } from "./upload";
import { readBounded } from "../http/bounded";
import {
  github,
  githubRaw,
  GithubNotFoundError,
  UserFacingError,
} from "./client";

export const SEND_LIMIT = 50 * 1024 * 1024;
export const ARTIFACT_LIMIT = 100 * 1024 * 1024;

export function runStatusLabel(
  status: string | null,
  conclusion: string | null,
): string {
  if (status !== "completed") {
    if (status === "in_progress") return "In progress";
    if (status === "queued") return "Queued";
    return status ?? "Unknown";
  }
  switch (conclusion) {
    case "success":
      return "Success";
    case "failure":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "skipped":
      return "Skipped";
    case null:
      return "Unknown";
    default:
      return conclusion;
  }
}

interface RawRun {
  name: string | null;
  run_number: number;
  head_branch: string | null;
  head_sha: string;
  status: string | null;
  conclusion: string | null;
  html_url: string;
}

export interface RunSummary {
  name: string;
  runNumber: number;
  branch: string;
  sha: string;
  label: string;
  url: string;
}

export async function listRuns(
  token: string,
  fullName: string,
): Promise<RunSummary[]> {
  const data = await github<{ workflow_runs: RawRun[] }>(
    token,
    `/repos/${fullName}/actions/runs?per_page=5`,
  );
  return data.workflow_runs.map((r) => ({
    name: r.name ?? "Workflow",
    runNumber: r.run_number,
    branch: r.head_branch ?? "",
    sha: r.head_sha.slice(0, 7),
    label: runStatusLabel(r.status, r.conclusion),
    url: r.html_url,
  }));
}

export interface RawArtifact {
  id: number;
  name: string;
  size_in_bytes: number;
  expired: boolean;
  archive_download_url: string;
}

/** GitHub lists artifacts newest first. Expired ones are skipped. */
export async function findNewestArtifact(
  token: string,
  fullName: string,
): Promise<RawArtifact | null> {
  for (let page = 1; page <= 10; page++) {
    const data = await github<{ artifacts: RawArtifact[] }>(
      token,
      `/repos/${fullName}/actions/artifacts?per_page=100&page=${page}`,
    );
    const found = data.artifacts.find(
      (a) =>
        !a.expired && a.size_in_bytes > 0 && a.size_in_bytes <= ARTIFACT_LIMIT,
    );
    if (found) return found;
    if (data.artifacts.length < 100) break;
  }
  return null;
}

export async function findLatestApkAsset(
  token: string,
  fullName: string,
): Promise<{ name: string; size: number; url: string } | null> {
  let release: { assets: { name: string; size: number; url: string }[] };
  try {
    release = await github(token, `/repos/${fullName}/releases/latest`);
  } catch (err) {
    if (err instanceof GithubNotFoundError) return null;
    throw err;
  }
  return (
    release.assets.find((a) => a.name.toLowerCase().endsWith(".apk")) ?? null
  );
}

/**
 * Downloads a GitHub asset. GitHub answers with a redirect to a pre-signed URL. That URL is fetched
 * WITHOUT the Authorization header so the token is never sent to the storage host.
 */
export async function downloadBinary(
  token: string,
  url: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const first = await githubRaw(token, url, {
    headers: { accept: "application/octet-stream" },
  });
  let res: Response = first;
  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get("location");
    if (!location)
      throw new UserFacingError(
        "GitHub returned a redirect without a location.",
      );
    const redirect = new URL(location);
    const allowed =
      redirect.hostname === "github.com" ||
      redirect.hostname.endsWith(".githubusercontent.com") ||
      redirect.hostname.endsWith(".blob.core.windows.net");
    if (
      redirect.protocol !== "https:" ||
      redirect.username ||
      redirect.password ||
      !allowed
    )
      throw new UserFacingError("GitHub returned an unsafe download redirect.");
    res = await fetch(redirect, {
      redirect: "error",
      signal: AbortSignal.timeout(25_000),
    });
  }
  if (!res.ok)
    throw new UserFacingError(`Download failed with status ${res.status}`);
  try {
    return await readBounded(res, maxBytes);
  } catch (err) {
    throw new UserFacingError(
      err instanceof Error ? err.message : "Download failed.",
    );
  }
}

/** Returns the first .apk inside a ZIP (artifacts are ZIP files). Other entries are not inflated. */
export function extractApk(
  zip: Uint8Array,
): { name: string; data: Uint8Array } | null {
  if (zip.length > ARTIFACT_LIMIT)
    throw new UserFacingError("Artifact exceeds the supported size.");
  const entries = readCentralDirectory(zip);
  const candidates = entries.filter(
    (e) => !e.isDirectory && e.name.toLowerCase().endsWith(".apk"),
  );
  const entry = candidates.find((e) => !e.isSymlink && e.size <= SEND_LIMIT);
  if (!entry) {
    if (candidates.length)
      throw new UserFacingError(
        "APK is too large or is not a regular file. The Telegram send limit is 50 MiB.",
      );
    return null;
  }
  if (!validateEntryPath(entry.name).ok)
    throw new UserFacingError("Unsafe APK archive path");
  return {
    name: entry.name.split("/").pop() ?? "app.apk",
    data: inflateZipEntry(zip, entry, SEND_LIMIT),
  };
}
