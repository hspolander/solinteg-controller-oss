'use client';

import { useEffect, useState } from 'react';
import type { InverterLiveData } from '@/lib/inverter';
import type { DispatchCardData } from '@/lib/dispatch-card';
import PowerFlowCard from '@/app/components/PowerFlowCard';
import DispatchCard from '@/app/components/DispatchCard';

const POLL_MS = 10_000;

// Keeps Systemstatus live between page loads by polling the existing /api/inverter route
// (same readLiveInverterData() the server render used for the first paint). DispatchCard
// polls its own /api/dispatch route independently (see that component) since dispatch
// decisions and inverter telemetry are different data sources on different natural
// cadences. Batterihälsa no longer exists as a separate card (v5 — merged into
// PowerFlowCard/Systemstatus); Elhandel no longer needs to live in this client component
// either, since it doesn't share a grid cell with anything anymore — it's back in page.tsx
// as a plain server-rendered sibling.
export default function LiveInverterPanel({
  initialData,
  initialDispatchData,
}: {
  initialData: InverterLiveData | null;
  initialDispatchData: DispatchCardData | null;
}) {
  const [data, setData] = useState(initialData);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch('/api/inverter', { cache: 'no-store' });
        const next = res.ok ? ((await res.json()) as InverterLiveData) : null;
        if (!cancelled) setData(next);
      } catch {
        if (!cancelled) setData(null);
      }
    };
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Systemstatus + Dispatch: one grid cell, column 3, spanning BOTH rows, vertical flex
  // column (unchanged from v4). `contents` (default, narrow) dissolves this wrapper so its
  // children fall back to being ordinary flattened grid items, positioned by their own
  // `order` classes in the single-column stack. At ≥1600px it becomes a real flex container
  // occupying its grid cell on its own: Systemstatus (flex-1) stretches to consume whatever's
  // left, Dispatch keeps its natural height below it.
  return (
    <div className="contents min-[1600px]:flex min-[1600px]:flex-col min-[1600px]:gap-5 min-[1600px]:[grid-column:3] min-[1600px]:[grid-row:1/span_2]">
      <PowerFlowCard data={data} />
      <DispatchCard initialData={initialDispatchData} />
    </div>
  );
}
