"use client";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

export interface PickOption { value: string; label: string; hint?: string }

/** Custom dropdown (replaces native <select>): spring popover on desktop, bottom sheet on phones, search, keyboard. */
export function Pick({ id, value, options, onChange, placeholder, disabled, loading }: {
  id?: string; value: string; options: PickOption[]; onChange: (v: string) => void;
  placeholder: string; disabled?: boolean; loading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false);
  const [q, setQ] = useState("");
  const [cur, setCur] = useState(0);
  const [pos, setPos] = useState({ left: 0, top: 0, width: 0, up: false });
  const [phone, setPhone] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const selected = options.find((o) => o.value === value);
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? options.filter((o) => o.label.toLowerCase().includes(t)) : options;
  }, [options, q]);

  const show = () => {
    if (disabled || loading) return;
    const r = btn.current?.getBoundingClientRect();
    if (r) {
      const room = window.innerHeight - r.bottom;
      setPos({ left: r.left, top: r.bottom + 8, width: r.width, up: room < 280 && r.top > room });
    }
    setPhone(window.innerWidth < 640);
    setQ("");
    setCur(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
    requestAnimationFrame(() => setShown(true));
  };
  const hide = () => {
    setShown(false);
    window.setTimeout(() => setOpen(false), 220);
    btn.current?.focus();
  };
  const choose = (o: PickOption) => {
    onChange(o.value);
    hide();
  };

  useEffect(() => {
    if (!open) return;
    const esc = (e: globalThis.KeyboardEvent) => e.key === "Escape" && hide();
    const resize = () => hide();
    window.addEventListener("keydown", esc);
    window.addEventListener("resize", resize);
    document.body.style.overflow = phone ? "hidden" : document.body.style.overflow;
    return () => {
      window.removeEventListener("keydown", esc);
      window.removeEventListener("resize", resize);
      if (phone) document.body.style.overflow = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, phone]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${cur}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cur, open]);

  const key = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setCur((c) => Math.min(filtered.length - 1, c + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCur((c) => Math.max(0, c - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); const o = filtered[cur]; if (o) choose(o); }
  };

  const panelStyle = phone
    ? undefined
    : { left: pos.left, width: pos.width, ...(pos.up ? { bottom: window.innerHeight - pos.top + 16 } : { top: pos.top }) };

  return (
    <>
      <button
        ref={btn}
        id={id}
        type="button"
        className={`pk-btn${open ? " open" : ""}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? hide() : show())}
        onKeyDown={(e) => { if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !open) { e.preventDefault(); show(); } }}
      >
        <span className={selected ? "" : "ph"}>{loading ? "Memuat…" : selected ? selected.label : placeholder}</span>
        {selected?.hint && <em>{selected.hint}</em>}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <div className={`pk-root${shown ? " in" : ""}${phone ? " phone" : ""}`}>
          <div className="pk-back" onClick={hide} />
          <div className={`pk-panel${pos.up && !phone ? " up" : ""}`} style={panelStyle} role="presentation">
            {phone && <i className="pk-grab" aria-hidden="true" />}
            {options.length > 6 && (
              <div className="pk-search">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.500-3.500" /></svg>
                <input autoFocus={!phone} type="text" placeholder="Cari…" value={q} onChange={(e) => { setQ(e.target.value); setCur(0); }} onKeyDown={key} aria-label="Cari" />
              </div>
            )}
            <ul ref={list} role="listbox" tabIndex={-1} onKeyDown={key}>
              {filtered.length === 0 && <li className="pk-none">Tidak ada hasil</li>}
              {filtered.map((o, i) => (
                <li
                  key={o.value}
                  data-i={i}
                  role="option"
                  aria-selected={o.value === value}
                  className={`${o.value === value ? "sel" : ""}${i === cur ? " cur" : ""}`}
                  style={{ "--i": Math.min(i, 10) } as React.CSSProperties}
                  onPointerEnter={() => setCur(i)}
                  onClick={() => choose(o)}
                >
                  <span>{o.label}</span>
                  {o.hint && <em>{o.hint}</em>}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.600" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12.500 4.500 4.500L19 7.500" /></svg>
                </li>
              ))}
            </ul>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
