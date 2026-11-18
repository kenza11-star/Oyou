import { github, GithubNotFoundError } from "./client";

export interface RepoSummary {
  id: number;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

interface RawRepo {
  id: number;
  full_name: string;
  default_branch: string;
  private: boolean;
}

const toRepo = (r: RawRepo): RepoSummary => ({
  id: r.id,
  fullName: r.full_name,
  defaultBranch: r.default_branch,
  private: r.private,
});

/**
 * Repositories this user can reach through GitHub App installations they have access to.
 * Public-user rule: only installations returned for this token are considered.
 */
export async function listAccessibleRepos(
  token: string,
): Promise<RepoSummary[]> {
  const seen = new Map<number, RepoSummary>();
  for (let page = 1; ; page++) {
    const { installations } = await github<{ installations: { id: number }[] }>(
      token,
      `/user/installations?per_page=100&page=${page}`,
    );
    for (const inst of installations)
      for (let rp = 1; ; rp++) {
        const result = await github<{ repositories: RawRepo[] }>(
          token,
          `/user/installations/${inst.id}/repositories?per_page=100&page=${rp}`,
        );
        for (const r of result.repositories) seen.set(r.id, toRepo(r));
        if (result.repositories.length < 100) break;
      }
    if (installations.length < 100) break;
  }
  return [...seen.values()].sort((a, b) =>
    a.fullName.localeCompare(b.fullName),
  );
}

/** Every repository operation calls this first. Anything outside the user's installations is treated as not found. */
export async function assertRepoAccessible(
  token: string,
  repoId: number,
): Promise<RepoSummary> {
  const repos = await listAccessibleRepos(token);
  const found = repos.find((r) => r.id === repoId);
  if (!found) throw new GithubNotFoundError("Repository is not accessible");
  return found;
}
