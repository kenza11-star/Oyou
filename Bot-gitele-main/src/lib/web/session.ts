import { signUploadToken, verifyUploadToken } from "../upload/token";

/** Dashboard session. Distinct from upload sessions (jobId "session"), so neither works on the other's routes. */
export const WEB_TTL_MS = 8 * 60 * 60_000;
const WEB_JOB = "web";

export function mintWebToken(telegramUserId: number, secret: Buffer, sessionVersion: number, now = Date.now()): string {
  return signUploadToken({ jobId: WEB_JOB, telegramUserId, sessionVersion }, secret, now, WEB_TTL_MS);
}

export function webClaimsFromBearer(
  header: string | null,
  secret: Buffer,
  now = Date.now(),
): { telegramUserId: number; sessionVersion: number } | null {
  if (!header?.startsWith("Bearer ")) return null;
  const c = verifyUploadToken(header.slice(7), secret, now);
  if (!c || c.jobId !== WEB_JOB || c.sessionVersion === undefined || c.scope) return null;
  return { telegramUserId: c.telegramUserId, sessionVersion: c.sessionVersion };
}
