"use client";
import { useApi, type Job } from "../hooks";
import { ErrorNotice, JobItem } from "../ui";
import { statusInfo } from "@/lib/web/format";

export default function Activity() {
  const jobs = useApi<{ jobs: Job[] }>("/api/web/jobs", { everyMs: 4000, active: (d) => d.jobs.some((j) => statusInfo(j.status, j.stage).open) });
  const list = jobs.data?.jobs ?? [];
  return (
    <div className="stack">
      <div className="page-head"><div><h1>Aktivitas</h1><p>Riwayat unggahan Anda. Status diperbarui otomatis selama ada pekerjaan berjalan.</p></div>
        <button className="btn" onClick={() => void jobs.reload()}>Muat ulang</button></div>
      <ErrorNotice error={jobs.error} />
      <section className="panel" aria-label="Daftar unggahan">
        {jobs.loading ? <div className="empty">Memuat…</div> : list.length === 0 ? (
          <div className="empty"><strong>Belum ada aktivitas</strong>Unggahan akan muncul di sini.</div>
        ) : <ul className="rows">{list.map((j) => <JobItem key={j.id} job={j} onChanged={jobs.reload} />)}</ul>}
      </section>
    </div>
  );
}
