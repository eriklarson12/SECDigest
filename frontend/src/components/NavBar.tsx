"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/compare", label: "Compare" },
  { href: "/watchlist", label: "Watchlist" },
  { href: "/history", label: "History" },
];

export default function NavBar() {
  const pathname = usePathname();

  return (
    <nav className="border-b border-text bg-bg">
      <div className="mx-auto flex max-w-4xl items-baseline justify-between px-4 py-3">
        <Link
          href="/"
          className="text-lg font-semibold text-text transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          SECDigest
        </Link>
        {/* 4 links + wordmark must fit a 375px viewport — tighter gap below sm */}
        <div className="flex gap-3 font-sans text-[11px] tracking-[0.06em] sm:gap-5">
          {LINKS.map(({ href, label }) => {
            const active =
              href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={`pb-0.5 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                  active
                    ? "border-b-2 border-primary text-text"
                    : "text-muted hover:text-text"
                }`}
              >
                {label}
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
