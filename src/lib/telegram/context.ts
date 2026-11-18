import type { AppEnv } from "../env";
import { sendMessage, type InlineKeyboard } from "./api";
import { getUsableToken, markCredentialExpired } from "../github/credentials";
import { GithubAuthError, GithubNotFoundError, GithubRateLimitError, UserFacingError } from "../github/client";
import { logActivity } from "../activity";

export interface Ctx {
  env: AppEnv;
  telegramUserId: number;
  chatId: number;
  reply(text: string, keyboard?: InlineKeyboard): Promise<void>;
}

export function makeCtx(env: AppEnv, telegramUserId: number, chatId: number): Ctx {
  return {
    env,
    telegramUserId,
    chatId,
    reply: async (text, keyboard) => {
      await sendMessage(env.telegramBotToken, chatId, text, keyboard);
    },
  };
}

/**
 * Runs a GitHub operation with the caller's own credentials and maps failures to safe messages.
 * Never returns or logs the token.
 */
export async function withGithub<T>(
  ctx: Ctx,
  operation: string,
  fn: (token: string, login: string) => Promise<T>,
): Promise<T | undefined> {
  const cred = await getUsableToken(ctx.telegramUserId, ctx.env);
  if (!cred) {
    await ctx.reply("Connect your GitHub account first with /login.");
    return undefined;
  }

  try {
    return await fn(cred.token, cred.login);
  } catch (err) {
    if (err instanceof GithubAuthError) {
      await markCredentialExpired(ctx.telegramUserId);
      await logActivity(ctx.telegramUserId, operation, "failure", "credential rejected");
      await ctx.reply("Your GitHub session expired or was revoked. Send /login to reconnect.");
    } else if (err instanceof GithubRateLimitError) {
      await logActivity(ctx.telegramUserId, operation, "failure", "rate limited");
      await ctx.reply("GitHub rate limit reached. Try again later.");
    } else if (err instanceof GithubNotFoundError) {
      await logActivity(ctx.telegramUserId, operation, "failure", "not found or not accessible");
      await ctx.reply(
        "That repository or resource is not available to your GitHub App installation. Check /repos.",
      );
    } else if (err instanceof UserFacingError) {
      await logActivity(ctx.telegramUserId, operation, "failure", err.message);
      await ctx.reply(err.message);
    } else {
      console.error(operation, err instanceof Error ? err.name : "unknown");
      await logActivity(ctx.telegramUserId, operation, "failure", "unexpected error").catch(() => undefined);
      await ctx.reply("Something went wrong. Please try again.");
    }
    return undefined;
  }
}
