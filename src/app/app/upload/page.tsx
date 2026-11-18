"use client";
import { useEffect, useState } from "react";
import Uploader from "@/app/upload/uploader";
import { useSession, ApiFail } from "../session";
import { useApi, type Me } from "../hooks";
import { ErrorNotice, NotLinked } from "../ui";
import { Pick } from "../pick";

interface Repo { id: number; fullName: string; defaultBranch: string; private: boolean }

export default function UploadPage() {
  const { call } = useSession();
  const me = useApi<Me>("/api/web/me");
  const repos = useApi<{ repos: Repo[] }>("/api/web/repos");
  const [repoId, setRepoId] = useState<number | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState("");
  const [auto, setAuto] = useState("main");
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingBranches, setLoadingBranches] = useState(false);

  useEffect(() => {
    if (repoId !== null || !me.data || !repos.data) return;
    const sel = me.data.selection?.repoId;
    const first = repos.data.repos.find((r) => r.id === sel) ?? null;
    if (first) {
      setRepoId(first.id);
      setBranch("main");
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
        const a = r.branches.includes("main") ? "main" : r.defaultBranch;
        setAuto(a);
        setCustom(false);
        setBranch(a);
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
      <div className="page-head"><div><h1>Unggah</h1><p>Maks 100 MiB.</p></div></div>
      <ErrorNotice error={me.error ?? repos.error} />
      {notLinked && <NotLinked installUrl={me.data?.installUrl} />}
      {me.data?.github && (
        <>
          <section className="panel" aria-labelledby="tujuan">
            <header><h2 id="tujuan">Tujuan</h2></header>
            <div className="body grid2">
              <div className="field">
                <label htmlFor="repo">Repositori</label>
                <Pick
                  id="repo"
                  value={repoId === null ? "" : String(repoId)}
                  loading={repos.loading}
                  placeholder="Pilih repositori"
                  options={(repos.data?.repos ?? []).map((r) => ({ value: String(r.id), label: r.fullName, hint: r.private ? "privat" : undefined }))}
                  onChange={(v) => setRepoId(v ? Number(v) : null)}
                />
              </div>
              <div className="field">
                <label htmlFor="branch">Branch</label>
                <div className="seg br" role="radiogroup" aria-label="Branch">
                  <button type="button" role="radio" aria-checked={!custom} className={!custom ? "on" : ""} disabled={repoId === null || loadingBranches} onClick={() => { setCustom(false); setBranch(auto); }}>{auto}</button>
                  <button type="button" role="radio" aria-checked={custom} className={custom ? "on" : ""} disabled={repoId === null || loadingBranches} onClick={() => setCustom(true)}>Custom</button>
                </div>
                {custom && (
                  <form className="brform" onSubmit={(e) => { e.preventDefault(); const v = draft.trim(); if (v) setBranch(v); }}>
                    <input id="branch" type="text" value={draft} placeholder="nama-branch" autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => setDraft(e.target.value)} />
                    <button className="btn primary" type="submit" disabled={!draft.trim() || draft.trim() === branch}>Pakai</button>
                  </form>
                )}
              </div>
            </div>
            <div className="body" style={{ paddingTop: 0 }}>
              <p className="muted">File sama ditimpa, file baru ditambah, sisanya tetap.</p>
              {repos.data && repos.data.repos.length === 0 && (
                <p style={{ marginTop: 8 }}>Belum ada repositori. <a href={me.data.installUrl} target="_blank" rel="noreferrer">Instal GitHub App</a> pada repositori yang ingin dikelola.</p>
              )}
            </div>
          </section>
          <ErrorNotice error={error} />
          {token ? <Uploader initialToken={token} embedded key={token} /> : repoId !== null && !error && <div className="empty">Menyiapkan sesi unggah…</div>}
          {token && <p className="dim">Sesi berlaku 30 menit.</p>}
        </>
      )}
    </div>
  );
}
