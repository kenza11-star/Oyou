import { getBranch } from "../github/branches";
import { db } from "../db";
import { logActivity } from "../activity";
import { getFilePath, downloadTelegramFile } from "./api";
import { withGithub, type Ctx } from "./context";
import { getUserState, setPending } from "./state";
import { assertRepoAccessible } from "../github/repos";
import { commitFiles, extractZip } from "../github/upload";
import { UPLOAD_LIMITS } from "../upload/limits";
import type { TgDocument } from "./types";

async function startPush(
  telegramUserId: number,
  repoId: number,
  fullName: string,
  branch: string,
): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    `insert into app.push_operations (telegram_user_id, branch, mode, status, github_repo_id, github_repo_full_name)
     values ($1, $2, 'update', 'running', $3, $4) returning id`,
    [telegramUserId, branch, repoId, fullName],
  );
  return rows[0].id;
}

async function finishPush(
  id: string,
  status: "succeeded" | "failed",
  commitSha: string | null,
  error?: string,
) {
  await db().query(
    `update app.push_operations set status = $2, commit_sha = $3, error = $4, finished_at = now() where id = $1`,
    [id, status, commitSha, error ? error.slice(0, 500) : null],
  );
}

export async function handleZipUpload(
  ctx: Ctx,
  doc: TgDocument,
): Promise<void> {
  const state = await getUserState(ctx.telegramUserId);
  if (!state.repoId) return ctx.reply("Select a repository first with /repos.");
  if (state.pendingAction !== "await_zip" || !state.pendingActive) {
    return ctx.reply("Send /upload first to start a ZIP upload.");
  }
  if (!(doc.file_name ?? "").toLowerCase().endsWith(".zip"))
    return ctx.reply("Please send a .zip file.");
  if ((doc.file_size ?? 0) > UPLOAD_LIMITS.telegramArchiveBytes) {
    return ctx.reply(
      "This ZIP is larger than 20 MB, the Telegram bot download limit.",
    );
  }

  // One /upload authorizes one ZIP. Consume it before doing any work.
  const consumed = await db().query(
    `update app.telegram_users set pending_action=null,pending_expires_at=null
   where id=$1 and pending_action='await_zip' and pending_expires_at>now() and selected_repo_id=$2 and selected_branch=$3 returning id`,
    [ctx.telegramUserId, state.repoId, state.repoBranch],
  );
  if (!consumed.rows.length)
    return ctx.reply(
      "This upload was already consumed or the selection changed. Send /upload again.",
    );
  const repoId = state.repoId;
  const botToken = ctx.env.telegramBotToken;

  await withGithub(ctx, "upload", async (token) => {
    const repo = await assertRepoAccessible(token, repoId);
    const branch = await getBranch(
      token,
      repo.fullName,
      state.repoBranch ?? repo.defaultBranch,
    );
    const filePath = await getFilePath(botToken, doc.file_id);
    const archive = await downloadTelegramFile(
      botToken,
      filePath,
      UPLOAD_LIMITS.telegramArchiveBytes,
    );
    const files = extractZip(archive, UPLOAD_LIMITS.telegramArchiveBytes);

    const opId = await startPush(
      ctx.telegramUserId,
      repo.id,
      repo.fullName,
      branch,
    );
    try {
      const out = await commitFiles(
        token,
        repo.fullName,
        branch,
        files,
        `Update from GitHub Manager Bot (Telegram user ${ctx.telegramUserId})`,
      );
      await finishPush(opId, "succeeded", out.commitSha);
      await logActivity(ctx.telegramUserId, "push", "success");
      if (!out.commitSha) {
        return ctx.reply(
          `No changes: all ${out.unchanged} files already match ${repo.fullName}.`,
        );
      }
      return ctx.reply(
        `Committed ${out.commitSha.slice(0, 7)} to ${repo.fullName} (${branch}).\n` +
          `Added ${out.added}, updated ${out.updated}, unchanged ${out.unchanged}.\n${out.commitUrl}`,
      );
    } catch (err) {
      await finishPush(
        opId,
        "failed",
        null,
        err instanceof Error ? err.message : "unknown",
      );
      throw err;
    }
  });
}
