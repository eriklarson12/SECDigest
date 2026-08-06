/** Full-page progress state — reserved for the long analyze POST only.
 * GET loads use the content-shaped Skeleton components instead. */
export default function LoadingState({
  message = "Reading the filing…",
}: {
  message?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-20" role="status">
      <div className="h-12 w-12 motion-safe:animate-spin rounded-full border-4 border-border border-t-primary" aria-hidden />
      <p className="mt-4 text-text">{message}</p>
      <p className="mt-1 text-sm text-muted">
        Large filings take 10–60 seconds to analyze
      </p>
    </div>
  );
}
