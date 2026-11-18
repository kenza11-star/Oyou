"use client";
import Link from "next/link";
import { useEffect, useId, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { formatBytes, formatTime, jobProgress, statusInfo } from "@/lib/web/format";
import { useSession, ApiFail } from "./session";
import type { Job } from "./hooks";
export { SendFlow, type FlowState } from "./send-flow";

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

interface GhProfile { avatar: string; name: string | null; bio: string | null; followers: number; repos: number }

/** Public profile straight from GitHub (avatar, name, bio). Cached per tab; failure just falls back to the login. */
function useGithubProfile(login: string): GhProfile | null {
  const [p, setP] = useState<GhProfile | null>(null);
  useEffect(() => {
    const key = `gm-gh-${login}`;
    try {
      const hit = window.sessionStorage.getItem(key);
      if (hit) { setP(JSON.parse(hit) as GhProfile); return; }
    } catch { /* optional cache */ }
    const ctl = new AbortController();
    fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, { signal: ctl.signal, headers: { accept: "application/vnd.github+json" } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("gh"))))
      .then((d: { avatar_url?: string; name?: string | null; bio?: string | null; followers?: number; public_repos?: number }) => {
        const v: GhProfile = { avatar: d.avatar_url ?? "", name: d.name ?? null, bio: d.bio ?? null, followers: d.followers ?? 0, repos: d.public_repos ?? 0 };
        setP(v);
        try { window.sessionStorage.setItem(key, JSON.stringify(v)); } catch { /* optional cache */ }
      })
      .catch(() => undefined);
    return () => ctl.abort();
  }, [login]);
  return p;
}

/** Bubble-gum banner: gooey pink blobs that squash and stretch, a bubble that inflates and pops, and a blob that follows your finger. */
function GumBanner({ chip }: { chip?: string | null }) {
  const fid = `gum${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const root = useRef<HTMLDivElement>(null);
  const touch = useRef<HTMLElement | null>(null);
  const st = useRef({ x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, raf: 0, on: false });
  const loop = () => {
    const s = st.current, el = touch.current;
    if (!el) return;
    s.vx = (s.vx + (s.tx - s.x) * 0.16) * 0.78;
    s.vy = (s.vy + (s.ty - s.y) * 0.16) * 0.78;
    s.x += s.vx; s.y += s.vy;
    const stretch = Math.min(0.35, Math.hypot(s.vx, s.vy) / 40);
    const ang = Math.atan2(s.vy, s.vx);
    el.style.transform = `translate(${s.x - 36}px, ${s.y - 36}px) rotate(${ang}rad) scale(${1 + stretch}, ${1 - stretch * 0.7})`;
    if (s.on || Math.hypot(s.vx, s.vy) > 0.05) s.raf = requestAnimationFrame(loop);
    else s.raf = 0;
  };
  const aim = (e: ReactPointerEvent<HTMLDivElement>, down: boolean) => {
    const r = root.current?.getBoundingClientRect();
    if (!r) return;
    const s = st.current;
    s.tx = e.clientX - r.left; s.ty = e.clientY - r.top;
    if (down) { s.x = s.tx; s.y = s.ty; s.vx = s.vy = 0; s.on = true; root.current?.classList.add("touching"); }
    if (s.on && !s.raf) s.raf = requestAnimationFrame(loop);
  };
  const release = () => {
    st.current.on = false;
    root.current?.classList.remove("touching");
  };
  useEffect(() => () => cancelAnimationFrame(st.current.raf), []);
  return (
    <div
      ref={root}
      className="banner gum"
      aria-hidden="true"
      onPointerDown={(e) => aim(e, true)}
      onPointerMove={(e) => st.current.on && aim(e, false)}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
    >
      <svg width="0" height="0" style={{ position: "absolute" }} focusable="false">
        <defs>
          <filter id={fid} x="-20%" y="-40%" width="140%" height="180%" colorInterpolationFilters="sRGB">
            <feGaussianBlur in="SourceGraphic" stdDeviation="9" result="b" />
            <feColorMatrix in="b" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -10" />
          </filter>
        </defs>
      </svg>
      <div className="goo" style={{ filter: `url(#${fid})` }}>
        <b /><b /><b /><b /><b />
        <i ref={touch} className="touch" />
      </div>
      <span className="bubble" />
      <span className="shine" />
      {chip && <span className="chip"><Icon name="repo" /><span>{chip}</span></span>}
    </div>
  );
}

/** Profile card: GitHub avatar and name, a bubble-gum banner, three stats and one call to action. Tilts toward the pointer. */
export function ProfileCard({ login, subtitle, chip, caption, stats, cta, side }: {
  login: string; subtitle: string; chip?: string | null; caption?: string; stats: ProfileStat[];
  cta: ProfileLink; side?: ProfileLink & { icon: keyof typeof P };
}) {
  const [imgOk, setImgOk] = useState(true);
  const gh = useGithubProfile(login);
  const ref = useRef<HTMLElement | null>(null);
  const avatar = gh?.avatar || `https://avatars.githubusercontent.com/${encodeURIComponent(login)}?s=136`;
  const move = (e: ReactPointerEvent<HTMLElement>) => {
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
  return (
    <article ref={ref} className="pcard" onPointerMove={move} onPointerLeave={leave} aria-label={`Profil ${login}`}>
      <GumBanner chip={chip} />
      <div className="who-row">
        <div className="avatar">
          {imgOk
            ? // eslint-disable-next-line @next/next/no-img-element
              <img key={avatar} src={avatar} alt="" width={68} height={68} referrerPolicy="no-referrer" onError={() => setImgOk(false)} />
            : <span aria-hidden="true">{login.slice(0, 1).toUpperCase()}</span>}
        </div>
        {side && (side.external
          ? <a className="btn icon" href={side.href} aria-label={side.label} title={side.label} target="_blank" rel="noreferrer"><Icon name={side.icon} /></a>
          : <Link className="btn icon" href={side.href} aria-label={side.label} title={side.label}><Icon name={side.icon} /></Link>)}
      </div>
      <h2 className="name">{gh?.name || login}</h2>
      <p className="sub">{gh?.name ? `@${login}` : subtitle}{gh ? ` · ${gh.followers} pengikut` : ""}</p>
      {gh?.bio && <p className="bio">{gh.bio}</p>}
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
        {cta.external
          ? <a className="btn primary block" href={cta.href} target="_blank" rel="noreferrer">{cta.label}</a>
          : <Link className="btn primary block" href={cta.href}>{cta.label}</Link>}
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
        <span>{job.fileName ?? "ZIP"} · {formatBytes(job.totalBytes)}</span>
        <span title={job.id}>{formatTime(job.createdAt)}</span>
        {info.open && job.filesTotal != null && <span>{job.filesProcessed}/{job.filesTotal} file</span>}
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
          <i className="fly" aria-hidden="true" style={pct !== null ? { left: `${pct}%` } : undefined} />
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
