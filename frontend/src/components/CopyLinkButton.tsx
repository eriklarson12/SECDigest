"use client";

import { useEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import Button from "@/components/Button";

const COPIED_MS = 2_000;

/** Copies a link and says so. The clipboard is refused outside a secure context or
 * without permission, so the link is then shown selected for a manual copy. */
export default function CopyLinkButton({
  getUrl,
  icon,
  label,
  copiedLabel,
  status,
  fallbackLabel,
  align = "end",
}: {
  /** Read on click, so the link reflects the page as it is then. */
  getUrl: () => string;
  icon: LucideIcon;
  label: string;
  copiedLabel: string;
  /** Announced to a screen reader once the copy succeeds. */
  status: string;
  /** Names the fallback field. */
  fallbackLabel: string;
  align?: "start" | "end";
}) {
  const [copied, setCopied] = useState(false);
  const [fallback, setFallback] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  async function copy() {
    const url = getUrl();
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
    <div
      className={`flex flex-col gap-2 ${align === "end" ? "items-end" : "items-start"}`}
    >
      <Button icon={icon} onClick={copy}>
        {copied ? copiedLabel : label}
      </Button>
      <span role="status" className="sr-only">
        {copied ? status : ""}
      </span>
      {fallback && (
        <input
          readOnly
          value={fallback}
          aria-label={fallbackLabel}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          className="w-72 max-w-full border border-border bg-surface px-3 py-2 font-sans text-xs text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        />
      )}
    </div>
  );
}
