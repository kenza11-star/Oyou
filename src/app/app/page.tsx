"use client";
import Link from "next/link";
import { useApi, type Job, type Me } from "./hooks";
import { CountUp, ErrorNotice, JobItem, NotLinked, ProfileCard, SendFlow, type FlowState } from "./ui";
import { jobProgress, statusInfo } from "@/lib/web/format";

export default function Dashboard() {
  const me = useApi<Me>("/api/web/me");
  const jobs = useApi<{ jobs: Job[] }>("/api/web/jobs", { everyMs: 4000, active: (d) => d.jobs.some((j) => statusInfo(j.status, j.stage).open) });
  const list = jobs.data?.jobs ?? [];
  const done = list.filter((j) => j.status === "completed").length;
  const failed = list.filter((j) => j.status === "failed").length;
  const open = list.filter((j) => statusInfo(j.status, j.stage).open);
  const latest = list[0];
  const latestInfo = latest ? statusInfo(latest.status, latest.stage) : null;
  const flow: FlowState = !latest ? "stopped" : latestInfo?.open ? "sending" : latest.status === "completed" ? "ok" : latest.status === "failed" ? "bad" : "stopped";
  const pct = latest && latestInfo?.open ? jobProgress(latest) : null;
  return (
    <div className="stack tg">
      <div className="tg-bg" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /></div>
      <header className="tg-top">
        <span className="tg-avatar" aria-hidden="true">K</span>
        <div className="tg-title">
          <h1>Dasbor</h1>
          <p><span className="tg-dot" aria-hidden="true" /><span>{open.length > 0 ? "sedang mengirim" : "siap"}</span></p>
        </div>
        <Link className="tg-bubble-out tg-cta" href="/app/upload">Unggah ZIP</Link>
      </header>
      <ErrorNotice error={me.error} />
      {me.data && !me.data.github && <NotLinked installUrl={me.data.installUrl} />}
      {me.data?.github && (
        <div className="dash">
          <ProfileCard
            login={me.data.github.login}
            subtitle="GitHub"
            chip={me.data.selection?.repoFullName.split("/").pop() ?? null}
            stats={[
              { icon: "check", tone: "var(--success)", value: done, label: "Berhasil" },
              { icon: "alert", tone: "var(--danger)", value: failed, label: "Gagal" },
              { icon: "pulse", tone: "var(--accent)", value: open.length, label: "Berjalan" },
            ]}
            cta={{ label: "Aktivitas", href: "/app/activity" }}
            side={{ label: "Ubah repositori", href: "/app/github", icon: "edit" }}
          />
          <div className="stack">
            <section className="tg-hero" aria-label="Pengiriman terakhir">
              <SendFlow state={flow} pct={pct ?? undefined} />
              <div className="tg-hero-line">
                <span className="tg-repo">{latest ? latest.repoFullName : (me.data.selection?.repoFullName ?? "Belum ada repositori")}</span>
                {latestInfo && <span className={`badge ${latestInfo.tone === "idle" ? "" : latestInfo.tone}`}>{latestInfo.label}</span>}
                {pct !== null && <b className="tg-pct"><CountUp value={pct} />%</b>}
              </div>
            </section>
            <section className="panel tg-feed" aria-labelledby="rec">
              <header><h2 id="rec">Terbaru</h2><Link href="/app/activity" className="btn sm">Semua</Link></header>
              <ErrorNotice error={jobs.error} />
              {jobs.loading ? <div className="empty" /> : list.length === 0 ? (
                <div className="empty"><strong>Belum ada unggahan</strong></div>
              ) : <ul className="rows">{list.slice(0, 5).map((j) => <JobItem key={j.id} job={j} onChanged={jobs.reload} />)}</ul>}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
