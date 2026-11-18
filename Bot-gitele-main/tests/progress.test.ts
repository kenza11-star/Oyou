import { describe, expect, it } from "vitest";
import { ProgressReporter, etaSeconds, percentFor, renderProgress, throughput, type ProgressState } from "@/lib/telegram/progress";
import { TelegramApiError } from "@/lib/telegram/api";

const base: ProgressState = {
  stage: "uploading_archive",
  repo: "owner/project",
  branch: "main",
  bytesUploaded: 60 * 1024 * 1024,
  bytesTotal: 100 * 1024 * 1024,
  chunksDone: 12,
  chunksTotal: 20,
  filesTotal: null,
  filesProcessed: 0,
  added: 0,
  updated: 0,
  unchanged: 0,
  failed: 0,
  speedBytesPerSec: 3.4 * 1024 * 1024,
  etaSeconds: null,
};

describe("progress math", () => {
  it("returns null when the total is unknown", () => {
    expect(percentFor(5, null)).toBeNull();
    expect(percentFor(5, 0)).toBeNull();
    expect(percentFor(60, 100)).toBe(60);
  });

  it("shows no percentage or ETA it cannot justify", () => {
    const text = renderProgress({ ...base, bytesTotal: null, chunksTotal: null, speedBytesPerSec: null });
    expect(text).not.toMatch(/%/);
    expect(text).not.toMatch(/ETA/);
    expect(text).not.toMatch(/NaN|undefined/);
  });

  it("renders the real byte and chunk counts", () => {
    const text = renderProgress(base);
    expect(text).toContain("60%");
    expect(text).toContain("Uploaded: 60.0 MB / 100.0 MB");
    expect(text).toContain("Chunks: 12 / 20");
    expect(text).toContain("Speed: 3.4 MB/s");
  });

  it("computes throughput only from enough measurements", () => {
    expect(throughput([{ t: 0, bytes: 0 }])).toBeNull();
    expect(throughput([{ t: 0, bytes: 0 }, { t: 1000, bytes: 1000 }])).toBeNull();
    expect(throughput([{ t: 0, bytes: 0 }, { t: 4000, bytes: 4000 }])).toBe(1000);
  });

  it("computes ETA from remaining bytes and speed", () => {
    expect(etaSeconds(1000, 100)).toBe(10);
    expect(etaSeconds(1000, null)).toBeNull();
  });
});

describe("ProgressReporter", () => {
  it("sends once and then edits the same message", async () => {
    let now = 0;
    const sent: string[] = [];
    const edits: number[] = [];
    const r = new ProgressReporter(
      {
        send: async (t) => (sent.push(t), 77),
        edit: async (id) => void edits.push(id),
        now: () => now,
      },
      0,
    );
    await r.update("a");
    now = 10;
    await r.update("b");
    expect(sent).toHaveLength(1);
    expect(edits).toEqual([77]);
  });

  it("throttles edits and flushes the latest text later", async () => {
    let now = 0;
    const texts: string[] = [];
    const r = new ProgressReporter(
      {
        send: async (t) => (texts.push(t), 1),
        edit: async (_id, t) => void texts.push(t),
        now: () => now,
      },
      3000,
    );
    await r.update("first");
    now = 500;
    await r.update("second");
    await r.update("third");
    expect(texts).toEqual(["first"]);
    now = 4000;
    await r.flush();
    expect(texts).toEqual(["first", "third"]);
  });

  it("pauses for retry_after on HTTP 429 and keeps the pending text", async () => {
    let now = 0;
    let fail = true;
    const texts: string[] = [];
    const r = new ProgressReporter(
      {
        send: async (t) => (texts.push(t), 1),
        edit: async (_id, t) => {
          if (fail) throw new TelegramApiError("editMessageText", 429, "Too Many Requests", 5);
          texts.push(t);
        },
        now: () => now,
      },
      0,
    );
    await r.update("start");
    await r.update("progress");
    fail = false;
    now = 2000;
    await r.update("later");
    expect(texts).toEqual(["start"]);
    now = 6000;
    await r.flush();
    expect(texts[texts.length - 1]).toBe("later");
  });
});
