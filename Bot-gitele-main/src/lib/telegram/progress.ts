import { TelegramApiError } from "./api";

export type Stage =
  | "preparing"
  | "uploading_archive"
  | "verifying"
  | "extracting"
  | "validating"
  | "comparing"
  | "uploading_blobs"
  | "creating_commit"
  | "updating_branch"
  | "completed"
  | "failed"
  | "cancelled";

export const STAGE_LABEL: Record<Stage, string> = {
  preparing: "Preparing",
  uploading_archive: "Uploading ZIP",
  verifying: "Verifying upload",
  extracting: "Extracting ZIP",
  validating: "Validating files",
  comparing: "Comparing GitHub files",
  uploading_blobs: "Uploading Git blobs",
  creating_commit: "Creating commit",
  updating_branch: "Updating branch",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export interface ProgressState {
  stage: Stage;
  repo: string;
  branch: string;
  bytesUploaded: number;
  bytesTotal: number | null;
  chunksDone: number;
  chunksTotal: number | null;
  filesTotal: number | null;
  filesProcessed: number;
  added: number;
  updated: number;
  unchanged: number;
  failed: number;
  speedBytesPerSec: number | null;
  etaSeconds: number | null;
  detail?: string;
}

/** Returns null when the total is unknown. Never invents a percentage. */
export function percentFor(done: number, total: number | null): number | null {
  if (total === null || total <= 0) return null;
  return Math.min(100, Math.floor((done / total) * 100));
}

export function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function renderBar(pct: number | null, width = 10): string {
  if (pct === null) return "";
  const filled = Math.round((pct / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export interface Sample {
  t: number; // ms
  bytes: number; // cumulative
}

/** Average speed over the window, or null when there are not enough measurements. */
export function throughput(samples: Sample[], minSpanMs = 2000): number | null {
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const span = last.t - first.t;
  if (span < minSpanMs) return null;
  return ((last.bytes - first.bytes) / span) * 1000;
}

export function etaSeconds(remainingBytes: number | null, speedBytesPerSec: number | null): number | null {
  if (remainingBytes === null || speedBytesPerSec === null || speedBytesPerSec <= 0) return null;
  return Math.ceil(remainingBytes / speedBytesPerSec);
}

export function renderProgress(s: ProgressState): string {
  const pct = s.stage === "uploading_archive" ? percentFor(s.bytesUploaded, s.bytesTotal) : percentFor(s.filesProcessed, s.filesTotal);
  const lines: string[] = [
    "Uploading Project",
    "",
    `Repository: ${s.repo}`,
    `Branch: ${s.branch}`,
    "",
    `Stage: ${STAGE_LABEL[s.stage]}`,
  ];
  if (pct !== null) lines.push(`${renderBar(pct)} ${pct}%`);
  if (s.bytesTotal !== null) lines.push(`Uploaded: ${formatMB(s.bytesUploaded)} / ${formatMB(s.bytesTotal)}`);
  if (s.chunksTotal !== null) lines.push(`Chunks: ${s.chunksDone} / ${s.chunksTotal}`);
  if (s.speedBytesPerSec !== null) {
    lines.push(`Speed: ${formatMB(s.speedBytesPerSec)}/s`);
  }
  const eta = etaSeconds(
    s.bytesTotal === null ? null : s.bytesTotal - s.bytesUploaded,
    s.speedBytesPerSec,
  );
  if (eta !== null) lines.push(`ETA: about ${eta} s`);
  if (s.filesTotal !== null) lines.push(`Files processed: ${s.filesProcessed} / ${s.filesTotal}`);
  if (s.stage === "completed" || s.filesTotal !== null) {
    lines.push(`Added: ${s.added}  Updated: ${s.updated}  Unchanged: ${s.unchanged}  Failed: ${s.failed}`);
  }
  if (s.detail) lines.push("", s.detail);
  return lines.join("\n");
}

export interface ReporterDeps {
  send(text: string): Promise<number>;
  edit(messageId: number, text: string): Promise<void>;
  now(): number;
}

/**
 * Creates one Telegram message and edits it afterwards. Edits are throttled, and a 429 response
 * pauses edits for retry_after seconds. Call flush(true) at the end so the final state is always sent.
 */
export class ProgressReporter {
  private messageId: number | null = null;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private blockedUntil = 0;
  private pending: string | null = null;
  private lastSentText = "";

  constructor(
    private readonly deps: ReporterDeps,
    private readonly minIntervalMs = 3000,
  ) {}

  async update(text: string): Promise<void> {
    if (text === this.lastSentText) return;
    this.pending = text;
    const earliest = Math.max(this.lastSentAt + this.minIntervalMs, this.blockedUntil);
    if (this.deps.now() < earliest) return;
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.pending === null) return;
    const text = this.pending;
    const now = this.deps.now();
    try {
      if (this.messageId === null) {
        this.messageId = await this.deps.send(text);
      } else {
        await this.deps.edit(this.messageId, text);
      }
      this.pending = null;
      this.lastSentText = text;
      this.lastSentAt = now;
    } catch (err) {
      if (err instanceof TelegramApiError && err.retryAfterSec !== null) {
        this.blockedUntil = now + err.retryAfterSec * 1000;
        return; // keep pending; it is retried on the next update or flush
      }
      throw err;
    }
  }
}
