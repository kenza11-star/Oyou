import { db } from "./db";

/**
 * Fixed-window counter stored in Postgres so limits hold across serverless instances.
 * Returns true if the request is allowed. Fails closed: database errors throw.
 */
export async function consumeRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const { rows } = await db().query<{ count: number }>(
    `insert into app.rate_limits (key, window_start, count)
     values ($1, to_timestamp(floor(extract(epoch from now()) / $2::int) * $2::int), 1)
     on conflict (key, window_start) do update set count = app.rate_limits.count + 1
     returning count`,
    [key, windowSeconds],
  );
  return rows[0].count <= limit;
}
