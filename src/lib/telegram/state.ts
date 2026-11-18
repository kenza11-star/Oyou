import { db } from "../db";

export interface UserState {
  repoId: number | null;
  repoFullName: string | null;
  repoBranch: string | null;
  pendingAction: string | null;
  pendingActive: boolean;
  sessionVersion: number;
}

export async function getUserState(telegramUserId: number): Promise<UserState> {
  const { rows } = await db().query(
    `select selected_repo_id, selected_repo_full_name, selected_branch, pending_action, upload_session_version,
            coalesce(pending_expires_at > now(), false) as pending_active
     from app.telegram_users where id = $1`,
    [telegramUserId],
  );
  const r = rows[0];
  return {
    repoId: r?.selected_repo_id == null ? null : Number(r.selected_repo_id),
    repoFullName: r?.selected_repo_full_name ?? null,
    repoBranch: r?.selected_branch ?? null,
    pendingAction: r?.pending_action ?? null,
    pendingActive: Boolean(r?.pending_active),
    sessionVersion: Number(r?.upload_session_version ?? 0),
  };
}

export async function setSelectedRepo(
  telegramUserId: number,
  repoId: number,
  fullName: string,
  branch: string,
) {
  await db().query(
    `update app.telegram_users set selected_repo_id = $2, selected_repo_full_name = $3, selected_branch = $4,
       pending_action = null, pending_expires_at = null where id = $1`,
    [telegramUserId, repoId, fullName, branch],
  );
}

/** Pass minutes = 0 or action = null to clear the pending action. */
export async function setPending(
  telegramUserId: number,
  action: "await_zip" | null,
  minutes: number,
) {
  const expires =
    action && minutes > 0 ? new Date(Date.now() + minutes * 60_000) : null;
  await db().query(
    `update app.telegram_users set pending_action = $2, pending_expires_at = $3 where id = $1`,
    [telegramUserId, expires ? action : null, expires],
  );
}

export async function clearSelection(telegramUserId: number) {
  await db().query(
    `update app.telegram_users set selected_repo_id = null, selected_repo_full_name = null,
       selected_branch = null, pending_action = null, pending_expires_at = null where id = $1`,
    [telegramUserId],
  );
}
