"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

const KEY = "gm-web-session";
export class ApiFail extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}
interface Ctx {
  token: string | null;
  ready: boolean;
  call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T>;
  signOut(): void;
}
const C = createContext<Ctx | null>(null);
export const useSession = () => {
  const v = useContext(C);
  if (!v) throw new Error("SessionProvider missing");
  return v;
};

/** Token arrives in the URL fragment (never sent to servers or logs), is moved to sessionStorage, and removed from the address bar. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let t = new URLSearchParams(window.location.hash.slice(1)).get("t");
    try {
      if (t) window.sessionStorage.setItem(KEY, t);
      else t = window.sessionStorage.getItem(KEY);
    } catch {
      /* in-memory only */
    }
    if (t && window.location.hash) window.history.replaceState(null, "", window.location.pathname + window.location.search);
    setToken(t);
    setReady(true);
  }, []);
  const signOut = useCallback(() => {
    try {
      window.sessionStorage.removeItem(KEY);
    } catch {}
    setToken(null);
  }, []);
  const call = useCallback(
    async <T,>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
      if (!token) throw new ApiFail(401, "Belum masuk.");
      const res = await fetch(path, {
        method,
        signal,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      if (res.status === 401 && !data.code) signOut();
      if (!res.ok) throw new ApiFail(res.status, data.error ?? `Permintaan gagal (${res.status})`, data.code);
      return data as T;
    },
    [token, signOut],
  );
  const value = useMemo(() => ({ token, ready, call, signOut }), [token, ready, call, signOut]);
  return <C.Provider value={value}>{children}</C.Provider>;
}
