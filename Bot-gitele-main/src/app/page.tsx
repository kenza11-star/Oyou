import { coreReadiness } from "@/lib/deployment/readiness";

export const dynamic = "force-dynamic";

async function botUsername(): Promise<string | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { next: { revalidate: 3600 }, signal: AbortSignal.timeout(5000) });
    const data = (await res.json()) as { ok?: boolean; result?: { username?: string } };
    return data.ok && data.result?.username && /^[A-Za-z0-9_]{3,64}$/.test(data.result.username) ? data.result.username : null;
  } catch {
    return null;
  }
}

export default async function Home() {
  const [bot, core] = await Promise.all([botUsername(), coreReadiness().catch(() => null)]);
  const db = core ? core.checks.database && core.checks.schema : null;
  const badge = (ok: boolean | null) => (ok === null ? "badge" : ok ? "badge ok" : "badge bad");
  const word = (ok: boolean | null) => (ok === null ? "Tidak diketahui" : ok ? "Normal" : "Bermasalah");
  return (
    <div className="land">
      <header className="top">
        <span className="brand"><span className="mark" aria-hidden="true">K</span>Kyn-X</span>
        <nav aria-label="Navigasi utama" className="actions">
          <a className="btn sm" href="/app">Dashboard</a>
          {bot && <a className="btn sm primary" href={`https://t.me/${bot}`}>Buka bot</a>}
        </nav>
      </header>
      <main>
        <section className="hero">
          <h1>Kelola repositori GitHub dari Telegram dan web.</h1>
          <p>
            Hubungkan akun GitHub, pilih repositori dan branch, lalu unggah proyek ZIP hingga 100 MiB. File dikirim ke
            repositori Anda lewat Git API, dan statusnya hanya dinyatakan selesai setelah GitHub mengonfirmasi commit.
            Anda juga bisa memantau GitHub Actions dan mengunduh APK dari bot.
          </p>
          <div className="cta">
            {bot ? <a className="btn primary" href={`https://t.me/${bot}`}>Mulai di Telegram</a> : <p className="muted">Cari bot Kyn-X di Telegram untuk memulai.</p>}
            <a className="btn" href="/app">Buka dashboard</a>
          </div>
        </section>

        <div className="pipe" aria-hidden="true">
          <span className="node"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></svg>ZIP</span>
          <span className="link" />
          <span className="node"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M13 3 5 13h6l-1 8 8-10h-6l1-8Z" /></svg>GitHub</span>
          <span className="link" />
          <span className="node"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3 12h6m6 0h6" /></svg>Commit</span>
        </div>

        <section aria-labelledby="how">
          <h2 id="how">Cara memulai</h2>
          <ol className="steps">
            <li><strong>Mulai bot</strong><span>Kirim <code>/start</code> ke bot di chat pribadi.</span></li>
            <li><strong>Hubungkan GitHub</strong><span>Kirim <code>/login</code>, buka tautan sekali pakai, lalu setujui akses GitHub App. Instal aplikasi hanya pada repositori yang ingin dikelola.</span></li>
            <li><strong>Buka dashboard</strong><span>Kirim <code>/web</code> untuk mendapat tautan masuk (berlaku 8 jam). Tidak ada kata sandi terpisah.</span></li>
          </ol>
        </section>

        <section aria-labelledby="status">
          <h2 id="status" style={{ marginBottom: 12 }}>Status sistem</h2>
          <div className="panel"><div className="body">
            <dl className="kv">
              <dt>Aplikasi web</dt><dd><span className="badge ok">Normal</span></dd>
              <dt>Database</dt><dd><span className={badge(db)}>{word(db)}</span></dd>
              <dt>Pemrosesan ZIP</dt><dd className="muted">Langsung dikirim ke GitHub setelah unggahan selesai; status tersedia di dashboard.</dd>
            </dl>
          </div></div>
        </section>
      </main>
      <footer>Kyn-X GitHub Manager. Berjalan di Vercel, Supabase, dan GitHub.</footer>
    </div>
  );
}
