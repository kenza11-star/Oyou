"use client";
import { useEffect, useState } from "react";
import Uploader from "@/app/upload/uploader";
import { useSession, ApiFail } from "../session";
import { useApi, type Me } from "../hooks";
import { ErrorNotice, NotLinked } from "../ui";

interface Repo { id: number; fullName: string; defaultBranch: string; private: boolean }

export default function UploadPage() {
  const { call } = useSession();
  const me = useApi<Me>("/api/web/me");
  const repos = useApi<{ repos: Repo[] }>("/api/web/repos");
  const [repoId, setRepoId] = useState<number | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingBranches, setLoadingBranches] = useState(false);

  useEffect(() => {
    if (repoId !== null || !me.data || !repos.data) return;
    const sel = me.data.selection?.repoId;
    const first = repos.data.repos.find((r) => r.id === sel) ?? null;
    if (first) {
      setRepoId(first.id);
      setBranch(me.data.selection?.branch ?? first.defaultBranch);
    }
  }, [me.data, repos.data, repoId]);

  useEffect(() => {
    if (repoId === null) return;
    let live = true;
    setLoadingBranches(true);
    setToken(null);
    call<{ defaultBranch: string; branches: string[] }>("GET", `/api/web/branches?repoId=${repoId}`)
      .then((r) => {
        if (!live) return;
        setBranches(r.branches);
        setBranch((b) => (b && r.branches.includes(b) ? b : r.defaultBranch));
        setError(null);
      })
      .catch((e) => live && setError(e instanceof ApiFail ? e.message : "Gagal memuat branch."))
      .finally(() => live && setLoadingBranches(false));
    return () => { live = false; };
  }, [repoId, call]);

  useEffect(() => {
    if (repoId === null || !branch || loadingBranches) return;
    let live = true;
    setToken(null);
    call<{ token: string }>("POST", "/api/web/upload-session", { repoId, branch })
      .then((r) => live && (setToken(r.token), setError(null)))
      .catch((e) => live && setError(e instanceof ApiFail ? e.message : "Gagal menyiapkan sesi unggah."));
    return () => { live = false; };
  }, [repoId, branch, loadingBranches, call]);

  const notLinked = me.data && !me.data.github;
  return (
    <div className="stack">
      <div className="page-head"><div><h1>Unggah ZIP</h1><p>Kirim proyek ke repositori GitHub. Maksimal 100 MiB per arsip.</p></div></div>
      <ErrorNotice error={me.error ?? repos.error} />
      {notLinked && <NotLinked installUrl={me.data?.installUrl} />}
      {me.data?.github && (
        <>
          <section className="panel" aria-labelledby="tujuan">
            <header><h2 id="tujuan">Tujuan</h2></header>
            <div className="body grid2">
              <div className="field">
                <label htmlFor="repo">Repositori</label>
                <select id="repo" value={repoId ?? ""} onChange={(e) => setRepoId(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">{repos.loading ? "Memuat…" : "Pilih repositori"}</option>
                  {repos.data?.repos.map((r) => <option key={r.id} value={r.id}>{r.fullName}{r.private ? " (privat)" : ""}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="branch">Branch</label>
                <select id="branch" value={branch} disabled={repoId === null || loadingBranches} onChange={(e) => setBranch(e.target.value)}>
                  {branches.length === 0 && <option value="">{repoId === null ? "Pilih repositori dulu" : "Memuat…"}</option>}
                  {branches.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
            </div>
            <div className="body" style={{ paddingTop: 0 }}>
              <p className="muted">
                Cara kerja pembaruan: file dengan path yang sama ditimpa, file baru ditambahkan, dan file lain di repositori dipertahankan. Tidak ada file yang dihapus.
                Perubahan hanya dinyatakan selesai setelah GitHub mengonfirmasi commit. Hanya repositori yang diizinkan GitHub App Anda yang tampil di sini.
              </p>
              {repos.data && repos.data.repos.length === 0 && (
                <p style={{ marginTop: 8 }}>Belum ada repositori. <a href={me.data.installUrl} target="_blank" rel="noreferrer">Instal GitHub App</a> pada repositori yang ingin dikelola.</p>
              )}
            </div>
          </section>
          <ErrorNotice error={error} />
          {token ? <Uploader initialToken={token} embedded key={token} /> : repoId !== null && !error && <div className="empty">Menyiapkan sesi unggah…</div>}
          {token && <p className="dim">Sesi unggah berlaku 30 menit. Jika kedaluwarsa, pilih ulang branch untuk membuat sesi baru.</p>}
        </>
      )}
    </div>
  );
}
