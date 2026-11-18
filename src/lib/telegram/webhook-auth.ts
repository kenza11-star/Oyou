import { timingSafeEqual } from "node:crypto";

/** Verifies the X-Telegram-Bot-Api-Secret-Token header in constant time. */
export function verifyTelegramSecret(received: string | null, expected: string): boolean {
  if (!received) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
