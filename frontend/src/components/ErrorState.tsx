import Button from "./Button";

/** How much room a failure takes, which is a property of what failed rather than
 * of the message it carries. */
const INSET = {
  /** The route itself failed — nothing else is on screen to sit next to. */
  page: "py-20 text-center",
  /** One section of an otherwise painted page failed. */
  section: "py-10 text-center",
  /** Appended under content that is still there: a next page that did not load,
   * a card whose own fetch failed. Left-aligned, because that content is. */
  inline: "mt-4",
} as const;

const MESSAGE_CLASS = "text-sm text-negative";

/** Every failed load renders through here. The rule that an error view carries
 * friendly copy and a Retry (docs/design-system.md) was never actually broken;
 * what drifted was the answer to *which* button, which had split across both
 * variants, and how much room the failure takes. */
export default function ErrorState({
  message,
  onRetry,
  retryLabel = "Retry",
  inset = "section",
}: {
  message: string;
  /** Omitted only where there is nothing to retry. */
  onRetry?: () => void;
  /** For a retry that resumes rather than repeats, such as a next page. */
  retryLabel?: string;
  inset?: keyof typeof INSET;
}) {
  return (
    <div className={INSET[inset]}>
      <p role="alert" className={MESSAGE_CLASS}>
        {message}
      </p>
      {onRetry && (
        <div className="mt-3">
          <Button variant="secondary" onClick={onRetry}>
            {retryLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

/** A failure that leaves the page standing: an action that did not go through,
 * rather than a region that never arrived. Bordered instead of centered, because
 * the content it interrupts is still on screen and still usable. */
export function ErrorNotice({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="border border-negative/30 bg-negative/10 px-4 py-3">
      <p role="alert" className={MESSAGE_CLASS}>
        {message}
      </p>
      {onRetry && (
        <div className="mt-3">
          <Button variant="secondary" onClick={onRetry}>
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}
