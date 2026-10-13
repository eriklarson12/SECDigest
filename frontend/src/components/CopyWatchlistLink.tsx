"use client";

import { useEffect, useRef, useState } from "react";
import { Link2 } from "lucide-react";
import { exportWatchlist } from "@/lib/watchlist";
import Button from "@/components/Button";

const COPIED_MS = 2_000;

/** Copies the watchlist's import link (roadmap 14.2). The clipboard is refused
 * outside a secure context or without permission, so the link is then shown
 * selected for a manual copy. */
export default function CopyWatchlistLink() {
  const [copied, setCopied] = useState(false);
  const [fallback, setFallback] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  async function copy() {
    const url = exportWatchlist(window.location.origin);
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      setFallback(url);
      return;
    }
    setFallback(null);
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <Button icon={Link2} onClick={copy}>
        {copied ? "Link copied" : "Copy link"}
      </Button>
      <span role="status" className="sr-only">
        {copied ? "Watchlist link copied" : ""}
      </span>
      {fallback && (
        <input
          readOnly
          value={fallback}
          aria-label="Watchlist link"
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          className="w-72 max-w-full border border-border bg-surface px-3 py-2 font-sans text-xs text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        />
      )}
    </div>
  );
}
