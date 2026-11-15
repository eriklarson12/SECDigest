import Link from "next/link";
import { REPO_URL } from "@/lib/site";

const LINK_CLASS =
  "inline-flex min-h-11 items-center px-2 text-muted underline decoration-border underline-offset-2 transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

/** On every page, so the caveat sits with the model's text and not only on the homepage. */
export default function SiteFooter() {
  return (
    <footer className="border-t border-border print:hidden">
      <div className="mx-auto flex max-w-4xl flex-col gap-x-6 px-4 py-4 font-sans text-2xs text-muted sm:flex-row sm:items-center sm:justify-between">
        <p className="py-2">
          Data from SEC EDGAR. Summaries are model-generated and can be wrong.
          Not investment advice.
        </p>
        <nav aria-label="Footer" className="-mx-2 flex shrink-0">
          <Link href="/evals" className={LINK_CLASS}>
            Eval history
          </Link>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={LINK_CLASS}
          >
            GitHub
          </a>
        </nav>
      </div>
    </footer>
  );
}
