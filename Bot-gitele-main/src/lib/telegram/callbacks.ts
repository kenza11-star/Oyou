import { cancelJob, UploadError } from "../upload/service";
import type { AppEnv } from "../env";
import { answerCallbackQuery, type InlineKeyboard } from "./api";
import { makeCtx, withGithub, type Ctx } from "./context";
import { listAccessibleRepos, assertRepoAccessible } from "../github/repos";
import { setSelectedRepo } from "./state";
import { consumeRateLimit } from "../rate-limit";
import { MENU_COMMANDS } from "./menu";
import type { TgCallbackQuery } from "./types";

export const REPO_PAGE_SIZE = 8;

export type CallbackAction =
  | { kind: "repos"; page: number }
  | { kind: "pick"; repoId: number };

export function parseCallbackData(
  data: string | undefined,
): CallbackAction | null {
  const m = /^(repos|pick):(\d{1,12})$/.exec(data ?? "");
  if (!m) return null;
  const n = Number(m[2]);
  return m[1] === "repos"
    ? { kind: "repos", page: n }
    : { kind: "pick", repoId: n };
}

export async function showRepoPage(ctx: Ctx, page: number): Promise<void> {
  await withGithub(ctx, "list_repos", async (token) => {
    const repos = await listAccessibleRepos(token);
    if (repos.length === 0) {
      await ctx.reply(
        `No repositories are available. Install the GitHub App on the repositories you want to manage:\nhttps://github.com/apps/${ctx.env.githubAppSlug}/installations/new`,
      );
      return;
    }
    const pages = Math.max(1, Math.ceil(repos.length / REPO_PAGE_SIZE));
    const p = Math.min(Math.max(0, page), pages - 1);
    const rows: { text: string; callback_data: string }[][] = repos
      .slice(p * REPO_PAGE_SIZE, (p + 1) * REPO_PAGE_SIZE)
      .map((r) => [
        {
          text: `${r.fullName}${r.private ? " (private)" : ""}`.slice(0, 60),
          callback_data: `pick:${r.id}`,
        },
      ]);
    const nav: { text: string; callback_data: string }[] = [];
    if (p > 0) nav.push({ text: "Prev", callback_data: `repos:${p - 1}` });
    if (p < pages - 1)
      nav.push({ text: "Next", callback_data: `repos:${p + 1}` });
    if (nav.length > 0) rows.push(nav);
    await ctx.reply(`Select a repository (page ${p + 1} of ${pages}):`, {
      inline_keyboard: rows,
    });
  });
}

export async function handleCallback(
  cq: TgCallbackQuery,
  env: AppEnv,
): Promise<void> {
  await answerCallbackQuery(env.telegramBotToken, cq.id).catch(() => undefined);
  const chatId = cq.message?.chat.id;
  if (!chatId || chatId !== cq.from.id) return;

  const ctx = makeCtx(env, cq.from.id, chatId);
  if (!(await consumeRateLimit(`tg:${cq.from.id}`, 30, 60))) {
    await ctx.reply("Too many requests. Please wait a moment.");
    return;
  }

  const cancel = /^upload_cancel:([0-9a-f-]{36})$/i.exec(cq.data ?? "");
  if (cancel) {
    try {
      await cancelJob(cq.from.id, cancel[1]);
      await ctx.reply("Upload cancelled.");
    } catch (e) {
      await ctx.reply(
        e instanceof UploadError
          ? e.message
          : "Unable to cancel the upload. Try again.",
      );
    }
    return;
  }
  // Menu buttons run the same code path as the slash command they stand for.
  const menu = /^menu:([a-z]{1,12})$/.exec(cq.data ?? "");
  if (menu) {
    const command = MENU_COMMANDS[menu[1]];
    if (!command) return;
    const { handleMessage } = await import("./handlers");
    await handleMessage({ chat: { id: chatId }, from: cq.from, text: command }, env);
    return;
  }
  const action = parseCallbackData(cq.data);
  if (!action) return;

  if (action.kind === "repos") {
    await showRepoPage(ctx, action.page);
    return;
  }

  // Selection re-checks access against the caller's own installations.
  await withGithub(ctx, "select_repo", async (token) => {
    const repo = await assertRepoAccessible(token, action.repoId);
    await setSelectedRepo(
      cq.from.id,
      repo.id,
      repo.fullName,
      repo.defaultBranch,
    );
    await ctx.reply(
      `Selected ${repo.fullName} (branch: ${repo.defaultBranch}).\nUse /upload to send a ZIP, /actions for workflow runs, or /apk for the latest APK.`,
    );
  });
}
