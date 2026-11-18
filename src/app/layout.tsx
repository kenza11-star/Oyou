import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Kyn-X · GitHub Manager", template: "%s · Kyn-X" },
  description: "Kelola repositori GitHub, unggah proyek ZIP, dan pantau GitHub Actions lewat bot Telegram dan dashboard web.",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#000000" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
