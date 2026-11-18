"use client";

import { useEffect, useRef, useState } from "react";
import { SendFlow } from "../app/send-flow";
import { buildArchive, fromDrop, fromFolderInput, type PickedItem } from "@/lib/upload/package";
import {
  AdaptiveConcurrency,
  HttpError,
  runPool,
  withRetry,
} from "@/lib/transfer/engine";
import { throughput, type Sample } from "@/lib/telegram/progress";
import { resumeStorageKey, type ResumeScope } from "@/lib/upload/resume";
import { CHUNK_LIMITS, UPLOAD_LIMITS } from "@/lib/upload/limits";

const START_CONCURRENCY = 10;
const MIN_CONCURRENCY = 2;
const MAX_CONCURRENCY = 32;
const MB = 1024 * 1024;
const processingLabels: Record<string, string> = {
  verifying: "Memverifikasi ZIP",
  extracting: "Mengekstrak file proyek",
  validating: "Memvalidasi file",
  comparing: "Membandingkan dengan repositori",
  uploading_blobs: "Mengirim file ke GitHub",
  creating_commit: "Membuat commit",
  updating_branch: "Menunggu konfirmasi GitHub",
};

interface ChunkInfo {
  index: number;
  size: number;
  status: string;
}

interface JobSummary {
  id: string;
  status: string;
  fileName: string;
  repoFullName: string;
  branch: string;
  totalBytes: number;
  chunkSize: number;
  chunkCount: number;
  bytesVerified: number;
  chunks: ChunkInfo[];
  missing: number[];
  stage?: string | null;
  filesTotal?: number | null;
  filesProcessed?: number;
  filesExtracted?: number;
  added?: number;
  updated?: number;
  unchanged?: number;
  commitSha?: string | null;
  commitUrl?: string | null;
  error?: string | null;
  canCancel?: boolean;
}

type Phase =
  | "idle"
  | "preparing"
  | "uploading"
  | "finishing"
  | "processing"
  | "completed"
  | "ready"
  | "error"
  | "cancelled";

/** An HTTP failure carrying the server's message and Retry-After hint. */
class ApiError extends HttpError {
  constructor(status: number, retryAfterMs: number | null, message: string) {
    super(status, retryAfterMs);
    this.message = message;
  }
}

function retryAfterMs(res: {
  headers: { get(name: string): string | null };
}): number | null {
  const v = res.headers.get("retry-after");
  if (!v) return null;
  const seconds = Number(v);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

async function api<T>(
  method: string,
  path: string,
  token: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
  } & Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      retryAfterMs(res),
      data.error ?? `Request failed (${res.status})`,
    );
  }
  return data as T;
}

/** PUTs one chunk to its signed URL and reports real bytes sent. XHR is used because fetch cannot report upload progress. */
function putChunk(
  url: string,
  body: ArrayBuffer,
  onProgress: (loaded: number) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.timeout = 120_000;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded);
    };
    xhr.onload = () => {
      signal.removeEventListener("abort", onAbort);
      if ((xhr.status >= 200 && xhr.status < 300) || xhr.status === 409) {
        resolve();
      } else {
        const hint = xhr.getResponseHeader("retry-after");
        const seconds = hint ? Number(hint) : NaN;
        reject(
          new ApiError(
            [400, 401, 403].includes(xhr.status) ? 425 : xhr.status,
            Number.isFinite(seconds) ? seconds * 1000 : null,
            `Storage rejected the chunk (${xhr.status})`,
          ),
        );
      }
    };
    xhr.onerror = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new TypeError("Network error during chunk upload"));
    };
    xhr.ontimeout = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new TypeError("Chunk upload timed out"));
    };
    xhr.onabort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error("cancelled"));
    };
    const onAbort = () => xhr.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    xhr.send(body);
  });
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

function chunkBytes(job: JobSummary, index: number): number {
  const start = index * job.chunkSize;
  return Math.min(job.chunkSize, job.totalBytes - start);
}

function resumeKey(storageKey: string): string {
  try {
    const existing = window.localStorage.getItem(storageKey);
    if (
      existing &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        existing,
      )
    )
      return existing;
    const fresh = crypto.randomUUID();
    window.localStorage.setItem(storageKey, fresh);
    return fresh;
  } catch {
    return crypto.randomUUID();
  }
}
function clearResumeKey(storageKey: string): void {
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    /* optional persistence */
  }
}

function messageFor(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof TypeError)
    return "Masalah jaringan. Periksa koneksi, lalu tekan Coba lagi.";
  if (err instanceof Error && err.message === "cancelled")
    return "Unggahan dibatalkan.";
  return "Terjadi kesalahan tak terduga. Tekan Coba lagi untuk melanjutkan.";
}

const CSS = `
  .up{max-width:680px;margin:0 auto}
  .up.page{padding:28px 16px 64px;min-height:100dvh}
  .up .brandlink{display:inline-flex;align-items:center;gap:10px;font-weight:650;font-size:16px;color:var(--text,#f5f6f8);text-decoration:none;margin-bottom:30px}
  .up .brandlink:hover{text-decoration:none;color:var(--text,#f5f6f8)}
  .up .brandlink:hover .mark{transform:rotate(-12deg) scale(1.12)}
  .up h1{font-size:30px;font-weight:700;margin:0 0 10px;letter-spacing:-.03em;line-height:1.15;background:linear-gradient(180deg,#fff 30%,#9aa3b2);-webkit-background-clip:text;background-clip:text;color:transparent;animation:rise .7s var(--ease,ease) both}
  .up .lead{color:var(--text-2,#a4aab5);font-size:15px;line-height:1.65;margin:0 0 26px;animation:rise .7s .08s var(--ease,ease) both}
  .up .muted{color:var(--text-2,#a4aab5);font-size:13px;line-height:1.55;margin:0 0 16px}
  .up .card{position:relative;border:1px solid var(--border,rgba(255,255,255,.08));border-radius:22px;padding:18px;margin-bottom:16px;background:var(--glass);-webkit-backdrop-filter:var(--blur);backdrop-filter:var(--blur);box-shadow:inset 0 1px 0 rgba(255,255,255,.11),0 18px 50px -20px rgba(0,0,0,.95);animation:rise .6s var(--ease,ease) both}
  .up .card h2{font-size:11px;font-weight:650;letter-spacing:.1em;text-transform:uppercase;color:var(--text-3,#6b717c);margin:0 0 14px}
  .up .target{display:grid;gap:12px}
  .up .target .line{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;font-size:14px}
  .up .target .line>span:first-child{color:var(--text-2,#a4aab5)}
  .up .pill{display:inline-flex;align-items:center;max-width:100%;padding:5px 13px;border:1px solid var(--border-strong,rgba(255,255,255,.15));border-radius:999px;background:rgba(255,255,255,.06);font-size:13px;overflow-wrap:anywhere;transition:transform .4s var(--spring,ease),border-color .25s}
  .up .pill:hover{transform:translateY(-2px);border-color:rgba(120,180,255,.5)}
  .up .btn{position:relative;overflow:hidden;background:rgba(255,255,255,.06);color:var(--text,#f5f6f8);border:1px solid var(--border-strong,rgba(255,255,255,.15));border-radius:999px;padding:9px 22px;font-size:14px;font-weight:500;cursor:pointer;min-height:46px;font-family:inherit;transition:transform .4s var(--spring,ease),background .25s,border-color .25s}
  .up .btn:hover:not(:disabled){background:rgba(255,255,255,.11);border-color:rgba(255,255,255,.28);transform:translateY(-2px)}
  .up .btn:active:not(:disabled){transform:scale(.94);transition-duration:.12s}
  .up .btn:focus-visible,.up .drop:focus-within{outline:2px solid var(--accent,#5aa5ff);outline-offset:3px}
  .up .btn:disabled{opacity:.45;cursor:not-allowed}
  .up .btn.primary{background:linear-gradient(180deg,#6fb2ff,var(--accent-2,#2f6fe8));border-color:rgba(160,205,255,.55);color:#fff;font-weight:650;box-shadow:0 10px 28px -8px rgba(47,111,232,.85),inset 0 1px 0 rgba(255,255,255,.35)}
  .up .drop{--ang:0deg;position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;text-align:center;border:1.5px dashed rgba(255,255,255,.22);border-radius:26px;padding:44px 16px;margin-bottom:16px;cursor:pointer;color:var(--text-2,#a4aab5);font-size:14px;background:var(--glass);-webkit-backdrop-filter:var(--blur);backdrop-filter:var(--blur);transition:transform .5s var(--spring,ease),border-color .25s,background .25s,box-shadow .3s;animation:rise .6s .05s var(--ease,ease) both}
  .up .drop::before{content:"";position:absolute;inset:-1.5px;border-radius:inherit;padding:1.5px;background:conic-gradient(from var(--ang),transparent 0 60%,rgba(90,165,255,.95) 80%,transparent 100%);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;opacity:0;transition:opacity .3s;pointer-events:none}
  .up .drop:hover:not(.disabled){transform:translateY(-3px);box-shadow:0 20px 50px -18px rgba(47,111,232,.6)}
  .up .drop:hover:not(.disabled)::before,.up .drop.over::before{opacity:1;animation:turn 3s linear infinite}
  @keyframes turn{to{--ang:360deg}}
  .up .drop svg{width:46px;height:46px;color:var(--accent,#5aa5ff);margin-bottom:8px;filter:drop-shadow(0 0 14px rgba(90,165,255,.6));animation:float 3.4s ease-in-out infinite}
  .up .drop:active:not(.disabled){transform:scale(.97)}
  .up .drop strong{color:var(--text,#f5f6f8);font-weight:650;font-size:17px}
  .up .drop .hint{display:inline-block;margin-top:10px;padding:3px 12px;border-radius:999px;background:rgba(255,255,255,.07);color:var(--text-3,#6b717c);font-size:12px}
  .up .drop.over{border-color:transparent;background:rgba(90,165,255,.1);transform:scale(1.025)}
  .up .drop.over svg{animation:float .7s ease-in-out infinite}
  .up .drop.disabled{opacity:.5;cursor:not-allowed}
  .up .drop input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
  .up .head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:4px}
  .up .status{font-size:14px;font-weight:600}
  .up .big{font-size:34px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.03em;background:linear-gradient(180deg,#fff,#8cc4ff);-webkit-background-clip:text;background-clip:text;color:transparent}
  .up .bar{height:10px;background:rgba(255,255,255,.08);border-radius:999px;overflow:hidden;margin:12px 0 18px}
  .up .bar>div{height:100%;background:linear-gradient(90deg,var(--accent-2,#2f6fe8),#8cc4ff);border-radius:999px;box-shadow:0 0 16px rgba(90,165,255,.75);transition:width .2s linear}
  .up .stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
  .up .stat{padding:12px 14px;border-radius:16px;background:rgba(255,255,255,.05);border:1px solid var(--border,rgba(255,255,255,.08));transition:transform .4s var(--spring,ease),background .25s}
  .up .stat:hover{transform:translateY(-3px);background:rgba(255,255,255,.08)}
  .up .stat span{display:block;font-size:12px;color:var(--text-3,#6b717c)}
  .up .stat b{display:block;font-size:14px;font-weight:600;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
  .up .error,.up .ok,.up .info{border:1px solid var(--border-strong,rgba(255,255,255,.15));border-left-width:3px;border-radius:16px;padding:13px 16px;font-size:14px;line-height:1.55;margin:0 0 16px;background:var(--glass);-webkit-backdrop-filter:var(--blur);backdrop-filter:var(--blur);animation:rise .5s var(--ease,ease) both}
  .up .error{border-left-color:var(--danger,#ff7b7b)}
  .up .ok{border-left-color:var(--success,#5fdc95)}
  .up .info{border-left-color:var(--accent,#5aa5ff);color:var(--text-2,#a4aab5)}
  .up .actions{display:flex;gap:8px;flex-wrap:wrap;margin:4px 0 16px}
  .up .check{width:20px;height:20px;vertical-align:-4px;margin-right:6px}
  .up .check path{stroke-dasharray:24;stroke-dashoffset:24;animation:draw .5s ease-out forwards}
  @keyframes draw{to{stroke-dashoffset:0}}
  @media (prefers-reduced-motion:reduce){.up .check path{animation:none;stroke-dashoffset:0}.up .bar>div{transition:none}}
  @media (max-width:420px){.up .btn{flex:1 1 100%}.up h1{font-size:25px}}
`;

export default function Uploader({
  initialToken,
  embedded = false,
}: {
  /** Dashboard flow: an upload token already bound to one verified repository and branch. */
  initialToken?: string;
  embedded?: boolean;
} = {}) {
  const [token, setToken] = useState<string | null>(null);
  const [scope, setScope] = useState<ResumeScope | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [job, setJob] = useState<JobSummary | null>(null);
  const [bytesDone, setBytesDone] = useState(0);
  const [speed, setSpeed] = useState<number | null>(null);
  const [concurrency, setConcurrency] = useState(START_CONCURRENCY);
  const [chunksDone, setChunksDone] = useState(0);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [mode, setMode] = useState<"file" | "folder">("file");
  const [strip, setStrip] = useState(false);
  const [packing, setPacking] = useState(false);

  const resumeStorageRef = useRef<string | null>(null);
  const jobRef = useRef<JobSummary | null>(null);
  const fileRef = useRef<File | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const controllerRef = useRef<AdaptiveConcurrency | null>(null);
  const loadedRef = useRef<Map<number, number>>(new Map());
  const verifiedRef = useRef<Set<number>>(new Set());
  const samplesRef = useRef<Sample[]>([]);

  // Read the session token from the URL fragment, then remove it from the address bar.
  useEffect(() => {
    if (initialToken) return () => abortRef.current?.abort();
    let t = new URLSearchParams(window.location.hash.slice(1)).get("t");
    try {
      if (t) window.sessionStorage.setItem("gm-upload-session", t);
      else t = window.sessionStorage.getItem("gm-upload-session");
    } catch {
      /* Tokens stay in memory if storage is unavailable. */
    }
    if (t) {
      setToken(t);
      let last: string | null = null;
      try {
        last = window.sessionStorage.getItem("gm-upload-last-job");
      } catch {}
      if (last && /^[0-9a-f-]{36}$/i.test(last))
        void api<JobSummary>("GET", `/api/upload/jobs/${last}`, t)
          .then((summary) => {
            setJob(summary);
            jobRef.current = summary;
            if (["uploaded", "processing"].includes(summary.status))
              setPhase("processing");
            else if (summary.status === "completed") setPhase("completed");
            else if (["failed", "expired"].includes(summary.status)) {
              setPhase("error");
              setErrorText(summary.error ?? "Pemrosesan GitHub gagal");
            }
          })
          .catch(() => {});
      window.history.replaceState(null, "", window.location.pathname);
    } else {
      setNotice(
        "Halaman ini dibuka lewat tombol Upload di bot Telegram, atau lewat dashboard setelah memilih repositori.",
      );
    }
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!initialToken) return;
    setToken(initialToken);
    setNotice(null);
  }, [initialToken]);

  useEffect(() => {
    if (!token) return;
    const abort = new AbortController();
    setScope(null);
    void api<ResumeScope>(
      "GET",
      "/api/upload/context",
      token,
      undefined,
      abort.signal,
    )
      .then(setScope)
      .catch((err) => {
        if (!abort.signal.aborted) setNotice(messageFor(err));
      });
    return () => abort.abort();
  }, [token]);

  // Real progress: sums the bytes each chunk has actually sent or verified.
  useEffect(() => {
    if (phase !== "uploading") return;
    const id = window.setInterval(() => {
      const done = Array.from(loadedRef.current.values()).reduce(
        (s, n) => s + n,
        0,
      );
      const now = Date.now();
      samplesRef.current = [
        ...samplesRef.current,
        { t: now, bytes: done },
      ].filter((s) => now - s.t <= 15_000);
      setBytesDone(done);
      setSpeed(throughput(samplesRef.current));
      setConcurrency(controllerRef.current?.limit ?? START_CONCURRENCY);
    }, 250);
    return () => window.clearInterval(id);
  }, [phase]);

  // Background work is durable; polling only displays its persisted state.
  useEffect(() => {
    if (!job || !token || !["uploaded", "processing"].includes(job.status))
      return;
    const abort = new AbortController();
    const id = window.setInterval(() => {
      void api<JobSummary>(
        "GET",
        `/api/upload/jobs/${job.id}`,
        token,
        undefined,
        abort.signal,
      )
        .then((current) => {
          jobRef.current = current;
          setJob(current);
          if (current.status === "completed") {
            setPhase("completed");
            if (resumeStorageRef.current)
              clearResumeKey(resumeStorageRef.current);
          } else if (["failed", "expired"].includes(current.status)) {
            setPhase("error");
            setErrorText(current.error ?? "Pemrosesan GitHub gagal");
          } else if (current.status === "cancelled") {
            setPhase("cancelled");
            setErrorText("Unggahan dibatalkan.");
          } else setPhase("processing");
        })
        .catch((err) => {
          if (err instanceof ApiError && err.status === 401) {
            setNotice(
              "Tautan browser ini kedaluwarsa. Pemrosesan tetap berjalan; cek Telegram atau buka tautan /upload yang baru.",
            );
            window.clearInterval(id);
          }
        });
    }, 1500);
    return () => {
      window.clearInterval(id);
      abort.abort();
    };
  }, [job?.id, job?.status, token]);

  async function uploadChunk(
    summary: JobSummary,
    file: File,
    index: number,
    tok: string,
    abort: AbortController,
  ) {
    const size = chunkBytes(summary, index);
    const start = index * summary.chunkSize;
    const body = await file.slice(start, start + size).arrayBuffer();
    const sha = await sha256Hex(body);

    await withRetry(
      async () => {
        loadedRef.current.set(index, 0);
        const signed = await api<{
          verified: boolean;
          url?: string;
          attemptId?: string;
        }>(
          "POST",
          `/api/upload/jobs/${summary.id}/chunks/${index}/sign`,
          tok,
          undefined,
          abort.signal,
        );
        if (!signed.verified) {
          if (!signed.url) throw new Error("Server returned no upload URL");
          await putChunk(
            signed.url,
            body,
            (loaded) => loadedRef.current.set(index, loaded),
            abort.signal,
          );
          try {
            // Retry verification without uploading bytes again after an ambiguous API response.
            await withRetry(
              () =>
                api(
                  "POST",
                  `/api/upload/jobs/${summary.id}/chunks/${index}/complete`,
                  tok,
                  { sha256: sha, size, attemptId: signed.attemptId },
                  abort.signal,
                ),
              { attempts: 5, baseMs: 800, maxMs: 15_000, signal: abort.signal },
            );
          } catch (err) {
            if (err instanceof ApiError && err.status === 422)
              throw new ApiError(425, null, err.message);
            throw err;
          }
        }
      },
      { attempts: 5, baseMs: 800, maxMs: 15_000, signal: abort.signal },
    );

    loadedRef.current.set(index, size);
    verifiedRef.current.add(index);
    setChunksDone(verifiedRef.current.size);
  }

  async function start(file: File) {
    if (!token || (abortRef.current && !abortRef.current.signal.aborted))
      return;
    if (!file.name.toLowerCase().endsWith(".zip")) {
      setErrorText("Pilih file berekstensi .zip.");
      return;
    }
    if (file.size <= 0) {
      setErrorText("File ini kosong.");
      return;
    }
    if (file.size > UPLOAD_LIMITS.webArchiveBytes) {
      setErrorText(
        `ZIP ini berukuran ${(file.size / MB).toFixed(1)} MB. Batas unggahan browser adalah 100 MB.`,
      );
      return;
    }

    jobRef.current = null;
    setJob(null);
    fileRef.current = file;
    setErrorText(null);
    setNotice(null);
    setPhase("preparing");
    samplesRef.current = [];
    const abort = new AbortController();
    abortRef.current = abort;

    let storageKey: string | null = null;
    try {
      if (!scope)
        throw new ApiError(
          401,
          null,
          "Open the upload link from Telegram again.",
        );
      const fileSha256 = await sha256Hex(await file.arrayBuffer());
      if (abort.signal.aborted) throw new Error("cancelled");
      storageKey = resumeStorageKey(scope, file, fileSha256);
      resumeStorageRef.current = storageKey;
      const create = () =>
        api<JobSummary>(
          "POST",
          "/api/upload/jobs",
          token,
          {
            fileName: file.name,
            totalBytes: file.size,
            fileSha256,
            clientKey: resumeKey(storageKey!),
          },
          abort.signal,
        );
      let summary: JobSummary;
      try {
        summary = await create();
      } catch (err) {
        if (!(err instanceof ApiError) || ![409, 410].includes(err.status))
          throw err;
        clearResumeKey(storageKey);
        summary = await create();
      }
      jobRef.current = summary;
      try {
        window.sessionStorage.setItem("gm-upload-last-job", summary.id);
      } catch {}
      if (
        summary.status !== "created" &&
        summary.status !== "uploading" &&
        summary.status !== "uploaded" &&
        summary.status !== "processing" &&
        summary.status !== "completed"
      ) {
        if (storageKey) clearResumeKey(storageKey);
        throw new ApiError(
          409,
          null,
          `This upload is ${summary.status}. Send /upload in Telegram to start a new one.`,
        );
      }
      setJob(summary);

      verifiedRef.current = new Set(
        summary.chunks
          .filter((c) => c.status === "verified")
          .map((c) => c.index),
      );
      loadedRef.current = new Map();
      verifiedRef.current.forEach((i) =>
        loadedRef.current.set(i, chunkBytes(summary, i)),
      );
      setChunksDone(verifiedRef.current.size);
      setBytesDone(summary.bytesVerified);

      if (summary.missing.length > 0) {
        setPhase("uploading");
        const controller = new AdaptiveConcurrency(
          START_CONCURRENCY,
          MIN_CONCURRENCY,
          MAX_CONCURRENCY,
        );
        controllerRef.current = controller;
        await runPool(
          summary.missing,
          controller,
          (index) => uploadChunk(summary, file, index, token, abort),
          abort.signal,
        );
      }

      setPhase("finishing");
      const ready = await withRetry(
        () =>
          api<JobSummary>(
            "POST",
            `/api/upload/jobs/${summary.id}/ready`,
            token,
            undefined,
            abort.signal,
          ),
        { attempts: 5, baseMs: 800, maxMs: 15_000, signal: abort.signal },
      );
      jobRef.current = ready;
      setJob(ready);
      setBytesDone(ready.bytesVerified);
      if (ready.status !== "completed") {
        // Publish to GitHub right away. The request keeps running server-side; progress comes from polling.
        void api<JobSummary>("POST", `/api/upload/jobs/${ready.id}/process`, token, undefined, abort.signal).catch(() => undefined);
      }
      if (ready.status === "completed" && storageKey)
        clearResumeKey(storageKey);
      setPhase(ready.status === "completed" ? "completed" : "ready");
    } catch (err) {
      if (abort.signal.aborted) return;
      abort.abort(); // Stop all outstanding browser transfers on failure.
      setPhase("error");
      setErrorText(messageFor(err));
    } finally {
      if (abortRef.current === abort) abortRef.current = null;
    }
  }

  async function cancel() {
    const active = abortRef.current;
    active?.abort();
    const current = jobRef.current;
    if (current && token) {
      try {
        await api("POST", `/api/upload/jobs/${current.id}/cancel`, token);
      } catch (err) {
        setErrorText(messageFor(err));
        setPhase(
          ["uploaded", "processing"].includes(current.status)
            ? "processing"
            : "error",
        );
        return;
      }
    }
    setPhase("cancelled");
    setErrorText("Unggahan dibatalkan.");
  }

  const busy =
    phase === "preparing" ||
    phase === "uploading" ||
    phase === "finishing" ||
    phase === "ready" ||
    phase === "processing";
  const total = job?.totalBytes ?? fileRef.current?.size ?? 0;
  const pct =
    total > 0 ? Math.min(100, Math.floor((bytesDone / total) * 100)) : 0;
  const chunkTotal = job?.chunkCount ?? 0;

  const [over, setOver] = useState(false);
  const pickItems = async (items: PickedItem[], folderName?: string) => {
    if (items.length === 0 || busy || packing) return;
    const raw = items.reduce((n, i) => n + i.file.size, 0);
    if (raw > UPLOAD_LIMITS.webArchiveBytes) {
      setErrorText(`Ukuran ${(raw / MB).toFixed(1)} MB. Batas unggahan browser adalah 100 MB.`);
      return;
    }
    setErrorText(null);
    setPacking(true);
    try {
      const archive = await buildArchive(items, { strip, folderName });
      void start(archive);
    } catch {
      setErrorText("Gagal menyiapkan file.");
    } finally {
      setPacking(false);
    }
  };
  const statusText =
    phase === "preparing" ? "Menyiapkan…"
    : phase === "uploading" ? "Mengunggah…"
    : phase === "finishing" ? "Memverifikasi…"
    : phase === "ready" ? "Mengirim ke GitHub…"
    : phase === "processing" ? `GitHub: ${processingLabels[job?.stage ?? ""] ?? "Menunggu diproses"}`
    : phase === "completed" ? (job?.commitSha ? "GitHub update ✓" : "Sudah terbaru ✓")
    : phase === "error" ? "Gagal"
    : phase === "cancelled" ? "Dibatalkan"
    : "";
  const Wrapper = embedded ? "section" : "main";
  const target = job ?? scope;
  return (
    <Wrapper className={embedded ? "up" : "up page"}>
      <style>{CSS}</style>
      {!embedded && (
        <a className="brandlink" href="/">
          <span className="mark" aria-hidden="true">K</span>Kyn-X
        </a>
      )}
      {!embedded && <h1>Unggah</h1>}

      {notice && (
        <p className="info" role="alert">
          {notice}
          {!embedded && !token && (
            <>
              {" "}
              <a href="/app">Buka dashboard</a> atau <a href="/">kembali ke beranda</a>.
            </>
          )}
        </p>
      )}

      {token && (
        <>
          <div className="picker" role="group" aria-label="Opsi unggah">
            <div className="seg" role="radiogroup" aria-label="Jenis pilihan">
              <button type="button" role="radio" aria-checked={mode === "file"} className={mode === "file" ? "on" : ""} disabled={busy || packing} onClick={() => setMode("file")}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" /><path d="M14 3v5h5" /></svg>
                File
              </button>
              <button type="button" role="radio" aria-checked={mode === "folder"} className={mode === "folder" ? "on" : ""} disabled={busy || packing} onClick={() => setMode("folder")}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /></svg>
                Folder
              </button>
            </div>
            <button type="button" role="switch" aria-checked={strip} className={`sw${strip ? " on" : ""}`} disabled={busy || packing} onClick={() => setStrip((v) => !v)}>
              <span className="knob" aria-hidden="true" />
              <span>Hapus folder luar</span>
            </button>
          </div>

          <label
            className={`drop${over ? " over" : ""}${busy || packing || !scope ? " disabled" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              if (!busy && !packing && scope) setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              if (busy || packing || !scope || !e.dataTransfer) return;
              void fromDrop(e.dataTransfer).then((r) => pickItems(r.items, r.folderName));
            }}
          >
            <input
              key={mode}
              aria-label="Pilih file ZIP atau pilih file yang sama untuk melanjutkan"
              type="file"
              multiple
              disabled={busy || packing || !scope}
              ref={(el) => {
                if (!el) return;
                if (mode === "folder") {
                  el.setAttribute("webkitdirectory", "");
                  el.setAttribute("directory", "");
                } else {
                  el.removeAttribute("webkitdirectory");
                  el.removeAttribute("directory");
                }
              }}
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []);
                e.target.value = "";
                if (mode === "folder") {
                  const r = fromFolderInput(picked);
                  void pickItems(r.items, r.folderName);
                } else {
                  void pickItems(picked.map((f) => ({ file: f, path: f.name })));
                }
              }}
            />
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 16V4m0 0l-4 4m4-4l4 4" />
              <path d="M4 15v3a2 2 0 002 2h12a2 2 0 002-2v-3" />
            </svg>
            <strong>{packing ? "Menyiapkan…" : mode === "folder" ? "Pilih folder" : "Pilih file"}</strong>
            <span>atau seret ke sini</span>
            <span className="hint">Semua jenis file · maks 100 MiB</span>
          </label>

          {target && (
            <div className="card">
              <h2>Tujuan unggahan</h2>
              <div className="target">
                <div className="line"><span>Repositori</span><span className="pill">{target.repoFullName}</span></div>
                <div className="line"><span>Branch</span><span className="pill">{target.branch}</span></div>
                <div className="line">
                  <span>File</span>
                  <span className="pill">{job?.fileName ?? fileRef.current?.name ?? "Belum dipilih"}</span>
                </div>
              </div>
            </div>
          )}

          {phase !== "idle" && (
            <div className="card">
              <SendFlow state={phase === "completed" ? "ok" : phase === "error" ? "bad" : phase === "cancelled" ? "stopped" : "sending"} pct={total > 0 ? pct : undefined} />
              <div className="head">
                <span className="status">{statusText}</span>
                <span className="big">{total > 0 ? `${pct}%` : "—"}</span>
              </div>
              <div
                className="bar"
                aria-label="Progres unggah ZIP"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
              >
                <div style={{ width: `${pct}%` }} />
              </div>
              <div className="stats">
                <div className="stat">
                  <span>Terkirim</span>
                  <b>{total > 0 ? `${(bytesDone / MB).toFixed(1)} / ${(total / MB).toFixed(1)} MB` : "—"}</b>
                </div>
                <div className="stat">
                  <span>Kecepatan</span>
                  <b>
                    {phase === "uploading"
                      ? speed !== null
                        ? `${(speed / MB).toFixed(1)} MB/s`
                        : "mengukur…"
                      : "—"}
                  </b>
                </div>
                <div className="stat">
                  <span>Potongan</span>
                  <b>{chunkTotal > 0 ? `${chunksDone} / ${chunkTotal} (${CHUNK_LIMITS.defaultBytes / MB} MB per potongan)` : "—"}</b>
                </div>
                <div className="stat">
                  <span>Koneksi paralel</span>
                  <b>{phase === "uploading" ? concurrency : "—"}</b>
                </div>
              </div>
            </div>
          )}

          {(phase === "processing" || phase === "completed") && (
            <p className="info">
              {job?.filesProcessed ?? 0}/{job?.filesTotal ?? "—"} file · +{job?.added ?? 0} ~{job?.updated ?? 0} ={job?.unchanged ?? 0}
            </p>
          )}
          {phase === "completed" && (
            <p className="ok" role="status">
              {job?.commitSha ? (
                <>
                  <svg className="check" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M4 10.5l4 4 8-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {job.commitSha.slice(0, 7)} · {job.branch}{" "}
                  {job.commitUrl && (
                    <a href={job.commitUrl} target="_blank" rel="noreferrer">Lihat commit</a>
                  )}
                </>
              ) : (
                "Sudah terbaru."
              )}
            </p>
          )}
          {errorText && <p className="error" role="alert">{errorText}</p>}

          <div className="actions">
            {busy && job?.canCancel !== false && (
              <button className="btn" onClick={() => void cancel()}>Batal</button>
            )}
            {(phase === "error" || phase === "cancelled") && fileRef.current && (
              <button className="btn primary" onClick={() => fileRef.current && void start(fileRef.current)}>
                Coba lagi
              </button>
            )}
          </div>
        </>
      )}

    </Wrapper>
  );
}
