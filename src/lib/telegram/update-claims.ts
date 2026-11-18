import { randomUUID } from "node:crypto";
import { db } from "../db";
export async function claimUpdate(
  updateId: number,
): Promise<
  { kind: "claimed"; token: string } | { kind: "completed" } | { kind: "busy" }
> {
  const token = randomUUID();
  const result = await db().query(
    `insert into app.processed_updates(update_id,processing_status,claim_token,lease_until)
 values ($1,'processing',$2,now()+interval '90 seconds')
 on conflict(update_id) do update set processing_status='processing',claim_token=excluded.claim_token,lease_until=excluded.lease_until
 where app.processed_updates.processing_status<>'completed' and (app.processed_updates.lease_until is null or app.processed_updates.lease_until<now()) returning update_id`,
    [updateId, token],
  );
  if (result.rows.length) return { kind: "claimed", token };
  const { rows } = await db().query<{ processing_status: string }>(
    "select processing_status from app.processed_updates where update_id=$1",
    [updateId],
  );
  return {
    kind: rows[0]?.processing_status === "completed" ? "completed" : "busy",
  };
}
export async function finishUpdate(
  updateId: number,
  token: string,
  success: boolean,
): Promise<boolean> {
  const result = await db().query(
    `update app.processed_updates set processing_status=$3,lease_until=null,completed_at=case when $4 then now() else null end
 where update_id=$1 and claim_token=$2 returning update_id`,
    [updateId, token, success ? "completed" : "pending", success],
  );
  return result.rows.length > 0;
}

/** A failing update is retried by Telegram. After this many failures it is dropped so it cannot block the queue. */
export const MAX_UPDATE_FAILURES = 3;
