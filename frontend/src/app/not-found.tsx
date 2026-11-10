import type { Metadata } from "next";
import { FileQuestion } from "lucide-react";
import EmptyState from "@/components/EmptyState";

export const metadata: Metadata = { title: "Page not found" };

// Next's built-in 404 follows the OS color scheme and ignores the theme: it rendered a black
// page under the nav for any reader in dark mode.
export default function NotFound() {
  return (
    <EmptyState
      icon={FileQuestion}
      title="Page not found"
      message="That address doesn't match anything here. The link may be wrong or out of date."
      action={{ href: "/", label: "Search a ticker" }}
    />
  );
}
