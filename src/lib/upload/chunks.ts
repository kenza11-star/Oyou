import { CHUNK_LIMITS, UPLOAD_LIMITS } from "./limits";

export interface ChunkPlan {
  index: number;
  start: number;
  end: number; // exclusive
  size: number;
}

/** Splits an archive into contiguous, non-overlapping chunks that cover every byte exactly once. */
export function planChunks(totalBytes: number, chunkBytes: number = CHUNK_LIMITS.defaultBytes): ChunkPlan[] {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) throw new Error("totalBytes must be a positive integer");
  if (totalBytes > UPLOAD_LIMITS.webArchiveBytes) throw new Error("archive exceeds the web upload limit");
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < CHUNK_LIMITS.minBytes || chunkBytes > CHUNK_LIMITS.maxBytes) {
    throw new Error("chunk size is outside the allowed range");
  }
  const count = Math.ceil(totalBytes / chunkBytes);
  if (count > CHUNK_LIMITS.maxChunks) throw new Error("too many chunks for this archive");

  const plans: ChunkPlan[] = [];
  for (let i = 0; i < count; i++) {
    const start = i * chunkBytes;
    const end = Math.min(start + chunkBytes, totalBytes);
    plans.push({ index: i, start, end, size: end - start });
  }
  return plans;
}
