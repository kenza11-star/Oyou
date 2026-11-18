import { signUploadToken, verifyUploadToken } from "./token";

export const SESSION_TTL_MS = 30 * 60_000;
export interface UploadScope {
  repoId: number;
  repoFullName: string;
  branch: string;
  sessionVersion?: number;
}
const SESSION_JOB = "session";

/** Short-lived token the bot puts in the Upload link. It identifies the Telegram user only. */
export function mintSessionToken(
  telegramUserId: number,
  secret: Buffer,
  now: number = Date.now(),
  scope?: UploadScope,
): string {
  return signUploadToken(
    { jobId: SESSION_JOB, telegramUserId, ...(scope ? { scope } : {}) },
    secret,
    now,
    SESSION_TTL_MS,
  );
}

/** Returns the Telegram user for a valid session token, or null. Job tokens are rejected here. */
export function userFromBearer(
  header: string | null,
  secret: Buffer,
  now: number = Date.now(),
): number | null {
  if (!header || !header.startsWith("Bearer ")) return null;
  const claims = verifyUploadToken(header.slice(7), secret, now);
  if (!claims || claims.jobId !== SESSION_JOB) return null;
  return claims.telegramUserId;
}

/** Browser APIs require scoped links; pre-2.5 links must be renewed privately. */
export function scopeFromBearer(
  header: string | null,
  secret: Buffer,
  now = Date.now(),
): (UploadScope & { telegramUserId: number }) | null {
  if (!header?.startsWith("Bearer ")) return null;
  const claims = verifyUploadToken(header.slice(7), secret, now);
  if (!claims || claims.jobId !== SESSION_JOB || !claims.scope) return null;
  return { ...claims.scope, telegramUserId: claims.telegramUserId };
}
