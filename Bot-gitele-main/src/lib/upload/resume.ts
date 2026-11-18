export interface ResumeScope {
  telegramUserId: number;
  repoId: number;
  repoFullName: string;
  branch: string;
}
/** Identity is server-authenticated scope plus the full SHA-256 of local file bytes. */
export function resumeStorageKey(
  scope: ResumeScope,
  file: { name: string; size: number; lastModified: number },
  sha256: string,
): string {
  return `gm-upload:v2:${JSON.stringify([scope.telegramUserId, scope.repoId, scope.repoFullName, scope.branch, file.name, file.size, sha256])}`;
}
