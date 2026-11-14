"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/compare", label: "Compare" },
  { href: "/watchlist", label: "Watchlist" },
  { href: "/benchmark", label: "Benchmark" },
  { href: "/history", label: "All analyses" },
];

export default function NavBar() {
  const pathname = usePathname();

  return (
    <nav aria-label="Site" className="border-b border-text bg-bg print:hidden">
      <div className="mx-auto flex max-w-4xl flex-col px-4 pt-1 sm:flex-row sm:items-center sm:justify-between sm:py-1">
        <Link
          href="/"
          className="self-start text-lg font-semibold sm:self-auto text-text transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          SECDigest
        </Link>
        {/* Below sm the links take their own row: beside the wordmark they wrapped to two.
            Padding replaces the gap so the 44px targets touch. At 320px the five labels
            leave 8px with the tracking on, so the tracking starts at sm. */}
        <div className="-mx-2 flex font-sans text-2xs sm:-mr-2.5 sm:ml-0 sm:tracking-[0.06em]">
          {LINKS.map(({ href, label }) => {
            const active =
              href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={`inline-flex min-h-11 flex-auto items-center justify-center whitespace-nowrap transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:flex-none sm:px-2.5 ${
                  active ? "text-text" : "text-muted hover:text-text"
                }`}
              >
                <span
                  className={`border-b-2 pb-0.5 ${
                    active ? "border-primary" : "border-transparent"
                  }`}
                >
                  {label}
                </span>
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
