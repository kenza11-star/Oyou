"use client";
import { useEffect } from "react";

/** Tap feedback for every button/link/tab: a thin ring expands from the touch point. Flat, no glow. */
export function Ripple() {
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const on = (e: PointerEvent) => {
      const t = e.target as Element | null;
      const hit = t?.closest?.("button, a[href], [role=button], [role=tab], [role=radio], [role=switch], [role=option], label.drop, summary");
      if (!hit || (hit as HTMLButtonElement).disabled) return;
      const r = document.createElement("span");
      r.className = "rip";
      r.style.left = `${e.clientX}px`;
      r.style.top = `${e.clientY}px`;
      document.body.appendChild(r);
      window.setTimeout(() => r.remove(), 650);
    };
    document.addEventListener("pointerdown", on, { passive: true });
    return () => document.removeEventListener("pointerdown", on);
  }, []);
  return null;
}
