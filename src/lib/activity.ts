import { db } from "./db";

export async function logActivity(
  telegramUserId: number | null,
  operation: string,
  result: "success" | "failure" | "info",
  errorDetail?: string,
): Promise<void> {
  // Never pass tokens or request bodies here.
  await db().query(
    `insert into app.activity_logs (telegram_user_id, operation, result, error_detail) values ($1, $2, $3, $4)`,
    [telegramUserId, operation, result, errorDetail ? errorDetail.slice(0, 500) : null],
  );
}
