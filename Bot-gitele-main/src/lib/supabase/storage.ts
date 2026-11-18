import { HttpError } from "../transfer/engine";

export interface StorageConfig {
  url: string;
  secretKey: string;
  bucket: string;
}

/** Reads SUPABASE_URL, SUPABASE_SECRET_KEY, and SUPABASE_STORAGE_BUCKET (the deployed names). */
export function storageConfig(
  source: Record<string, string | undefined> = process.env,
): StorageConfig {
  const url = source.SUPABASE_URL?.trim().replace(/\/+$/, "");
  const secretKey = source.SUPABASE_SECRET_KEY?.trim();
  const bucket = source.SUPABASE_STORAGE_BUCKET?.trim();
  const missing = [
    !url && "SUPABASE_URL",
    !secretKey && "SUPABASE_SECRET_KEY",
    !bucket && "SUPABASE_STORAGE_BUCKET",
  ].filter(Boolean);
  if (missing.length > 0)
    throw new Error(
      `Missing Supabase Storage variables: ${missing.join(", ")}`,
    );
  return { url: url!, secretKey: secretKey!, bucket: bucket! };
}

/**
 * Headers for server-side Storage calls.
 * - "sb_secret_..." keys are opaque, not JWTs. They are sent in the apikey header only.
 * - Legacy service_role keys are JWTs. They are also sent as a Bearer token.
 * Opaque secret keys belong in apikey; only legacy JWT keys belong in Authorization.
 */
export function authHeadersFor(secretKey: string): Record<string, string> {
  const headers: Record<string, string> = { apikey: secretKey };
  if (!secretKey.startsWith("sb_secret_"))
    headers.authorization = `Bearer ${secretKey}`;
  return headers;
}

/** Object paths use only server-generated IDs and indexes. No user text reaches a path. */
export function chunkObjectPath(jobId: string, index: number): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      jobId,
    )
  ) {
    throw new Error("invalid job id");
  }
  if (!Number.isSafeInteger(index) || index < 0)
    throw new Error("invalid chunk index");
  return `jobs/${jobId}/chunk-${String(index).padStart(5, "0")}.bin`;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** Keep provider diagnostics and signed tokens out of public errors. */
async function storageFailure(res: Response): Promise<never> {
  const detail = (await res.json().catch(() => null)) as {
    statusCode?: string | number;
  } | null;
  const code = Number(detail?.statusCode);
  const hint = res.headers.get("retry-after");
  const seconds = hint ? Number(hint) : NaN;
  const date = hint ? Date.parse(hint) : NaN;
  const retryAfter = Number.isFinite(seconds)
    ? Math.max(0, seconds * 1000)
    : Number.isFinite(date)
      ? Math.max(0, date - Date.now())
      : null;
  throw new HttpError(
    Number.isInteger(code) && code >= 400 && code < 600 ? code : res.status,
    retryAfter,
  );
}

/**
 * Creates a signed upload URL for one object in the private bucket. The browser PUTs to that URL,
 * so the secret key never reaches the client.
 * Non-upsert tokens keep successful objects immutable, including during retries.
 */
export async function createSignedUploadUrl(
  cfg: StorageConfig,
  path: string,
): Promise<string> {
  const res = await fetch(
    `${cfg.url}/storage/v1/object/upload/sign/${encodeURIComponent(cfg.bucket)}/${encodePath(path)}`,
    {
      method: "POST",
      headers: {
        ...authHeadersFor(cfg.secretKey),
        "content-type": "application/json",
        "x-upsert": "false",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
      body: "{}",
    },
  );
  if (!res.ok) return storageFailure(res);
  const data = (await res.json()) as { url?: string };
  if (!data.url) throw new Error("Storage did not return a signed URL");
  const url = new URL(
    data.url.startsWith("/object/") ? `/storage/v1${data.url}` : data.url,
    cfg.url,
  );
  if (
    url.origin !== new URL(cfg.url).origin ||
    url.pathname !==
      `/storage/v1/object/upload/sign/${encodeURIComponent(cfg.bucket)}/${encodePath(path)}` ||
    !url.searchParams.get("token")
  )
    throw new Error("Storage returned an invalid signed URL");
  return url.toString();
}

/** Server-side read used to verify uploaded chunks. Service credentials are required for a private bucket. */
export async function downloadObject(
  cfg: StorageConfig,
  path: string,
  maxBytes = 45 * 1024 * 1024,
): Promise<Uint8Array> {
  const res = await fetch(
    `${cfg.url}/storage/v1/object/authenticated/${encodeURIComponent(cfg.bucket)}/${encodePath(path)}`,
    {
      headers: authHeadersFor(cfg.secretKey),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!res.ok) return storageFailure(res);
  if (Number(res.headers.get("content-length")) > maxBytes) {
    await res.body?.cancel();
    throw new Error("Stored object exceeds expected size");
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error("Storage returned no object body");
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("Stored object exceeds expected size");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

/** DELETE /object/{bucket} accepts exact object paths in prefixes. */
export async function removeObjects(
  cfg: StorageConfig,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return;
  const res = await fetch(
    `${cfg.url}/storage/v1/object/${encodeURIComponent(cfg.bucket)}`,
    {
      method: "DELETE",
      headers: {
        ...authHeadersFor(cfg.secretKey),
        "content-type": "application/json",
      },
      body: JSON.stringify({ prefixes: paths }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!res.ok) return storageFailure(res);
}
