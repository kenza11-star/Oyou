/** Pure display helpers (Indonesian). Kept free of React so they can be unit tested. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2).replace(".", ",")} ${units[i]}`;
}

export function formatTime(iso: string | null, now = Date.now()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const s = Math.round((now - t) / 1000);
  if (s >= 0 && s < 60) return "baru saja";
  if (s >= 60 && s < 3600) return `${Math.floor(s / 60)} menit lalu`;
  if (s >= 3600 && s < 86400) return `${Math.floor(s / 3600)} jam lalu`;
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" }).format(new Date(t));
}

export type Tone = "ok" | "bad" | "warn" | "run" | "idle";
export function statusInfo(status: string, stage?: string | null): { label: string; tone: Tone; open: boolean } {
  const stages: Record<string, string> = {
    verifying: "Memverifikasi ZIP",
    extracting: "Mengekstrak",
    validating: "Memvalidasi file",
    comparing: "Membandingkan dengan repositori",
    uploading_blobs: "Mengirim file ke GitHub",
    creating_commit: "Membuat commit",
    updating_branch: "Menunggu konfirmasi GitHub",
  };
  switch (status) {
    case "created": return { label: "Menunggu unggahan", tone: "idle", open: true };
    case "uploading": return { label: "Mengunggah", tone: "run", open: true };
    case "uploaded": return { label: "Mengirim ke GitHub", tone: "run", open: true };
    case "processing": return { label: stage ? (stages[stage] ?? "Memproses") : "Memproses", tone: "run", open: true };
    case "completed": return { label: "Selesai", tone: "ok", open: false };
    case "failed": return { label: "Gagal", tone: "bad", open: false };
    case "cancelled": return { label: "Dibatalkan", tone: "idle", open: false };
    case "expired": return { label: "Kedaluwarsa", tone: "warn", open: false };
    default: return { label: status, tone: "idle", open: false };
  }
}

/** Returns null when progress is not measurable, so the UI shows an honest indeterminate bar. */
export function jobProgress(j: { status: string; stage: string | null; totalBytes: number; bytesVerified: number; filesTotal: number | null; filesProcessed: number }): number | null {
  if (["created", "uploading"].includes(j.status)) return j.totalBytes > 0 ? Math.min(100, Math.floor((j.bytesVerified / j.totalBytes) * 100)) : null;
  if (j.status === "processing" && j.filesTotal && j.filesTotal > 0) return Math.min(100, Math.floor((j.filesProcessed / j.filesTotal) * 100));
  return null;
}

export function runLabel(label: string): { text: string; tone: Tone } {
  const map: Record<string, [string, Tone]> = {
    Success: ["Berhasil", "ok"], Failed: ["Gagal", "bad"], Cancelled: ["Dibatalkan", "idle"],
    "In progress": ["Berjalan", "run"], Queued: ["Antre", "run"], Skipped: ["Dilewati", "idle"],
  };
  const m = map[label];
  return m ? { text: m[0], tone: m[1] } : { text: label, tone: "idle" };
}
