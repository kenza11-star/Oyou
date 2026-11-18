"use client";
import Link from "next/link";
import { useApi, type Job, type Me } from "./hooks";
import { ErrorNotice, JobItem, NotLinked, ProfileCard } from "./ui";
import { statusInfo } from "@/lib/web/format";

export default function Dashboard() {
  const me = useApi<Me>("/api/web/me");
  const jobs = useApi<{ jobs: Job[] }>("/api/web/jobs", { everyMs: 4000, active: (d) => d.jobs.some((j) => statusInfo(j.status, j.stage).open) });
  const list = jobs.data?.jobs ?? [];
  const done = list.filter((j) => j.status === "completed").length;
  const failed = list.filter((j) => j.status === "failed").length;
  const open = list.filter((j) => statusInfo(j.status, j.stage).open);
  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>Dasbor</h1><p>Ringkasan akun, repositori terpilih, dan unggahan terbaru.</p></div>
        <Link className="btn primary" href="/app/upload">Unggah ZIP</Link>
      </div>
      <ErrorNotice error={me.error} />
      {me.data && !me.data.github && <NotLinked installUrl={me.data.installUrl} />}
      {me.data?.github && (
        <div className="dash">
          <ProfileCard
            login={me.data.github.login}
            subtitle="Akun GitHub terhubung"
            chip={me.data.selection?.repoFullName.split("/").pop() ?? null}
            caption="30 unggahan terakhir"
            stats={[
              { icon: "check", tone: "var(--success)", value: done, label: "Berhasil" },
              { icon: "alert", tone: "var(--danger)", value: failed, label: "Gagal" },
              { icon: "pulse", tone: "var(--accent)", value: open.length, label: "Sedang berjalan" },
            ]}
            cta={{ label: "Lihat aktivitas", href: "/app/activity" }}
            side={{ label: "Ubah repositori", href: "/app/github", icon: "edit" }}
          />
          <section className="panel" aria-labelledby="acc"><header><h2 id="acc">Akun & repositori</h2><Link href="/app/github" className="btn sm">Ubah</Link></header>
            <div className="body"><dl className="kv">
              <dt>Akun GitHub</dt><dd>{me.data.github.login}</dd>
              <dt>Repositori</dt><dd>{me.data.selection?.repoFullName ?? <span className="muted">Belum dipilih</span>}</dd>
              <dt>Branch</dt><dd>{me.data.selection?.branch ?? "—"}</dd>
              <dt>Pemrosesan</dt><dd className="muted">{"Langsung ke GitHub begitu unggahan selesai (tanpa antrean)"}</dd>
            </dl></div>
          </section>
        </div>
      )}
      <section className="panel" aria-labelledby="rec">
        <header><h2 id="rec">Unggahan terbaru</h2><Link href="/app/activity" className="btn sm">Semua aktivitas</Link></header>
        <ErrorNotice error={jobs.error} />
        {jobs.loading ? <div className="empty">Memuat…</div> : list.length === 0 ? (
          <div className="empty"><strong>Belum ada unggahan</strong>Pilih repositori lalu unggah ZIP pertama Anda.</div>
        ) : <ul className="rows">{list.slice(0, 5).map((j) => <JobItem key={j.id} job={j} onChanged={jobs.reload} />)}</ul>}
      </section>
    </div>
  );
}
