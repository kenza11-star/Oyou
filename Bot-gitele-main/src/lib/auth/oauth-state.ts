import { createHash, randomBytes } from "node:crypto";
import { db } from "../db";

export function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

/** Creates a one-time, 10-minute state bound to a Telegram user. Only the hash is stored. */
export async function createLoginState(telegramUserId: number): Promise<string> {
  const state = randomBytes(32).toString("base64url");
  await db().query(
    `insert into app.oauth_states (state_hash, telegram_user_id, expires_at)
     values ($1, $2, now() + interval '10 minutes')`,
    [hashState(state), telegramUserId],
  );
  return state;
}

/** Remembers which Telegram message carries the Login button for this state (best effort). */
export async function attachLoginMessage(state: string, messageId: number): Promise<void> {
  await db().query("update app.oauth_states set message_id = $2 where state_hash = $1", [
    hashState(state),
    messageId,
  ]);
}

/** Atomically consumes a state. Returns the bound Telegram user and login message, or null if invalid, expired, or reused. */
export async function consumeLoginStateWithMessage(
  state: string,
): Promise<{ telegramUserId: number; messageId: number | null } | null> {
  const { rows } = await db().query<{ telegram_user_id: string; message_id: string | null }>(
    `update app.oauth_states set used_at = now()
     where state_hash = $1 and used_at is null and expires_at > now()
     returning telegram_user_id, message_id`,
    [hashState(state)],
  );
  if (!rows[0]) return null;
  return {
    telegramUserId: Number(rows[0].telegram_user_id),
    messageId: rows[0].message_id === null ? null : Number(rows[0].message_id),
  };
}

/** Atomically consumes a state. Returns the bound Telegram user ID, or null if invalid, expired, or reused. */
export async function consumeLoginState(state: string): Promise<number | null> {
  const r = await consumeLoginStateWithMessage(state);
  return r ? r.telegramUserId : null;
}
