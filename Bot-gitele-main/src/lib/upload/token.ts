import { createHmac, timingSafeEqual } from "node:crypto";

export interface UploadClaims {
  jobId: string;
  telegramUserId: number;
  scope?: {
    repoId: number;
    repoFullName: string;
    branch: string;
    sessionVersion?: number;
  };
  /** Only on dashboard tokens: must equal telegram_users.upload_session_version. */
  sessionVersion?: number;
  exp: number; // epoch milliseconds
}

const DEFAULT_TTL_MS = 15 * 60_000;

function signingKey(secret: Buffer): Buffer {
  // Derive a purpose-specific key so this token cannot be confused with other uses of ENCRYPTION_KEY.
  return createHmac("sha256", secret).update("upload-token-v1").digest();
}

function sign(payload: string, secret: Buffer): string {
  return createHmac("sha256", signingKey(secret))
    .update(payload)
    .digest("base64url");
}

export function signUploadToken(
  claims: Omit<UploadClaims, "exp">,
  secret: Buffer,
  now: number = Date.now(),
  ttlMs: number = DEFAULT_TTL_MS,
): string {
  const full: UploadClaims = { ...claims, exp: now + ttlMs };
  const payload = Buffer.from(JSON.stringify(full)).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

/** Returns the claims only when the signature matches and the token has not expired. */
export function verifyUploadToken(
  token: string,
  secret: Buffer,
  now: number = Date.now(),
): UploadClaims | null {
  if (token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;

  const expected = Buffer.from(sign(payload, secret));
  const received = Buffer.from(sig);
  if (
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  )
    return null;

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== "object") return null;
  const c = claims as Partial<UploadClaims>;
  if (
    typeof c.jobId !== "string" ||
    typeof c.telegramUserId !== "number" ||
    typeof c.exp !== "number"
  )
    return null;
  if (
    !Number.isSafeInteger(c.telegramUserId) ||
    c.telegramUserId <= 0 ||
    !Number.isFinite(c.exp) ||
    c.exp <= now
  )
    return null;
  if (
    c.scope !== undefined &&
    (!c.scope ||
      !Number.isSafeInteger(c.scope.repoId) ||
      c.scope.repoId <= 0 ||
      typeof c.scope.repoFullName !== "string" ||
      !c.scope.repoFullName ||
      typeof c.scope.branch !== "string" ||
      !c.scope.branch)
  )
    return null;
  if (
    c.scope?.sessionVersion !== undefined &&
    (!Number.isSafeInteger(c.scope.sessionVersion) ||
      c.scope.sessionVersion < 0)
  )
    return null;
  if (c.sessionVersion !== undefined && (!Number.isSafeInteger(c.sessionVersion) || c.sessionVersion < 0)) return null;
  return {
    jobId: c.jobId,
    telegramUserId: c.telegramUserId,
    exp: c.exp,
    ...(c.sessionVersion !== undefined ? { sessionVersion: c.sessionVersion } : {}),
    ...(c.scope ? { scope: c.scope } : {}),
  };
}

/** Returns true only when the token is valid AND was issued to this Telegram user for this job. */
export function authorizeUploadToken(
  token: string,
  secret: Buffer,
  jobId: string,
  telegramUserId: number,
  now: number = Date.now(),
): boolean {
  const claims = verifyUploadToken(token, secret, now);
  return (
    claims !== null &&
    claims.jobId === jobId &&
    claims.telegramUserId === telegramUserId
  );
}
