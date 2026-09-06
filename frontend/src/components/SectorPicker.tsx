import Link from "next/link";
import { withParam } from "@/lib/query";
import {
  compareSectors,
  formatSector,
  UNCLASSIFIED_SECTOR,
} from "@/lib/format";
import type { SectorCount } from "@/lib/types";

interface SectorPickerProps {
  sectors: SectorCount[];
  /** The raw `?owner_org=` value, or null for the unfiltered page. */
  active: string | null;
  /** The page's current query string. Every entry rewrites `owner_org` and keeps the
   * rest, so picking a sector cannot drop an active `?sic=`. */
  params: { toString(): string };
}

/** The corpus by SEC review office, as a filter control (roadmap 8.6). 8.5 made the
 * sector reachable only from the homepage, which left `/history?owner_org=…` a dead end:
 * the page's one control was Clear, so pivoting to another sector meant navigating home.
 *
 * Counts are corpus-wide, like the homepage's. Exact whenever the sector is the only
 * filter; with a ticker or SIC filter also live they describe the corpus while the
 * caption below describes the match.
 *
 * Inline links in a caption, not chips — the longest office names ("Industrial
 * Applications and Services") wrap badly as chips at 375px. Same 8.5 call, and the same
 * touch-target exception the history page's own Clear button already takes. */
export default function SectorPicker({
  sectors,
  active,
  params,
}: SectorPickerProps) {
  if (sectors.length === 0) return null;

  // The corpus total is the sum of the buckets — nothing to fetch for it.
  const total = sectors.reduce((sum, s) => sum + s.count, 0);
  const entries = [
    { value: null, label: "All", count: total },
    ...[...sectors]
      .sort((a, b) => compareSectors(a.owner_org, b.owner_org))
      .map((s) => ({
        value: s.owner_org ?? UNCLASSIFIED_SECTOR,
        label: formatSector(s.owner_org),
        count: s.count,
      })),
  ];

  return (
    <nav
      aria-label="Filter by sector"
      className="mb-4 font-sans text-2xs text-muted"
      data-testid="sector-picker"
    >
      {entries.map((entry, i) => {
        const isActive = entry.value === active;
        return (
          <span key={entry.value ?? "all"}>
            {i > 0 && <span aria-hidden> · </span>}
            <Link
              href={withParam("/history", params, "owner_org", entry.value)}
              aria-current={isActive ? "page" : undefined}
              className={
                isActive
                  ? "text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  : "underline transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              }
            >
              {entry.label}
            </Link>
            {/* Non-breaking: at 375px this line wraps four times, and a normal space
                lets the count fall to the next line away from the office it counts.
                The label itself stays breakable. */}
            {"\u00a0"}
            <span className="tabular-nums">{entry.count}</span>
          </span>
        );
      })}
    </nav>
  );
}
