'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Re-fetches the server-rendered page data on an interval, so a dashboard tab
 * left open doesn't freeze at its load-time snapshot. Everything except the
 * Systemstatus/Dispatch polls (which fetch their own API routes) is server
 * props — the price chart, dispatch plan, planned/actual SoC overlay, and the
 * "Imorgons priser" notice — and the header chrome says "Live", so without
 * this an evening viewer sees the morning's plan styled as current.
 *
 * router.refresh() re-renders the server components without touching the
 * server-side 'use cache' entries: fetchPrices stays cached until its own
 * maxAge (spot prices don't change intraday), while the optimizer run and
 * telemetry reads re-execute. Each refresh therefore also logs a fresh
 * optimizer_runs row — same as any real page view, and only while a tab is
 * actually open AND visible (hidden tabs skip ticks; a tab becoming visible
 * again catches up at most once per interval).
 */
export default function AutoRefresh({ intervalMs = 5 * 60_000 }: { intervalMs?: number }) {
  const router = useRouter();
  const lastRefresh = useRef(Date.now());

  useEffect(() => {
    const refreshIfDue = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastRefresh.current < intervalMs) return;
      lastRefresh.current = Date.now();
      router.refresh();
    };
    const id = setInterval(refreshIfDue, Math.min(intervalMs, 60_000));
    document.addEventListener('visibilitychange', refreshIfDue);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', refreshIfDue);
    };
  }, [router, intervalMs]);

  return null;
}
