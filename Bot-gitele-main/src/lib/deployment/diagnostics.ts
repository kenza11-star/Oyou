/**
 * Sanitised diagnostics. Only fixed strings, variable NAMES and driver error CODES leave this module.
 * Never include error messages: pg and fetch messages can contain hosts, URLs or credentials.
 */
export interface Problem {
  area: "env" | "database" | "schema" | "storage" | "dispatch";
  code: string;
  hint: string;
}

const DB_HINTS: Record<string, string> = {
  SELF_SIGNED_CERT_IN_CHAIN:
    "Postgres TLS certificate is not trusted. Set DATABASE_CA_CERT to the Supabase CA certificate (Dashboard → Database → SSL configuration).",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE:
    "Postgres TLS certificate is not trusted. Set DATABASE_CA_CERT to the Supabase CA certificate.",
  DEPTH_ZERO_SELF_SIGNED_CERT:
    "Postgres TLS certificate is not trusted. Set DATABASE_CA_CERT to the Supabase CA certificate.",
  CERT_HAS_EXPIRED: "Postgres TLS certificate has expired.",
  ENOTFOUND: "DATABASE_URL host does not resolve. Re-copy the Supabase connection string.",
  ECONNREFUSED: "Database refused the connection. Use the Supabase pooler connection string.",
  ETIMEDOUT: "Database connection timed out. Use the Supabase pooler connection string (IPv4).",
  "28P01": "Database password rejected. Re-copy DATABASE_URL from Supabase.",
  "28000": "Database role rejected. Re-copy DATABASE_URL from Supabase.",
  "3D000": "Database name in DATABASE_URL does not exist.",
  "42P01": "A table is missing. Apply the SQL migrations in db/migrations in order.",
  "42703": "A column is missing. Apply the SQL migrations in db/migrations in order.",
  "3F000": "Schema \"app\" is missing. Apply db/migrations/0001_init.sql first.",
};

export function describeDbError(err: unknown): Problem {
  const code =
    typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
      ? err.code
      : err instanceof Error
        ? err.name
        : "unknown";
  return {
    area: "database",
    code,
    hint: DB_HINTS[code] ?? "Database query failed. Check DATABASE_URL and that migrations were applied.",
  };
}

/** loadEnv/storageConfig throw errors whose messages only name variables; keep that text. */
export function describeEnvError(err: unknown): Problem {
  const message = err instanceof Error ? err.message : "";
  const safe = /^(Missing |ENCRYPTION_KEY|TELEGRAM_|APP_URL)/.test(message)
    ? message.slice(0, 300)
    : "Environment validation failed.";
  return { area: "env", code: "ENV_INVALID", hint: safe };
}
