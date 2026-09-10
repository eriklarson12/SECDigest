import type { Metadata } from "next";
import { WifiOff } from "lucide-react";
import EmptyState from "@/components/EmptyState";

export const metadata: Metadata = {
  title: "Offline",
};

/** The service worker's navigation fallback: what a hard load of an uncached
 *  page renders with no network. Static by necessity -- anything it fetched
 *  would fail for the same reason it is being shown. */
export default function OfflinePage() {
  return (
    <EmptyState
      icon={WifiOff}
      title="You are offline"
      message="This page needs a connection. Your watchlist works without one, and everything else loads again once you are back."
      action={{ href: "/watchlist", label: "Go to watchlist" }}
    />
  );
}
