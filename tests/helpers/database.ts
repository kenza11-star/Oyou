import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
export async function testDatabase() {
  const engine = new PGlite();
  await engine.exec("create role anon; create role authenticated;");
  for (const file of readdirSync("db/migrations").sort())
    await engine.exec(readFileSync("db/migrations/" + file, "utf8"));
  let tail = Promise.resolve();
  const lock = async () => {
    const old = tail;
    let release!: () => void;
    tail = new Promise((r) => (release = r));
    await old;
    return release;
  };
  const query = async (sql: string, args?: unknown[]) => {
    const result = await engine.query(sql, args);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  };
  const pool = {
    query: async (sql: string, args?: unknown[]) => {
      const release = await lock();
      try {
        return await query(sql, args);
      } finally {
        release();
      }
    },
    connect: async () => {
      const release = await lock();
      return { query, release };
    },
  };
  return { engine, pool };
}
