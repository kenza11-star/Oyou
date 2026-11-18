"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { formatBytes, formatTime, jobProgress, statusInfo } from "@/lib/web/format";
import { useSession, ApiFail } from "./session";
import type { Job } from "./hooks";

const P: Record<string, string> = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  upload: "M12 16V4m0 0-4 4m4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3",
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  git: "M6 3v12m0 0a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm12-6a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 0c0 4-6 3-12 6",
  cog: "M4 6h10M18 6h2M4 12h2M10 12h10M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4",
  check: "M5 12.5l4.5 4.5L19 7.5",
  alert: "M12 8v5m0 3.5h.01M10.3 4.2 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z",
  pulse: "M3 12h4l2.5-6 4 12 2.5-6H21",
  repo: "M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5v-15Zm0 15A1.5 1.5 0 0 0 6.5 21H19v-3M9 7h6",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M6 11h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-18c2.5 2.4 3.8 5.4 3.8 9S14.5 18.6 12 21m0-18C9.5 5.4 8.2 8.4 8.2 12S9.5 18.6 12 21M3.5 9h17M3.5 15h17",
  edit: "M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Zm9-13 4 4",
  ext: "M14 4h6v6m0-6-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  zip: "M12 3v4m0 0h-2m2 0h2M12 7v4m0 0h-2m2 0h2M7 3h10a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z",
  commit: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3 12h6m6 0h6",
};
export function Icon({ name }: { name: keyof typeof P }) {
  return (
    <svg className="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[name]} />
    </svg>
  );
}

/** Counts up to `value` once on mount / whenever it changes. Falls back to the plain number for reduced motion. */
export function CountUp({ value }: { value: number }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (typeof window === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || value === 0) {
      setN(value);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const dur = 800;
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / dur);
      setN(Math.round(value * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{n}</>;
}

export interface ProfileStat { icon: keyof typeof P; tone: string; value: number; label: string }
export interface ProfileLink { label: string; href: string; external?: boolean }

function hueOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** Profile card: animated banner, avatar, identity, three stats and one call to action. Tilts toward the pointer. */
export function ProfileCard({ login, subtitle, chip, caption, stats, cta, side }: {
  login: string; subtitle: string; chip?: string | null; caption?: string; stats: ProfileStat[];
  cta: ProfileLink; side?: ProfileLink & { icon: keyof typeof P };
}) {
  const [imgOk, setImgOk] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const h = hueOf(login);
  const vars = { "--c1": `hsl(${h} 95% 58%)`, "--c2": `hsl(${(h + 42) % 360} 95% 55%)`, "--c3": `hsl(${(h + 200) % 360} 85% 52%)` } as CSSProperties;
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el || e.pointerType === "touch") return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    el.classList.add("live");
    el.style.setProperty("--ty", `${(x * 9).toFixed(2)}deg`);
    el.style.setProperty("--tx", `${(-y * 9).toFixed(2)}deg`);
  };
  const leave = () => {
    const el = ref.current;
    if (!el) return;
    el.classList.remove("live");
    el.style.setProperty("--ty", "0deg");
    el.style.setProperty("--tx", "0deg");
  };
  const Cta = cta.external ? "a" : Link;
  const extra = cta.external ? { target: "_blank", rel: "noreferrer" } : {};
  const Side = side?.external ? "a" : Link;
  return (
    <article ref={ref} className="pcard" style={vars} onPointerMove={move} onPointerLeave={leave} aria-label={`Profil ${login}`}>
      <div className="banner" aria-hidden="true">
        <i /><i /><i />
        {chip && <span className="chip"><Icon name="repo" /><span>{chip}</span></span>}
      </div>
      <div className="who-row">
        <div className="avatar">
          {imgOk
            ? // eslint-disable-next-line @next/next/no-img-element
              <img src={`https://github.com/${encodeURIComponent(login)}.png?size=136`} alt="" width={68} height={68} onError={() => setImgOk(false)} />
            : <span aria-hidden="true">{login.slice(0, 1).toUpperCase()}</span>}
        </div>
        {side && (
          <Side className="btn icon" href={side.href} aria-label={side.label} title={side.label} {...(side.external ? { target: "_blank", rel: "noreferrer" } : {})}>
            <Icon name={side.icon} />
          </Side>
        )}
      </div>
      <h2 className="name">{login}</h2>
      <p className="sub">{subtitle}</p>
      {caption && <p className="cap">{caption}</p>}
      <div className="pstats">
        {stats.map((s) => (
          <div className="pstat" key={s.label} style={{ "--tone": s.tone } as CSSProperties}>
            <span className="ic"><Icon name={s.icon} /></span>
            <span><b><CountUp value={s.value} /></b><small>{s.label}</small></span>
          </div>
        ))}
      </div>
      <div className="cta">
        <Cta className="btn primary block" href={cta.href} {...extra}>{cta.label}</Cta>
      </div>
    </article>
  );
}

export function ErrorNotice({ error }: { error: ApiFail | string | null }) {
  if (!error) return null;
  const msg = typeof error === "string" ? error : error.message;
  return <div className="notice bad" role="alert">{msg}</div>;
}

export function NotLinked({ installUrl }: { installUrl?: string }) {
  return (
    <div className="panel"><div className="empty">
      <strong>Akun GitHub belum terhubung</strong>
      Kirim <code>/login</code> di bot Telegram, selesaikan otorisasi, lalu muat ulang halaman ini.
      {installUrl && <p style={{ marginTop: 8 }}><a href={installUrl} target="_blank" rel="noreferrer">Instal GitHub App pada repositori</a></p>}
    </div></div>
  );
}

export function JobItem({ job, onChanged }: { job: Job; onChanged: () => void }) {
  const { call } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const info = statusInfo(job.status, job.stage);
  const pct = jobProgress(job);
  const act = async (kind: "cancel" | "retry") => {
    if (kind === "cancel" && !window.confirm("Batalkan unggahan ini? Perubahan yang belum di-commit tidak akan dikirim.")) return;
    setBusy(kind);
    setErr(null);
    try {
      await call("POST", `/api/web/jobs/${job.id}/${kind}`, {});
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiFail ? e.message : "Gagal. Coba lagi.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <li data-tone={info.tone}>
      <div className="top">
        <span><strong>{job.repoFullName}</strong> <span className="muted">· {job.branch}</span></span>
        <span className={`badge ${info.tone === "idle" ? "" : info.tone}`}>{info.label}</span>
      </div>
      <div className="meta">
        <span className="mono" title={job.id}>{job.id.slice(0, 8)}</span>
        <span>{job.fileName ?? "ZIP"} · {formatBytes(job.totalBytes)}</span>
        <span>{formatTime(job.createdAt)}</span>
        {job.filesTotal != null && <span>{job.filesProcessed}/{job.filesTotal} file · +{job.added} ~{job.updated} ={job.unchanged}</span>}
      </div>
      {info.open && job.status !== "created" && (
        <div
          className={`bar${pct === null ? " indeterminate" : ""}`}
          role="progressbar"
          aria-label="Progres"
          aria-valuemin={0}
          aria-valuemax={100}
          {...(pct !== null ? { "aria-valuenow": pct } : {})}
        >
          <div style={pct !== null ? { width: `${pct}%` } : undefined} />
        </div>
      )}
      {job.status === "failed" && job.error && <p className="muted" style={{ color: "var(--danger)" }}>{job.error}</p>}
      {err && <ErrorNotice error={err} />}
      <div className="actions">
        {job.commitUrl && <a className="btn sm" href={job.commitUrl} target="_blank" rel="noreferrer">Lihat commit {job.commitSha?.slice(0, 7)}</a>}
        {job.actionsRunUrl && <a className="btn sm" href={job.actionsRunUrl} target="_blank" rel="noreferrer">Run GitHub Actions</a>}
        {job.canCancel && <button className="btn sm danger" disabled={busy !== null} onClick={() => void act("cancel")}>{busy === "cancel" ? "Membatalkan…" : "Batalkan"}</button>}
        {job.canRetry && <button className="btn sm" disabled={busy !== null} onClick={() => void act("retry")}>{busy === "retry" ? "Mengantre…" : "Coba lagi"}</button>}
      </div>
    </li>
  );
}
