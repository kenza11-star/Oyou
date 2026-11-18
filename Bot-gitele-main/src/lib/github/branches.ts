import { github, GithubNotFoundError, UserFacingError } from "./client";
export function validateBranchName(name: string): string {
  if (
    !name ||
    Buffer.byteLength(name, "utf8") > 255 ||
    name === "@" ||
    name.startsWith("-") ||
    name.includes("..") ||
    name.includes("@{") ||
    /[\u0000-\u0020\u007f~^:?*\[\]\\#]/.test(name) ||
    name
      .split("/")
      .some(
        (s) =>
          !s || s.startsWith(".") || s.endsWith(".") || s.endsWith(".lock"),
      )
  )
    throw new UserFacingError(
      "Invalid branch name. Use a real GitHub branch such as main or feature/mobile.",
    );
  return name;
}
export async function getBranch(
  token: string,
  repo: string,
  name: string,
): Promise<string> {
  validateBranchName(name);
  try {
    await github(
      token,
      `/repos/${repo}/git/ref/heads/${name.split("/").map(encodeURIComponent).join("/")}`,
    );
    return name;
  } catch (e) {
    if (e instanceof GithubNotFoundError)
      throw new UserFacingError(
        "That branch does not exist in the selected repository.",
      );
    throw e;
  }
}
export async function listBranches(
  token: string,
  repo: string,
): Promise<string[]> {
  const branches = await github<{ name: string }[]>(
    token,
    `/repos/${repo}/branches?per_page=30`,
  );
  return branches.map((b) => b.name);
}
