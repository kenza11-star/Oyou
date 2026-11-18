/** Bounded streaming read; cancel the response as soon as its size exceeds the budget. */
export async function readBounded(
  res: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new Error("Invalid download limit");
  if (Number(res.headers.get("content-length")) > maxBytes) {
    await res.body?.cancel();
    throw new Error("The file is too large to process.");
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error("Download returned no body");
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("The file is too large to process.");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}
