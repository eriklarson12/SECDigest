import Link from "next/link";
import { formatIndustry } from "@/lib/format";

/** The filer's SEC classification, under the company name on the analysis and company
 * headers. A plain wrapping line rather than a badge — see docs/design-system.md.
 *
 * Links to the filtered history only when a code is present: `formatIndustry` also
 * handles a description arriving with no code, and that has no filter to point at. */
export default function IndustryLine({
  sic,
  sicDescription,
}: {
  sic: string | null;
  sicDescription: string | null;
}) {
  const label = formatIndustry(sic, sicDescription);
  if (!label) return null;

  return (
    <p className="font-sans text-2xs text-muted" data-testid="industry-badge">
      {sic ? (
        <Link
          href={`/history?sic=${sic}`}
          className="transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {label}
        </Link>
      ) : (
        label
      )}
    </p>
  );
}
