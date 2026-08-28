/** Content-shaped loading placeholders — used for every GET load >300ms
 * (docs/design-system.md). Dimensions match the final content so nothing shifts. */

function Block({ className = "" }: { className?: string }) {
  return (
    <div className={`bg-surface-2 motion-safe:animate-pulse ${className}`} />
  );
}

export function SkeletonCard() {
  return (
    <div className="border-t border-text pt-4">
      <Block className="h-4 w-24" />
      <Block className="mt-3 h-8 w-36" />
      <Block className="mt-3 h-4 w-20" />
    </div>
  );
}

export function SkeletonChart() {
  return (
    <div className="border-t border-text pt-4">
      <Block className="h-4 w-40" />
      <Block className="mt-4 h-[250px] w-full" />
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
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SkeletonCard />
        <SkeletonCard />
      </div>
      <div className="mt-6">
        <SkeletonChart />
      </div>
    </div>
  );
}
