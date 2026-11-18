"use client";
import { useState } from "react";
import { useSession, ApiFail } from "../session";
import { useApi, type Me } from "../hooks";
import { ErrorNotice } from "../ui";

export default function Settings() {
  const { call, signOut } = useSession();
  const me = useApi<Me>("/api/web/me");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const revokeAll = async () => {
    if (!window.confirm("Cabut semua sesi dashboard dan tautan unggah yang pernah dikirim bot? Anda perlu mengirim /web lagi.")) return;
    setBusy(true); setErr(null);
    try { await call("POST", "/api/web/signout", {}); signOut(); }
    catch (e) { setErr(e instanceof ApiFail ? e.message : "Gagal mencabut sesi."); setBusy(false); }
  };
  return (
    <div className="stack">
      <div className="page-head"><div><h1>Pengaturan</h1><p>Sesi dan perilaku pemrosesan.</p></div></div>
      <ErrorNotice error={err} />
      <section className="panel" aria-labelledby="sesi"><header><h2 id="sesi">Sesi</h2></header>
        <div className="body stack">
          <p className="muted">Sesi dashboard berlaku 8 jam dan disimpan hanya di tab ini.</p>
          <div className="actions">
            <button className="btn" onClick={signOut}>Keluar dari browser ini</button>
            <button className="btn danger" disabled={busy} onClick={() => void revokeAll()}>{busy ? "Mencabut…" : "Cabut semua sesi"}</button>
          </div>
        </div>
      </section>
      <section className="panel" aria-labelledby="proses"><header><h2 id="proses">Pemrosesan ZIP</h2></header>
        <div className="body"><dl className="kv">
          <dt>Mesin</dt><dd>Langsung di server; GitHub Actions hanya cadangan bila proses terputus</dd>
          <dt>Pemicu</dt><dd>Otomatis begitu unggahan diverifikasi, tanpa antrean</dd>
        </dl></div>
      </section>
    </div>
  );
}
