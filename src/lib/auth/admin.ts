import type { AppEnv } from "../env";

/** Owner/admin check. Only gates admin commands, never normal bot usage. */
export function isAdmin(env: Pick<AppEnv, "allowedAdminIds">, telegramUserId: string): boolean {
  return env.allowedAdminIds.has(telegramUserId);
}
