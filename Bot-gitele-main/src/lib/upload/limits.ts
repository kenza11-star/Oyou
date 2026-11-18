const MiB = 1024 * 1024;

export const UPLOAD_LIMITS = {
  /** Telegram Bot API downloads files up to 20 MB. Larger archives use the web uploader. */
  telegramArchiveBytes: 20 * MiB,
  /** Maximum ZIP accepted through the web uploader. */
  webArchiveBytes: 100 * MiB,
  files: 20_000,
  /** Total uncompressed size. Kept bounded so extraction fits in function memory. */
  totalBytes: 300 * MiB,
  /** GitHub rejects blobs above 100 MB. */
  fileBytes: 100 * MiB,
  maxRatio: 100,
} as const;

/** Supabase Free allows 50 MB per object. Chunks stay well below it. */
export const CHUNK_LIMITS = {
  minBytes: 1 * MiB,
  defaultBytes: 8 * MiB,
  maxBytes: 45 * MiB,
  maxChunks: 200,
} as const;
