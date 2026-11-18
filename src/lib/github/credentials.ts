import type { AppEnv } from "../env";
import { loadEnv } from "../env";
import { db } from "../db";
import { decryptSecret, encryptSecret } from "../crypto";
import { GithubAuthError } from "./client";
import { refreshAccessToken } from "./oauth";

const REFRESH_MARGIN_MS = 60_000;

/** Marks the user's credentials unusable and erases the stored token material. */
export async function markCredentialExpired(
  telegramUserId: number,
): Promise<void> {
  await db().query(
    `update app.github_credentials
       set revoked_at = now(), ciphertext = '', refresh_ciphertext = null
     where identity_id in (
       select id from app.github_identities where telegram_user_id = $1 and disconnected_at is null
     )`,
    [telegramUserId],
  );
}

/**
 * Returns a usable access token for the user, refreshing it when needed.
 * Returns null when the user has no credentials or they cannot be renewed (the user must /login again).
 */
interface CredentialRow {
  credential_id: string;
  github_login: string;
  ciphertext: string;
  expires_at: Date | null;
  refresh_ciphertext: string | null;
  refresh_expires_at: Date | null;
}
const credentialQuery = `select c.id as credential_id,i.github_login,c.ciphertext,c.expires_at,c.refresh_ciphertext,c.refresh_expires_at
 from app.github_identities i join app.github_credentials c on c.identity_id=i.id
 where i.telegram_user_id=$1 and i.disconnected_at is null and c.revoked_at is null
 order by i.connected_at desc limit 1`;
export async function getUsableToken(
  telegramUserId: number,
  env: AppEnv = loadEnv(),
): Promise<{ token: string; login: string } | null> {
  const usable = (row: CredentialRow) =>
    !row.expires_at ||
    new Date(row.expires_at).getTime() - REFRESH_MARGIN_MS > Date.now();
  const read = (row: CredentialRow) => ({
    token: decryptSecret(row.ciphertext, env.encryptionKey),
    login: row.github_login,
  });
  const { rows } = await db().query<CredentialRow>(credentialQuery, [
    telegramUserId,
  ]);
  if (!rows[0]) return null;
  if (usable(rows[0])) return read(rows[0]);
  // Refresh tokens rotate. Lock and re-read so concurrent browser/worker renewals cannot reuse one.
  const client = await db().connect();
  try {
    await client.query("begin");
    const locked = await client.query<CredentialRow>(
      credentialQuery + " for update of c,i",
      [telegramUserId],
    );
    const row = locked.rows[0];
    if (!row) {
      await client.query("commit");
      return null;
    }
    if (usable(row)) {
      await client.query("commit");
      return read(row);
    }
    const revoke = async () => {
      await client.query(
        "update app.github_credentials set revoked_at=now(),ciphertext='',refresh_ciphertext=null where id=$1",
        [row.credential_id],
      );
      await client.query("commit");
      return null;
    };
    if (
      !row.refresh_ciphertext ||
      !row.refresh_expires_at ||
      new Date(row.refresh_expires_at).getTime() <= Date.now()
    )
      return await revoke();
    let fresh;
    try {
      fresh = await refreshAccessToken(
        env,
        decryptSecret(row.refresh_ciphertext, env.encryptionKey),
      );
    } catch (error) {
      if (error instanceof GithubAuthError) return await revoke();
      throw error;
    }
    await client.query(
      `update app.github_credentials set ciphertext=$2,expires_at=$3,refresh_ciphertext=$4,refresh_expires_at=$5,created_at=now() where id=$1`,
      [
        row.credential_id,
        encryptSecret(fresh.accessToken, env.encryptionKey),
        fresh.expiresAt,
        fresh.refreshToken
          ? encryptSecret(fresh.refreshToken, env.encryptionKey)
          : null,
        fresh.refreshExpiresAt,
      ],
    );
    await client.query("commit");
    return { token: fresh.accessToken, login: row.github_login };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Revokes the grant for this token at GitHub. Returns true when GitHub confirmed revocation or the token was already invalid. */
export async function revokeGrant(
  env: AppEnv,
  token: string,
): Promise<boolean> {
  const basic = Buffer.from(
    `${env.githubClientId}:${env.githubClientSecret}`,
  ).toString("base64");
  const res = await fetch(
    `https://api.github.com/applications/${env.githubClientId}/token`,
    {
      method: "DELETE",
      headers: {
        authorization: `Basic ${basic}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ access_token: token }),
    },
  );
  return res.status === 204 || res.status === 404;
}
