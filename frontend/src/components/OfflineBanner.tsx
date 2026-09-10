"use client";

import { useOffline } from "next/offline";
import { WifiOff } from "lucide-react";

/** Connectivity notice, above the nav so it is the first thing on the page.
 *
 * `useOffline` rather than `navigator.onLine`: that property reports true for a
 * machine on a network with no route to the internet, which is the captive
 * wifi case this banner exists for. The hook also flips on a framework request
 * that actually failed, and returns false during SSR and until hydration, so
 * there is no mismatch to guard against. It needs `experimental.useOffline` in
 * next.config.ts and returns false without it.
 */
export default function OfflineBanner() {
  const isOffline = useOffline();
  if (!isOffline) return null;

  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 border-b border-border bg-surface-2 px-4 py-1.5 font-sans text-2xs tracking-[0.06em] text-muted"
    >
      <WifiOff className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
      Offline. Showing what was saved on this device.
    </div>
  );
}
