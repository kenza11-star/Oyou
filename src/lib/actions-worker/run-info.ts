/** Builds the public run URL from the variables GitHub Actions sets. Returns null unless every part is well formed. */
export function actionsRunInfo(
  env: Record<string, string | undefined> = process.env,
): { id: number; url: string } | null {
  const id = env.GITHUB_RUN_ID;
  const repo = env.GITHUB_REPOSITORY;
  const server = env.GITHUB_SERVER_URL ?? "https://github.com";
  if (!id || !/^\d{1,18}$/.test(id) || !repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return null;
  if (server !== "https://github.com") return null;
  return { id: Number(id), url: `${server}/${repo}/actions/runs/${id}` };
}

export interface BatchOptions {
  /** No new job is claimed after this many ms. A job already running is allowed to finish. */
  claimWindowMs: number;
  /** Exit after this long without any claimable job. */
  idleExitMs: number;
}
export const DEFAULT_BATCH: BatchOptions = { claimWindowMs: 45 * 60_000, idleExitMs: 20_000 };
