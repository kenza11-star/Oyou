"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { SessionProvider, useSession } from "./session";
import { Icon } from "./ui";
import { useApi, type Me } from "./hooks";

const NAV = [
  { href: "/app", label: "Dasbor", icon: "home" },
  { href: "/app/upload", label: "Unggah", icon: "upload" },
  { href: "/app/activity", label: "Aktivitas", icon: "list" },
  { href: "/app/github", label: "GitHub", icon: "git" },
  { href: "/app/settings", label: "Pengaturan", icon: "cog" },
] as const;

function SignedOut() {
  return (
    <main className="land" style={{ maxWidth: 520, paddingTop: 72 }}>
      <h1>Masuk lewat Telegram</h1>
      <p className="muted" style={{ marginTop: 8 }}>
        Dashboard tidak memakai kata sandi. Kirim <code>/web</code> ke bot Kyn-X, lalu ketuk tombol “Open dashboard”. Tautan berlaku 8 jam dan hanya untuk akun Telegram Anda.
      </p>
      <div className="cta"><Link className="btn" href="/">Kembali ke beranda</Link></div>
    </main>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { token, ready } = useSession();
  const me = useApi<Me>("/api/web/me");
  const glow = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".panel, .pcard");
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  };
  if (!ready) return null;
  if (!token) return <SignedOut />;
  const idx = NAV.findIndex((n) => n.href === path);
  return (
    <div className="shell" onPointerMove={glow}>
      <aside className="side">
        <Link className="brand" href="/"><span className="mark" aria-hidden="true">K</span>Kyn-X</Link>
        <nav className="nav" aria-label="Navigasi dashboard">
          <span className="ind" aria-hidden="true" style={{ "--i": Math.max(idx, 0) } as CSSProperties} {...(idx < 0 ? { "data-hide": "" } : {})} />
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} aria-current={path === n.href ? "page" : undefined}>
              <Icon name={n.icon} />
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="who" {...(me.data?.github ? { "data-on": "" } : {})}><span>{me.data?.github ? <>GitHub: <strong>{me.data.github.login}</strong></> : "GitHub belum terhubung"}</span></div>
      </aside>
      <main className="main" id="konten">{children}</main>
    </div>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <Shell>{children}</Shell>
    </SessionProvider>
  );
}
