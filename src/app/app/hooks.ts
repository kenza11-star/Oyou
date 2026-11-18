"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession, ApiFail } from "./session";

export interface Job {
  id: string; fileName: string | null; repoFullName: string | null; branch: string | null; status: string; stage: string | null;
  totalBytes: number; bytesVerified: number; filesTotal: number | null; filesProcessed: number; added: number; updated: number; unchanged: number;
  commitSha: string | null; commitUrl: string | null; error: string | null; actionsRunUrl: string | null; createdAt: string; completedAt: string | null;
  canCancel: boolean; canRetry: boolean;
}
export interface Me {
  github: { login: string } | null;
  selection: { repoId: number; repoFullName: string; branch: string } | null;
  installUrl: string;
  instantProcessing: boolean;
}

/** Fetches once and re-fetches every `everyMs` while `active` returns true and the tab is visible. */
export function useApi<T>(path: string, opts: { everyMs?: number; active?: (d: T) => boolean } = {}) {
  const { call, token } = useSession();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiFail | null>(null);
  const [loading, setLoading] = useState(true);
  const activeRef = useRef(opts.active);
  activeRef.current = opts.active;
  const load = useCallback(async () => {
    try {
      setData(await call<T>("GET", path));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiFail ? e : new ApiFail(0, "Jaringan bermasalah."));
    } finally {
      setLoading(false);
    }
  }, [call, path]);
  useEffect(() => {
    if (!token) return;
    void load();
  }, [load, token]);
  useEffect(() => {
    if (!opts.everyMs || !data || !activeRef.current?.(data)) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, opts.everyMs);
    return () => window.clearInterval(id);
  }, [data, load, opts.everyMs]);
  return { data, error, loading, reload: load };
}
