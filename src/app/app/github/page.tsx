"use client";
import { useState } from "react";
import { useSession, ApiFail } from "../session";
import { useApi, type Me } from "../hooks";
import { ErrorNotice, NotLinked, ProfileCard } from "../ui";

interface Repo { id: number; fullName: string; defaultBranch: string; private: boolean }

export default function GithubPage() {
  const { call, signOut } = useSession();
  const me = useApi<Me>("/api/web/me");
  const repos = useApi<{ repos: Repo[] }>("/api/web/repos");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | "disconnect" | null>(null);
  const pick = async (r: Repo) => {
    setBusy(r.id); setErr(null);
    try { await call("POST", "/api/web/selection", { repoId: r.id }); await me.reload(); }
    catch (e) { setErr(e instanceof ApiFail ? e.message : "Gagal memilih repositori."); }
    finally { setBusy(null); }
  };
  const disconnect = async () => {
    if (!window.confirm("Putuskan akun GitHub? Token tersimpan dihapus, otorisasi dicabut di GitHub bila memungkinkan, dan unggahan yang belum dipublikasikan dibatalkan.")) return;
    setBusy("disconnect"); setErr(null);
    try { await call("POST", "/api/web/disconnect", {}); signOut(); }
    catch (e) { setErr(e instanceof ApiFail ? e.message : "Gagal memutuskan akun."); setBusy(null); }
  };
  const selected = me.data?.selection?.repoId;
  return (
    <div className="stack">
      <div className="page-head"><div><h1>Integrasi GitHub</h1><p>Akun terhubung dan repositori yang diizinkan GitHub App Anda.</p></div></div>
      <ErrorNotice error={me.error} />
      <ErrorNotice error={err} />
      {me.data && !me.data.github && <NotLinked installUrl={me.data.installUrl} />}
      {me.data?.github && (
        <>
          <div className="dash">
            <ProfileCard
              login={me.data.github.login}
              subtitle="Akun GitHub terhubung"
              chip={me.data.selection?.repoFullName.split("/").pop() ?? null}
              caption="Repositori yang diizinkan"
              stats={[
                { icon: "repo", tone: "var(--accent)", value: repos.data?.repos.length ?? 0, label: "Total" },
                { icon: "lock", tone: "var(--warning)", value: repos.data?.repos.filter((r) => r.private).length ?? 0, label: "Privat" },
                { icon: "globe", tone: "var(--success)", value: repos.data?.repos.filter((r) => !r.private).length ?? 0, label: "Publik" },
              ]}
              cta={{ label: "Kelola repositori yang diizinkan", href: me.data.installUrl, external: true }}
              side={{ label: "Buka profil GitHub", href: `https://github.com/${encodeURIComponent(me.data.github.login)}`, icon: "ext", external: true }}
            />
            <section className="panel" aria-labelledby="akun"><header><h2 id="akun">Akun</h2><span className="badge ok">Terhubung</span></header>
              <div className="body"><dl className="kv">
                <dt>Akun GitHub</dt><dd>{me.data.github.login}</dd>
                <dt>Instalasi</dt><dd><a href={me.data.installUrl} target="_blank" rel="noreferrer">Kelola repositori yang diizinkan</a></dd>
                <dt>Hubungkan ulang</dt><dd className="muted">Kirim <code>/login</code> di Telegram untuk otorisasi baru (tautan sekali pakai, 10 menit).</dd>
              </dl></div>
            </section>
          </div>
          <section className="panel" aria-labelledby="repo">
            <header><h2 id="repo">Repositori</h2></header>
            {repos.error && <div className="body"><ErrorNotice error={repos.error} /></div>}
            {repos.loading ? <div className="empty">Memuat…</div> : repos.data && repos.data.repos.length === 0 ? (
              <div className="empty"><strong>Tidak ada repositori yang diizinkan</strong><a href={me.data.installUrl} target="_blank" rel="noreferrer">Instal GitHub App pada repositori</a></div>
            ) : (
              <ul className="rows">{repos.data?.repos.map((r) => (
                <li key={r.id}><div className="top">
                  <span><strong>{r.fullName}</strong> <span className="muted">· {r.private ? "privat" : "publik"} · {r.defaultBranch}</span></span>
                  {selected === r.id ? <span className="badge ok">Terpilih</span> : <button className="btn sm" disabled={busy !== null} onClick={() => void pick(r)}>{busy === r.id ? "Memilih…" : "Pilih"}</button>}
                </div></li>
              ))}</ul>
            )}
          </section>
          <section className="panel" aria-labelledby="putus"><header><h2 id="putus">Putuskan akun</h2></header>
            <div className="body stack"><p className="muted">Menghapus token tersimpan dan mencabut sesi web. Anda bisa menghubungkan lagi kapan saja lewat <code>/login</code>.</p>
              <div><button className="btn danger" disabled={busy !== null} onClick={() => void disconnect()}>{busy === "disconnect" ? "Memutuskan…" : "Putuskan GitHub"}</button></div></div>
          </section>
        </>
      )}
    </div>
  );
}
