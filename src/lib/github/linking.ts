import type { AppEnv } from "../env";
import { db } from "../db";
import { encryptSecret } from "../crypto";
import type { GithubProfile, GithubToken } from "./oauth";

export type LinkResult = "linked" | "owned_by_another_user";

/** Stores the identity and encrypted tokens. One active Telegram user per GitHub account. */
export async function linkGithubAccount(
  env: AppEnv,
  telegramUserId: number,
  profile: GithubProfile,
  token: GithubToken,
): Promise<LinkResult> {
  const client = await db().connect();
  try {
    await client.query("begin");

    await client.query(
      "select id from app.telegram_users where id=$1 for update",
      [telegramUserId],
    );
    const conflict = await client.query(
      `select 1 from app.github_identities
       where github_user_id = $1 and disconnected_at is null and telegram_user_id <> $2 limit 1`,
      [profile.id, telegramUserId],
    );
    if ((conflict.rowCount ?? 0) > 0) {
      await client.query("rollback");
      return "owned_by_another_user";
    }

    // A Telegram session has one current GitHub identity; never pick an older connected account.
    const changed = await client.query(
      `with ended as (
      update app.github_identities set disconnected_at=now() where telegram_user_id=$1 and github_user_id<>$2 and disconnected_at is null returning id
    ) delete from app.github_credentials where identity_id in(select id from ended) returning id`,
      [telegramUserId, profile.id],
    );
    if (changed.rows.length) {
      await client.query(
        `update app.upload_jobs set status='cancelled',processing_stage='cancelled',cancel_requested_at=now(),lease_owner=null,lease_until=null,notify_after=now(),expires_at=now()+interval '3 hours' where telegram_user_id=$1 and status in ('created','uploading','uploaded','processing') and publish_started_at is null`,
        [telegramUserId],
      );
    }
    await client.query(
      "update app.telegram_users set upload_session_version=upload_session_version+1,selected_repo_id=null,selected_repo_full_name=null,selected_branch=null,pending_action=null,pending_expires_at=null where id=$1",
      [telegramUserId],
    );
    const identity = await client.query<{ id: string }>(
      `insert into app.github_identities (telegram_user_id, github_user_id, github_login)
       values ($1, $2, $3)
       on conflict (github_user_id, telegram_user_id)
       do update set github_login = excluded.github_login, disconnected_at = null, connected_at = now()
       returning id`,
      [telegramUserId, profile.id, profile.login],
    );

    await client.query(
      `insert into app.github_credentials
         (identity_id, auth_type, ciphertext, expires_at, refresh_ciphertext, refresh_expires_at)
       values ($1, 'github_app_user', $2, $3, $4, $5)
       on conflict (identity_id) do update set
         auth_type = excluded.auth_type, ciphertext = excluded.ciphertext, expires_at = excluded.expires_at,
         refresh_ciphertext = excluded.refresh_ciphertext, refresh_expires_at = excluded.refresh_expires_at,
         created_at = now(), revoked_at = null`,
      [
        identity.rows[0].id,
        encryptSecret(token.accessToken, env.encryptionKey),
        token.expiresAt,
        token.refreshToken
          ? encryptSecret(token.refreshToken, env.encryptionKey)
          : null,
        token.refreshExpiresAt,
      ],
    );

    await client.query("commit");
    return "linked";
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      err.code === "23505" &&
      "constraint" in err &&
      err.constraint === "github_identities_active_user_idx"
    )
      return "owned_by_another_user";
    throw err;
  } finally {
    client.release();
  }
}

/** Deletes the stored tokens and marks the identity disconnected. Scoped to one Telegram user. */
export async function unlinkGithubAccount(
  telegramUserId: number,
): Promise<number> {
  const { rows } = await db().query<{ removed: string }>(
    `with revoked as (update app.telegram_users set upload_session_version=upload_session_version+1 where id=$1 returning id), ended as (
      update app.github_identities set disconnected_at=now()
      where telegram_user_id=$1 and disconnected_at is null returning id
    ), removed as (
      delete from app.github_credentials where identity_id in(select id from ended) returning id
    ), cancelled as (
      update app.upload_jobs set status='cancelled',processing_stage='cancelled',cancel_requested_at=now(),
      lease_owner=null,lease_until=null,notify_after=now(),expires_at=now()+interval '3 hours',updated_at=now(),version=version+1
      where telegram_user_id=$1 and publish_started_at is null and status in ('created','uploading','uploaded','processing') returning id
    ) select count(*) as removed from removed`,
    [telegramUserId],
  );
  return Number(rows[0]?.removed ?? 0);
}

export async function getActiveGithubLogin(
  telegramUserId: number,
): Promise<string | null> {
  const { rows } = await db().query<{ github_login: string }>(
    `select i.github_login from app.github_identities i
     join app.github_credentials c on c.identity_id = i.id
     where i.telegram_user_id = $1 and i.disconnected_at is null and c.revoked_at is null
     order by i.connected_at desc limit 1`,
    [telegramUserId],
  );
  return rows[0]?.github_login ?? null;
}
