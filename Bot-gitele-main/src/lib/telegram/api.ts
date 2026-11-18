import { readBounded } from "../http/bounded";
export interface InlineKeyboard {
  inline_keyboard: { text: string; callback_data?: string; url?: string }[][];
}

export class TelegramApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly status: number,
    public readonly description: string,
    public readonly retryAfterSec: number | null = null,
  ) {
    super(`Telegram ${method} failed with status ${status}`);
  }
}

const API = "https://api.telegram.org";

async function call<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error_code?: number;
    result?: T;
    description?: string;
    parameters?: { retry_after?: number };
  };
  if (!res.ok || !data.ok) {
    throw new TelegramApiError(
      method,
      data.error_code ?? res.status,
      data.description ?? "",
      data.parameters?.retry_after ?? null,
    );
  }
  return data.result as T;
}

export async function sendMessage(
  token: string,
  chatId: number,
  text: string,
  replyMarkup?: InlineKeyboard,
): Promise<number> {
  const result = await call<{ message_id: number }>(token, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
  return result.message_id;
}

/** Sends a photo by URL with a caption (max 1024 chars). Throws TelegramApiError if Telegram cannot fetch it. */
export async function sendPhoto(
  token: string,
  chatId: number,
  photoUrl: string,
  caption: string,
  replyMarkup?: InlineKeyboard,
): Promise<number> {
  const result = await call<{ message_id: number }>(token, "sendPhoto", {
    chat_id: chatId,
    photo: photoUrl,
    caption: caption.slice(0, 1024),
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
  return result.message_id;
}

/** Edits a message. "message is not modified" is treated as success because the text already matches. */
export async function editMessageText(
  token: string,
  chatId: number,
  messageId: number,
  text: string,
  replyMarkup?: InlineKeyboard,
): Promise<void> {
  try {
    await call(token, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  } catch (err) {
    if (
      err instanceof TelegramApiError &&
      err.description.includes("message is not modified")
    )
      return;
    throw err;
  }
}

export async function answerCallbackQuery(
  token: string,
  callbackId: string,
): Promise<void> {
  await call(token, "answerCallbackQuery", { callback_query_id: callbackId });
}

export async function getFilePath(
  token: string,
  fileId: string,
): Promise<string> {
  const file = await call<{ file_path?: string }>(token, "getFile", {
    file_id: fileId,
  });
  if (!file.file_path)
    throw new Error("Telegram getFile returned no file_path");
  return file.file_path;
}

export async function downloadTelegramFile(
  token: string,
  filePath: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const res = await fetch(`${API}/file/bot${token}/${filePath}`, {
    signal: AbortSignal.timeout(25_000),
    redirect: "error",
  });
  if (!res.ok)
    throw new Error(`Telegram file download failed with status ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > maxBytes)
    throw new Error("Telegram file exceeds the size limit");
  return buf;
}

export async function sendDocument(
  token: string,
  chatId: number,
  filename: string,
  data: Uint8Array,
  caption?: string,
): Promise<void> {
  const safeName =
    filename.replace(/[\u0000-\u001f/\\]/g, "_").slice(0, 120) || "file";
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption.slice(0, 1024));
  form.append("document", new Blob([data as BlobPart]), safeName);
  const res = await fetch(`${API}/bot${token}/sendDocument`, {
    method: "POST",
    body: form,
  });
  if (!res.ok)
    throw new Error(`Telegram sendDocument failed with status ${res.status}`);
}

/** Upload actual GIF bytes, never a fabricated Telegram file_id. */
export async function sendAnimation(
  token: string,
  chatId: number,
  gif: Uint8Array,
  caption: string,
): Promise<void> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", caption);
  form.append(
    "animation",
    new Blob([gif as BlobPart], { type: "image/gif" }),
    "upload-success.gif",
  );
  const res = await fetch(`${API}/bot${token}/sendAnimation`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => null)) as {
    ok?: boolean;
    error_code?: number;
    description?: string;
    parameters?: { retry_after?: number };
  } | null;
  if (!res.ok || !data?.ok)
    throw new TelegramApiError(
      "sendAnimation",
      data?.error_code ?? res.status,
      data?.description ?? "",
      data?.parameters?.retry_after ?? null,
    );
}
