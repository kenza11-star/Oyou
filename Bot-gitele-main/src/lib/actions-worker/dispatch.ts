/**
 * Triggers the trusted processor workflow in OUR repository (never a user's repository).
 * The dispatch carries no inputs: the runner claims work from the database, so no job ID,
 * token or user data appears in workflow inputs, URLs or logs.
 */
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9_./-]{1,100}$/;
export const WORKFLOW_FILE = "process-uploads.yml";

export interface DispatchConfig {
  token: string;
  repo: string;
  ref: string;
}

export function dispatchConfig(
  source: Record<string, string | undefined> = process.env,
): DispatchConfig | null {
  const token = source.ACTIONS_DISPATCH_TOKEN?.trim();
  if (!token) return null;
  const repo = source.WORKER_REPO?.trim() || "kenza11-star/Bot-gitele";
  const ref = source.WORKER_REF?.trim() || "main";
  if (!REPO_RE.test(repo) || !REF_RE.test(ref) || ref.includes("..")) return null;
  return { token, repo, ref };
}
export const dispatchConfigured = (
  source: Record<string, string | undefined> = process.env,
) => dispatchConfig(source) !== null;

export type DispatchResult =
  | { ok: true }
  | { ok: false; reason: "not_configured" | "rejected" | "network"; status?: number };

/** One short call. Failure is never fatal: the job is already durable and the scheduled sweep recovers it. */
export async function dispatchProcessor(
  source: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch,
): Promise<DispatchResult> {
  const cfg = dispatchConfig(source);
  if (!cfg) return { ok: false, reason: "not_configured" };
  try {
    const res = await fetcher(
      `https://api.github.com/repos/${cfg.repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${cfg.token}`,
          "x-github-api-version": "2022-11-28",
          "content-type": "application/json",
          "user-agent": "github-manager-bot",
        },
        body: JSON.stringify({ ref: cfg.ref }),
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
      },
    );
    return res.status === 204 ? { ok: true } : { ok: false, reason: "rejected", status: res.status };
  } catch {
    return { ok: false, reason: "network" };
  }
}
