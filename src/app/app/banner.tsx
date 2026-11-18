"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

const MAX_BYTES = 100 * 1024 * 1024;
const DB = "kynx-banner";
const STORE = "media";
const OK = /^(image\/(png|jpe?g|webp|gif|avif)|video\/(mp4|webm|quicktime))$/;

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function readBlob(key: string): Promise<Blob | null> {
  const db = await open();
  return new Promise((res) => {
    const q = db.transaction(STORE).objectStore(STORE).get(key);
    q.onsuccess = () => res((q.result as Blob | undefined) ?? null);
    q.onerror = () => res(null);
  });
}
async function writeBlob(key: string, b: Blob | null): Promise<void> {
  const db = await open();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    if (b) tx.objectStore(STORE).put(b, key);
    else tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

function seeded(login: string): () => number {
  let h = 2166136261;
  for (const c of login) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => ((h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0) / 4294967296);
}

/** Flat, GitHub-style contribution grid. Cells twinkle in a travelling wave. No gradients, no glow. */
function Grid({ login }: { login: string }) {
  const cells = useMemo(() => {
    const rnd = seeded(login);
    const out: { x: number; y: number; l: number; d: number }[] = [];
    for (let c = 0; c < 44; c++) {
      for (let r = 0; r < 7; r++) {
        const v = rnd();
        out.push({ x: c, y: r, l: v < 0.34 ? 0 : v < 0.6 ? 1 : v < 0.8 ? 2 : v < 0.93 ? 3 : 4, d: (c * 0.09 + r * 0.05) % 4 });
      }
    }
    return out;
  }, [login]);
  return (
    <svg className="bn-grid" viewBox="0 0 44 7" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      {cells.map((c) => (
        <rect key={`${c.x}-${c.y}`} x={c.x + 0.08} y={c.y + 0.08} width="0.84" height="0.84" rx="0.18" className={`bn-l${c.l}`} style={{ animationDelay: `${c.d}s` }} />
      ))}
    </svg>
  );
}

/** Profile banner: contribution grid by default, or the person's own photo / GIF / MP4 (<=100 MiB, kept in this browser only). */
export function Banner({ login, children }: { login: string; children?: ReactNode }) {
  const key = `b:${login.toLowerCase()}`;
  const [media, setMedia] = useState<{ url: string; video: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const show = (b: Blob | null) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = b ? URL.createObjectURL(b) : null;
    setMedia(b && urlRef.current ? { url: urlRef.current, video: b.type.startsWith("video/") } : null);
  };
  useEffect(() => {
    let live = true;
    readBlob(key).then((b) => live && show(b)).catch(() => undefined);
    return () => {
      live = false;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const pick = async (f?: File) => {
    if (!f) return;
    if (!OK.test(f.type)) return setErr("Pakai foto, GIF, atau MP4.");
    if (f.size > MAX_BYTES) return setErr("Maksimal 100 MB.");
    setErr(null);
    try {
      await writeBlob(key, f);
      show(f);
    } catch {
      show(f);
      setErr("Tidak bisa disimpan di browser ini.");
    }
  };
  const reset = async () => {
    setErr(null);
    try { await writeBlob(key, null); } catch { /* ignore */ }
    show(null);
  };

  return (
    <div className="banner">
      {media ? (
        media.video
          ? <video className="bn-media" src={media.url} autoPlay loop muted playsInline />
          : // eslint-disable-next-line @next/next/no-img-element
            <img className="bn-media" src={media.url} alt="" />
      ) : <Grid login={login} />}
      <div className="bn-tools">
        <button type="button" className="bn-btn" onClick={() => input.current?.click()} aria-label="Ganti banner">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 8a2 2 0 0 1 2-2h1.500l1.500-2h6l1.500 2H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" /><circle cx="12" cy="13" r="3.500" /></svg>
        </button>
        {media && (
          <button type="button" className="bn-btn" onClick={() => void reset()} aria-label="Hapus banner">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        )}
        <input ref={input} type="file" accept="image/*,video/mp4,video/webm" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; void pick(f); }} />
      </div>
      {err && <span className="bn-err" role="alert">{err}</span>}
      {children}
    </div>
  );
}
