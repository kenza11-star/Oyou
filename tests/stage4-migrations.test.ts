import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";
it("upgrades populated Stage 3 data without deleting rows and keeps every app table RLS-protected", async () => {
  const db = new PGlite();
  try {
    await db.exec("create role anon; create role authenticated;");
    for (const file of readdirSync("db/migrations")
      .sort()
      .filter((f) => !f.startsWith("0007")))
      await db.exec(readFileSync("db/migrations/" + file, "utf8"));
    await db.query(
      "insert into app.telegram_users(id,username,selected_branch) values(1,'existing','develop')",
    );
    await db.query("insert into app.processed_updates(update_id) values(123)");
    const states = [
      "awaiting_upload",
      "uploaded",
      "processing",
      "ready",
      "completed",
      "failed",
    ];
    for (const status of states)
      await db.query(
        "insert into app.upload_jobs(telegram_user_id,storage_path,status,expires_at) values(1,$1,$1,now()+interval '1 day')",
        [status],
      );
    const sql = readFileSync(
      "db/migrations/0007_production_hardening.sql",
      "utf8",
    );
    await db.exec(sql);
    await db.exec(sql);
    expect(
      (
        await db.query<{ status: string }>(
          "select status from app.upload_jobs order by status",
        )
      ).rows.map((r) => r.status),
    ).toEqual([...states].sort());
    expect(
      (
        await db.query(
          "select username,selected_branch,upload_session_version from app.telegram_users",
        )
      ).rows,
    ).toEqual([
      {
        username: "existing",
        selected_branch: "develop",
        upload_session_version: 0,
      },
    ]);
    expect(
      (
        await db.query(
          "select processing_status from app.processed_updates where update_id=123",
        )
      ).rows,
    ).toEqual([{ processing_status: "completed" }]);
    const tables = await db.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='app' and c.relkind='r'",
    );
    expect(tables.rows.every((r) => r.relrowsecurity)).toBe(true);
  } finally {
    await db.close();
  }
}, 30000);
