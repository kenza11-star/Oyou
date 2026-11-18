import { getBranch, listBranches } from "../github/branches";
import { UserFacingError } from "../github/client";
import { cancelJob, UploadError } from "../upload/service";
import type { AppEnv } from "../env";
import { db } from "../db";
import { consumeRateLimit } from "../rate-limit";
import { logActivity } from "../activity";
import { attachLoginMessage, createLoginState } from "../auth/oauth-state";
import { isAdmin } from "../auth/admin";
import { authorizeUrl, fetchGithubProfile } from "../github/oauth";
import { getActiveGithubLogin, unlinkGithubAccount } from "../github/linking";
import { getUsableToken, revokeGrant } from "../github/credentials";
import { assertRepoAccessible, listAccessibleRepos } from "../github/repos";
import {
  listRuns,
  findNewestArtifact,
  findLatestApkAsset,
  downloadBinary,
  extractApk,
  ARTIFACT_LIMIT,
  SEND_LIMIT,
} from "../github/actions";
import { makeCtx, withGithub, type Ctx } from "./context";
import { sendDocument, sendMessage } from "./api";
import { loginKeyboard, sendProfileCard } from "./menu";
import { dispatchProcessor } from "../actions-worker/dispatch";
import { mintSessionToken } from "../upload/session";
import { mintWebToken } from "../web/session";
import {
  getUserState,
  setPending,
  clearSelection,
  setSelectedRepo,
} from "./state";
import { showRepoPage } from "./callbacks";
import { handleZipUpload } from "./documents";
import { HELP_TEXT, UNKNOWN_TEXT } from "./messages";
import type { TgMessage } from "./types";

async function requireSelection(ctx: Ctx): Promise<{
  repoId: number;
  repoFullName: string;
  repoBranch: string;
  sessionVersion: number;
} | null> {
  const st = await getUserState(ctx.telegramUserId);
  if (!st.repoId || !st.repoFullName) {
    await ctx.reply("Select a repository first with /repos.");
    return null;
  }
  return {
    repoId: st.repoId,
    repoFullName: st.repoFullName,
    repoBranch: st.repoBranch ?? "",
    sessionVersion: st.sessionVersion,
  };
}

/** A queued job nobody has picked up for 3+ minutes means the dispatch was missed; nudge the processor once. */
async function redispatchIfStalled(userId: number): Promise<void> {
  try {
    const { rows } = await db().query(
      `select 1 from app.upload_jobs where telegram_user_id=$1 and status='uploaded' and cancel_requested_at is null
       and next_attempt_at<now()-interval '3 minutes' and (dispatched_at is null or dispatched_at<now()-interval '3 minutes') limit 1`,
      [userId],
    );
    if (rows.length) await dispatchProcessor();
  } catch {
    /* best effort */
  }
}

async function sendLatestApk(
  ctx: Ctx,
  token: string,
  fullName: string,
): Promise<void> {
  const botToken = ctx.env.telegramBotToken;

  const artifact = await findNewestArtifact(token, fullName);
  let fallbackZip: Uint8Array | null = null;
  let artifactProblem: string | null = null;
  if (artifact) {
    try {
      const zip = await downloadBinary(
        token,
        artifact.archive_download_url,
        ARTIFACT_LIMIT,
      );
      const apk = extractApk(zip);
      if (apk)
        return sendDocument(
          botToken,
          ctx.chatId,
          apk.name,
          apk.data,
          `APK from artifact "${artifact.name}"`,
        );
      if (zip.length <= SEND_LIMIT) fallbackZip = zip;
    } catch (e) {
      if (!(e instanceof UserFacingError)) throw e;
      artifactProblem = e.message;
    }
  }
  const asset = await findLatestApkAsset(token, fullName);
  if (asset) {
    if (asset.size > SEND_LIMIT)
      return ctx.reply(
        "The release APK is larger than the 50 MiB Telegram send limit. Download it from the GitHub release page.",
      );
    const data = await downloadBinary(token, asset.url, SEND_LIMIT);
    return sendDocument(
      botToken,
      ctx.chatId,
      asset.name,
      data,
      "APK from the latest release",
    );
  }
  if (fallbackZip && artifact)
    return sendDocument(
      botToken,
      ctx.chatId,
      `${artifact.name}.zip`,
      fallbackZip,
      "Artifact (no APK found inside)",
    );
  if (artifactProblem) return ctx.reply(artifactProblem);

  await ctx.reply("No APK found in the newest artifact or the latest release.");
}

/** Sends a message whose only button is Login; the OAuth callback later turns it into Success/Failed. */
async function sendLoginPrompt(ctx: Ctx, text: string): Promise<void> {
  if (!(await consumeRateLimit(`login:${ctx.telegramUserId}`, 5, 600))) {
    return ctx.reply("Too many login attempts. Try again in a few minutes.");
  }
  const state = await createLoginState(ctx.telegramUserId);
  const messageId = await sendMessage(
    ctx.env.telegramBotToken,
    ctx.chatId,
    text,
    loginKeyboard(authorizeUrl(ctx.env, state)),
  );
  await attachLoginMessage(state, messageId).catch(() => undefined);
}

/** /start: profile card + menu when already connected, otherwise the Login button. */
async function showHome(ctx: Ctx): Promise<void> {
  const cred = await getUsableToken(ctx.telegramUserId, ctx.env).catch(() => null);
  if (cred) {
    try {
      const profile = await fetchGithubProfile(cred.token);
      const count = await listAccessibleRepos(cred.token)
        .then((r) => r.length)
        .catch(() => null);
      return sendProfileCard(ctx.env, ctx.chatId, profile, count);
    } catch {
      /* token no longer usable: fall through to the Login button */
    }
  }
  return sendLoginPrompt(
    ctx,
    "Welcome to GitHub Manager!\n\nTap Login to connect your GitHub account. The link works once and expires in 10 minutes.",
  );
}

export async function handleMessage(
  msg: TgMessage,
  env: AppEnv,
): Promise<void> {
  if (!msg.from) return;
  const from = msg.from;
  const ctx = makeCtx(env, from.id, msg.chat.id);

  // Every user is registered on first contact. Access is never gated by the admin list.
  await db().query(
    `insert into app.telegram_users (id, username, first_name) values ($1, $2, $3)
     on conflict (id) do update set username = excluded.username,
       first_name = excluded.first_name, last_active_at = now()`,
    [from.id, from.username ?? null, from.first_name ?? null],
  );

  if (!(await consumeRateLimit(`tg:${from.id}`, 30, 60))) {
    return ctx.reply("Too many requests. Please wait a moment and try again.");
  }

  // GitHub account links, private repositories and signed upload capabilities stay in DMs.
  if (msg.chat.id !== from.id) {
    return ctx.reply(
      "Use a private chat with this bot for GitHub commands and uploads.",
    );
  }
  if (msg.document) return handleZipUpload(ctx, msg.document);

  const command = (msg.text ?? "")
    .trim()
    .split(/\s+/)[0]
    .split("@")[0]
    .toLowerCase();

  switch (command) {
    case "/start":
      return showHome(ctx);
    case "/help":
      return ctx.reply(HELP_TEXT);

    case "/login": {
      return sendLoginPrompt(
        ctx,
        "Tap Login to connect your GitHub account. The link works once and expires in 10 minutes.",
      );
    }

    case "/web":
    case "/dashboard": {
      if (!(await consumeRateLimit(`web-link:${from.id}`, 5, 600)))
        return ctx.reply("Too many dashboard links requested. Try again in a few minutes.");
      const v = await db().query<{ upload_session_version: number }>(
        "select upload_session_version from app.telegram_users where id=$1",
        [from.id],
      );
      const token = mintWebToken(from.id, env.encryptionKey, v.rows[0]?.upload_session_version ?? 0);
      return ctx.reply(
        "Open the dashboard with the button below. The link signs you in for 8 hours; do not forward it.",
        { inline_keyboard: [[{ text: "Open dashboard", url: `${env.appUrl}/app#t=${token}` }]] },
      );
    }

    case "/status": {
      const login = await getActiveGithubLogin(from.id);
      const st = await getUserState(from.id);
      const account = login
        ? `Connected GitHub account: ${login}`
        : "No GitHub account connected. Send /login.";
      const repo = st.repoFullName
        ? `Selected repository: ${st.repoFullName}`
        : "No repository selected. Use /repos.";
      await redispatchIfStalled(from.id);
      return ctx.reply(`${account}\n${repo}`);
    }

    case "/repos":
      return showRepoPage(ctx, 0);

    case "/branch":
    case "/branches": {
      const sel = await requireSelection(ctx);
      if (!sel) return;
      const name = (msg.text ?? "").trim().split(/\s+/).slice(1).join(" ");
      await withGithub(ctx, "select_branch", async (token) => {
        await assertRepoAccessible(token, sel.repoId);
        if (!name) {
          const branches = await listBranches(token, sel.repoFullName);
          return ctx.reply(
            `Current branch: ${sel.repoBranch}\nAvailable branches (first 30):\n${branches.join("\n")}\n\nSend /branch branch-name to select an existing branch.`,
          );
        }
        const branch = await getBranch(token, sel.repoFullName, name);
        await setSelectedRepo(from.id, sel.repoId, sel.repoFullName, branch);
        await ctx.reply(
          `Selected ${sel.repoFullName} — branch: ${branch}. Send /upload to continue.`,
        );
      });
      return;
    }
    case "/upload": {
      const sel = await requireSelection(ctx);
      if (!sel) return;
      const cred = await getUsableToken(from.id, env);
      if (!cred)
        return ctx.reply("Connect your GitHub account first with /login.");
      await assertRepoAccessible(cred.token, sel.repoId);
      await setPending(from.id, "await_zip", 10);
      const session = mintSessionToken(from.id, env.encryptionKey, Date.now(), {
        repoId: sel.repoId,
        repoFullName: sel.repoFullName,
        branch: sel.repoBranch,
        sessionVersion: sel.sessionVersion,
      });
      return ctx.reply(
        `Repository: ${sel.repoFullName}\nBranch: ${sel.repoBranch}\n\n` +
          "Tap the button to upload a ZIP of up to 100 MB in your browser. The link expires in 30 minutes.\n\n" +
          "Or send a .zip of up to 20 MB directly in this chat within 10 minutes.",
        {
          inline_keyboard: [
            [
              {
                text: "Upload ZIP (up to 100 MB)",
                url: `${env.appUrl}/upload#t=${session}`,
              },
            ],
          ],
        },
      );
    }

    case "/cancel": {
      await setPending(from.id, null, 0);
      const requested = (msg.text ?? "").trim().split(/\s+/)[1];
      const rows = requested
        ? [{ id: requested }]
        : (
            await db().query<{ id: string }>(
              "select id from app.upload_jobs where telegram_user_id=$1 and status in ('created','uploading','uploaded','processing') order by created_at desc limit 1",
              [from.id],
            )
          ).rows;
      if (!rows[0])
        return ctx.reply("No active upload. Pending upload cancelled.");
      try {
        await cancelJob(from.id, rows[0].id);
        return ctx.reply("Upload cancelled.");
      } catch (e) {
        return ctx.reply(
          e instanceof UploadError ? e.message : "Unable to cancel. Try again.",
        );
      }
    }

    case "/actions": {
      const sel = await requireSelection(ctx);
      if (!sel) return;
      await withGithub(ctx, "actions", async (token) => {
        await assertRepoAccessible(token, sel.repoId);
        const runs = await listRuns(token, sel.repoFullName);
        if (runs.length === 0) return ctx.reply("No workflow runs found.");
        return ctx.reply(
          runs
            .map(
              (r) =>
                `${r.name} #${r.runNumber} (${r.branch}, ${r.sha})\n${r.label}\n${r.url}`,
            )
            .join("\n\n"),
        );
      });
      return;
    }

    case "/apk": {
      const sel = await requireSelection(ctx);
      if (!sel) return;
      await withGithub(ctx, "apk_download", async (token) => {
        await assertRepoAccessible(token, sel.repoId);
        await sendLatestApk(ctx, token, sel.repoFullName);
        await logActivity(from.id, "apk_download", "success");
      });
      return;
    }

    case "/logout": {
      // Revoke at GitHub when a usable token exists, then delete local material regardless.
      const cred = await getUsableToken(from.id, env).catch(() => null);
      let revoked = false;
      if (cred) {
        revoked = await revokeGrant(env, cred.token).catch(() => false);
      }
      const removed = await unlinkGithubAccount(from.id);
      await clearSelection(from.id);
      await logActivity(
        from.id,
        "github_disconnect",
        "success",
        revoked ? undefined : "grant not confirmed revoked",
      );
      if (removed === 0) return ctx.reply("No GitHub account is connected.");
      return ctx.reply(
        revoked
          ? "Your GitHub account was disconnected, the grant was revoked, and the stored token was deleted."
          : "Your GitHub account was disconnected and the stored token was deleted. GitHub did not confirm revocation; you can also revoke the app in your GitHub settings.",
      );
    }

    case "/admin": {
      // Non-admins get the generic reply so the command is not revealed.
      if (!isAdmin(env, String(from.id))) return ctx.reply(UNKNOWN_TEXT);
      const { rows } = await db().query<{ users: string; connected: string }>(
        `select (select count(*) from app.telegram_users) as users,
                (select count(*) from app.github_identities where disconnected_at is null) as connected`,
      );
      return ctx.reply(
        `Users: ${rows[0].users}\nConnected GitHub accounts: ${rows[0].connected}`,
      );
    }

    default:
      return ctx.reply(command.startsWith("/") ? UNKNOWN_TEXT : HELP_TEXT);
  }
}
