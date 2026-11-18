import { Pool, type PoolConfig } from "pg";

let pool: Pool | null = null;

/**
 * TLS is always verified. The sslmode parameter is removed from the URL so it cannot
 * override the explicit ssl settings below (pg treats some sslmode values as "no verification").
 */
export function buildPoolConfig(
  connectionString: string,
  caPem?: string,
): PoolConfig {
  const url = new URL(connectionString);
  for (const name of [
    "ssl",
    "sslmode",
    "sslrootcert",
    "sslcert",
    "sslkey",
    "sslpassword",
    "uselibpqcompat",
  ])
    url.searchParams.delete(name);
  return {
    connectionString: url.toString(),
    max: 3,
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
    ssl: { rejectUnauthorized: true, ca: caPem || undefined },
  };
}

export function db(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    const ca = process.env.DATABASE_CA_CERT?.replace(/\\n/g, "\n");
    pool = new Pool(buildPoolConfig(connectionString, ca));
    pool.on("error", (err) => console.error("pg pool error", err.name));
  }
  return pool;
}

/** Shutdown without constructing a new pool when configuration failed during startup. */
export async function closeDb(): Promise<void> {
  const current = pool;
  pool = null;
  if (current) await current.end();
}
