import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { db } from "../db";
import {
  sendMessage,
  editMessageText,
  sendAnimation,
  TelegramApiError,
  type InlineKeyboard,
} from "../telegram/api";
import { renderBar, percentFor, formatMB } from "../telegram/progress";
import type { WorkerJob } from "./state";
export interface NoticeJob extends WorkerJob {
  notify_owner: string;
  notify_last_text: string | null;
  notify_sample_at: Date | null;
  notify_sample_bytes: string | null;
  notify_sample_stage: string | null;
  terminal_notified_at: Date | null;
  terminal_message_id: number | null;
  animation_attempted_at: Date | null;
  chunks_done: number;
}
const labels: Record<string, string> = {
  created: "Waiting for browser upload",
  uploading: "Uploading ZIP to private storage",
  uploaded: "Queued for GitHub worker",
  verifying: "Verifying stored chunks",
  extracting: "Extracting ZIP",
  validating: "Validating project files",
  comparing: "Comparing repository files",
  uploading_blobs: "Uploading GitHub files",
  creating_commit: "Creating GitHub tree and commit",
  updating_branch: "Publishing and confirming branch",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  expired: "Expired",
};
export function notificationText(job: NoticeJob, now = Date.now()): string {
  const confirmed =
    job.status === "completed" && Boolean(job.github_confirmed_at);
  const stage =
    job.status === "processing"
      ? (job.processing_stage ?? "verifying")
      : job.status;
  if (job.status === "completed" && !confirmed)
    return "Waiting for remote GitHub confirmation.";
  const lines = [
    confirmed
      ? job.commit_sha
        ? "✅ UPLOAD COMPLETED"
        : "✅ ALREADY UP TO DATE"
      : ["failed", "expired"].includes(job.status)
        ? "❌ UPLOAD FAILED"
        : job.status === "cancelled"
          ? "UPLOAD CANCELLED"
          : "UPLOADING TO GITHUB",
    "",
    `Repository: ${job.repo_full_name}`,
    `Branch: ${job.branch}`,
    "",
    `Stage: ${labels[stage] ?? stage}`,
  ];
  const upload = ["created", "uploading"].includes(stage);
  const pct = upload
    ? percentFor(Number(job.bytes_received), Number(job.total_bytes))
    : percentFor(job.files_processed, job.files_total);
  if (pct !== null)
    lines.push(
      `${renderBar(pct)} ${pct}%${upload ? " of ZIP verified" : " of files processed"}`,
    );
  lines.push(
    `ZIP verified: ${formatMB(Number(job.bytes_received))} / ${formatMB(Number(job.total_bytes))}`,
    `Completed chunks: ${job.chunks_done} / ${job.chunk_count}`,
    `Extracted files: ${job.files_extracted}`,
  );
  if (job.files_total !== null)
    lines.push(
      `Files processed: ${job.files_processed} / ${job.files_total}`,
      `Added: ${job.files_added}  Updated: ${job.files_updated}  Unchanged: ${job.files_unchanged}`,
    );
  if (stage === "uploading_blobs")
    lines.push(
      `Git blob bytes acknowledged: ${formatMB(Number(job.github_bytes_uploaded))} / ${formatMB(Number(job.github_bytes_total))}`,
    );
  const bytes = upload
      ? Number(job.bytes_received)
      : Number(job.github_bytes_uploaded),
    total = upload ? Number(job.total_bytes) : Number(job.github_bytes_total);
  const span = job.notify_sample_at
    ? now - new Date(job.notify_sample_at).getTime()
    : 0;
  if (
    (upload || stage === "uploading_blobs") &&
    job.notify_sample_stage === stage &&
    span >= 2000 &&
    span <= 30000 &&
    job.notify_sample_bytes !== null
  ) {
    const rate = (bytes - Number(job.notify_sample_bytes)) / (span / 1000);
    if (rate > 0) {
      lines.push(`Measured speed: ${formatMB(rate)}/s`);
      if (total > bytes)
        lines.push(
          `ETA for this transfer: about ${Math.ceil((total - bytes) / rate)} s`,
        );
    }
  }
  if (confirmed) {
    lines.push(
      "",
      job.commit_sha
        ? `Commit: ${job.commit_sha.slice(0, 7)}\nSuccessfully pushed to GitHub!`
        : "Already up to date. No commit was created.",
    );
  } else if (["failed", "expired"].includes(job.status))
    lines.push(
      "",
      `Failure: ${job.error ?? (job.status === "expired" ? "Upload expired. Open /upload privately and choose the file again." : "Processing failed; inspect worker logs with this job ID.")}`,
    );
  else if (job.status === "cancelled")
    lines.push("Cancelled. No further GitHub operations will be started.");
  else {
    if (job.error) lines.push("", job.error);
    lines.push("", "Not committed until the final GitHub confirmation.");
  }
  lines.push(`Job: ${job.id}`);
  return lines.join("\n");
}
function buttons(job: NoticeJob): InlineKeyboard {
  const repo = `https://github.com/${job.repo_full_name.split("/").map(encodeURIComponent).join("/")}`;
  const rows: { text: string; url?: string; callback_data?: string }[][] = [];
  if (job.status === "completed" && job.github_confirmed_at) {
    if (job.commit_sha)
      rows.push([
        { text: "View Commit", url: `${repo}/commit/${job.commit_sha}` },
      ]);
    rows.push([{ text: "Open Repository", url: repo }]);
  } else if (
    ["created", "uploading", "uploaded", "processing"].includes(job.status) &&
    !job.publish_started_at
  ) {
    rows.push([
      { text: "Cancel upload", callback_data: `upload_cancel:${job.id}` },
    ]);
  }
  return { inline_keyboard: rows };
}
async function slot(chatId: number): Promise<boolean> {
  // Shared across worker replicas. 3 sec/chat and 25 calls/sec/bot.
  const reserve = async (id: number, ms: number) =>
    (
      await db().query(
        `insert into app.worker_notify_chats(chat_id,next_allowed_at) values ($1,now()+$2*interval '1 millisecond')
 on conflict(chat_id) do update set next_allowed_at=excluded.next_allowed_at where app.worker_notify_chats.next_allowed_at<=now() returning chat_id`,
        [id, ms],
      )
    ).rows.length > 0;
  return (await reserve(chatId, 3000)) && (await reserve(0, 40));
}
async function claimNotice(): Promise<NoticeJob | null> {
  const owner = randomUUID();
  const { rows } = await db().query<NoticeJob>(
    `update app.upload_jobs set notify_owner=$1,notify_lease_until=now()+interval '30 seconds'
 where id=(select id from app.upload_jobs where repo_full_name is not null and chunk_count is not null
 and status in ('created','uploading','uploaded','processing','completed','failed','cancelled','expired')
 and (terminal_notified_at is null or (status='completed' and animation_attempted_at is null))
 and notify_after<=now() and (notify_lease_until is null or notify_lease_until<now())
 order by notify_after,created_at for update skip locked limit 1) returning *`,
    [owner],
  );
  if (!rows[0]) return null;
  const chunks = await db().query<{ n: string }>(
    "select count(*) as n from app.upload_job_chunks where job_id=$1 and status='verified'",
    [rows[0].id],
  );
  return { ...rows[0], chunks_done: Number(chunks.rows[0].n) };
}
async function saveNotice(
  job: NoticeJob,
  fields: Record<string, unknown>,
  wait = 3000,
): Promise<void> {
  const allowed = new Set([
    "telegram_message_id",
    "notify_last_text",
    "notify_sample_at",
    "notify_sample_bytes",
    "notify_sample_stage",
    "terminal_notified_at",
    "terminal_message_id",
    "animation_attempted_at",
  ]);
  const entries = Object.entries(fields);
  if (entries.some(([k]) => !allowed.has(k)))
    throw new Error("Invalid notice checkpoint");
  await db().query(
    `update app.upload_jobs set notify_owner=null,notify_lease_until=null,notify_after=now()+$3*interval '1 millisecond'${entries.map(([k], i) => `,${k}=$${i + 4}`).join("")}
 where id=$1 and notify_owner=$2 and notify_lease_until>now()`,
    [job.id, job.notify_owner, wait, ...entries.map(([, v]) => v)],
  );
}
/** One action per claim; progress and terminal delivery state survives restarts. */
export async function deliverOneNotice(botToken: string): Promise<boolean> {
  const job = await claimNotice();
  if (!job) return false;
  // This project issues only private upload links. Never send progress to a stored group chat.
  const chatId = Number(job.telegram_user_id),
    text = notificationText(job),
    keyboard = buttons(job);
  const stage =
    job.status === "processing"
      ? (job.processing_stage ?? "verifying")
      : job.status;
  const bytes = ["created", "uploading"].includes(stage)
    ? job.bytes_received
    : job.github_bytes_uploaded;
  const sample = {
    notify_sample_at: new Date(),
    notify_sample_bytes: bytes,
    notify_sample_stage: stage,
  };
  const terminal = ["completed", "failed", "cancelled", "expired"].includes(
    job.status,
  );
  try {
    if (job.status === "completed" && !job.github_confirmed_at) {
      await saveNotice(job, {}, 60_000);
      return true;
    }
    if (!(await slot(chatId))) {
      await saveNotice(job, {}, 1000);
      return true;
    }
    if (terminal && job.terminal_notified_at) {
      // Optional decoration is at-most-once. Text delivery already succeeded independently.
      const claimed = await db().query(
        "update app.upload_jobs set animation_attempted_at=now() where id=$1 and notify_owner=$2 and notify_lease_until>now() and animation_attempted_at is null returning id",
        [job.id, job.notify_owner],
      );
      if (!claimed.rows.length) return true;
      if (job.status === "completed" && job.commit_sha) {
        try {
          const gif = await readFile(
            resolve(process.cwd(), "assets/upload-success.gif"),
          );
          await sendAnimation(
            botToken,
            chatId,
            gif,
            "Upload confirmed on GitHub",
          );
        } catch {
          console.error("success animation unavailable", job.id);
        }
      }
      await saveNotice(job, {}, 86400_000);
      return true;
    }
    if (job.telegram_message_id && text !== job.notify_last_text) {
      await editMessageText(
        botToken,
        chatId,
        Number(job.telegram_message_id),
        text,
        keyboard,
      );
      await saveNotice(job, { notify_last_text: text, ...sample });
      return true;
    }
    if (terminal) {
      const id = await sendMessage(botToken, chatId, text, keyboard);
      await saveNotice(job, {
        telegram_message_id: job.telegram_message_id ?? id,
        terminal_message_id: id,
        terminal_notified_at: new Date(),
        notify_last_text: text,
        ...sample,
      });
      return true;
    }
    if (!job.telegram_message_id) {
      const id = await sendMessage(botToken, chatId, text, keyboard);
      await saveNotice(job, {
        telegram_message_id: id,
        notify_last_text: text,
        ...sample,
      });
      return true;
    }
    await saveNotice(job, sample);
  } catch (err) {
    if (err instanceof TelegramApiError && err.retryAfterSec !== null) {
      await saveNotice(job, {}, Math.max(3000, err.retryAfterSec * 1000));
    } else if (
      err instanceof TelegramApiError &&
      err.status === 400 &&
      /message to edit not found|message can't be edited/i.test(err.description)
    ) {
      await saveNotice(job, { telegram_message_id: null });
    } else {
      console.error(
        "telegram delivery",
        job.id,
        err instanceof Error ? err.name : "unknown",
      );
      await saveNotice(
        job,
        {},
        err instanceof TelegramApiError && err.status === 403
          ? 86400_000
          : 10_000,
      );
    }
  }
  return true;
}
