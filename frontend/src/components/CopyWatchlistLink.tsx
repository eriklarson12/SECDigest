"use client";

import { Link2 } from "lucide-react";
import { exportWatchlist } from "@/lib/watchlist";
import CopyLinkButton from "@/components/CopyLinkButton";

/** Copies the watchlist's import link (roadmap 14.2). */
export default function CopyWatchlistLink() {
  return (
    <CopyLinkButton
      getUrl={() => exportWatchlist(window.location.origin)}
      icon={Link2}
      label="Copy watchlist link"
      copiedLabel="Link copied"
      status="Watchlist link copied"
      fallbackLabel="Watchlist link"
    />
  );
}
