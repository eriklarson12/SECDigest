/** Content-shaped loading placeholders — used for every GET load >300ms
 * (docs/design-system.md). Dimensions match the final content so nothing shifts. */

function Block({ className = "" }: { className?: string }) {
  return (
    <div className={`bg-surface-2 motion-safe:animate-pulse ${className}`} />
  );
}

/** `InsightCard`, which draws no rule of its own — 18px label, 36px figure,
 * 17px delta. */
export function SkeletonMetric() {
  return (
    <div>
      <Block className="h-[18px] w-24" />
      <Block className="mt-1 h-9 w-32" />
      <Block className="mt-1.5 h-[17px] w-40" />
    </div>
  );
}

/** `CompareColumn`'s header block plus the two figures under it. The `border-t-2`
 * is the column's identity accent, not a section rule — the one documented
 * exception to the underline (docs/design-system.md) — so the placeholder carries
 * it in the same hue the loaded column will, and nothing recolours on arrival.
 * The summary and risk sections below are deliberately absent: their height is
 * the length of prose nobody has fetched yet, so any block drawn for them is a
 * guess that shifts. */
export function SkeletonCompareColumn({ side }: { side: 0 | 1 }) {
  return (
    <div className="space-y-4">
      <div
        className={`border-t-2 pt-4 ${
          side === 0 ? "border-t-series-a" : "border-t-series-b"
        }`}
      >
        <Block className="h-8 w-32" />
        <Block className="mt-1 h-[21px] w-44" />
        <Block className="h-[18px] w-36" />
        <Block className="mt-3 h-[23px] w-36" />
      </div>
      <SkeletonMetric />
      <SkeletonMetric />
    </div>
  );
}

/** A watchlist card: bordered and filled, with no top rule at all. The ticker row
 * is 44px because a `WatchStar` sits in it. */
export function SkeletonWatchCard() {
  return (
    <div className="border border-border bg-surface p-4">
      <Block className="h-11 w-24" />
      <Block className="mt-1 h-[17px] w-32" />
      <Block className="mt-3 h-6 w-28" />
      <Block className="mt-3 h-[24px] w-24" />
    </div>
  );
}

export function SkeletonChart() {
  return (
    <div>
      <div className="border-b border-text pb-1.5">
        <Block className="h-4 w-40" />
      </div>
      <Block className="mt-3 h-[250px] w-full" />
    </div>
  );
}

export function SkeletonTableRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }, (_, i) => (
        <Block key={i} className="h-11 w-full" />
      ))}
    </div>
  );
}

export function SkeletonFilingList({ rows = 4 }: { rows?: number }) {
  return (
    <div className="mt-6 w-full max-w-xl space-y-2">
      <Block className="h-6 w-48" />
      {Array.from({ length: rows }, (_, i) => (
        <Block key={i} className="h-14 w-full" />
      ))}
    </div>
  );
}

export function SkeletonHeader() {
  return (
    <div>
      <Block className="h-8 w-40" />
      <Block className="mt-2 h-4 w-64" />
    </div>
  );
}

export function SkeletonDashboard() {
  return (
    <div>
      <SkeletonHeader />
      <div className="mt-6 flex flex-col gap-6 sm:flex-row sm:gap-14">
        <SkeletonMetric />
        <SkeletonMetric />
      </div>
      <div className="mt-6">
        <SkeletonChart />
      </div>
    </div>
  );
}
