"use client";

import { useEffect, useState } from "react";
import { ListPlus } from "lucide-react";
import { lookupCompany } from "@/lib/companyLookup";
import { formatList } from "@/lib/format";
import {
  MAX_ITEMS,
  getWatchlist,
  importWatchlist,
  parseImportParam,
} from "@/lib/watchlist";
import type { WatchItem } from "@/lib/types";
import Button from "@/components/Button";

interface Checked {
  found: WatchItem[];
  already: string[];
  missing: string[];
  /** A lookup that failed (offline, rate limit) is not evidence the ticker is unknown. */
  unchecked: string[];
  room: number;
}

function companies(n: number): string {
  return `${n} ${n === 1 ? "company" : "companies"}`;
}

function verb(tickers: string[]): string {
  return tickers.length === 1 ? "is" : "are";
}

function importedNotice(added: number, skipped: number): string {
  if (added === 0 && skipped === 0)
    return "Nothing added: those companies are already on your watchlist.";
  if (added === 0)
    return `Nothing added: the watchlist already holds ${MAX_ITEMS}.`;
  if (skipped === 0) return `Added ${companies(added)}.`;
  return `Added ${companies(added)}; ${skipped} skipped because the watchlist holds ${MAX_ITEMS}.`;
}

/** The confirm step for a `?import=` link (roadmap 14.2). Anyone can send a
 * link, so nothing is written until Add; `onClose` gets the outcome to show, or
 * null when the user backed out. */
export default function WatchlistImport({
  raw,
  onClose,
}: {
  raw: string;
  onClose: (notice: string | null) => void;
}) {
  const [checking, setChecking] = useState(0);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      // localStorage is read after a microtask — no synchronous setState here
      await Promise.resolve();
      if (cancelled) return;
      const tickers = parseImportParam(raw);
      const current = getWatchlist();
      const watched = new Set(current.map((c) => c.ticker));
      const toCheck = tickers.filter((t) => !watched.has(t));
      setChecked(null);
      setChecking(toCheck.length);

      const settled = await Promise.allSettled(
        toCheck.map(lookupCompany),
      );
      if (cancelled) return;
      const result: Checked = {
        found: [],
        already: tickers.filter((t) => watched.has(t)),
        missing: [],
        unchecked: [],
        room: MAX_ITEMS - current.length,
      };
      settled.forEach((outcome, i) => {
        const ticker = toCheck[i];
        if (outcome.status === "rejected") {
          result.unchecked.push(ticker);
          return;
        }
        const match = outcome.value;
        if (match) {
          result.found.push({
            ticker: match.ticker,
            cik: match.cik,
            name: match.name,
          });
        } else {
          result.missing.push(ticker);
        }
      });
      setChecked(result);
    }

    check();
    return () => {
      cancelled = true;
    };
  }, [raw]);

  function add() {
    if (!checked) return;
    const result = importWatchlist(checked.found);
    if (!result) {
      setSaveFailed(true);
      return;
    }
    onClose(importedNotice(result.added.length, result.skipped));
  }

  const canAdd = checked !== null && checked.found.length > 0 && checked.room > 0;
  const nothingParsed =
    checked !== null &&
    checked.found.length +
      checked.already.length +
      checked.missing.length +
      checked.unchecked.length ===
      0;

  return (
    <div
      role="status"
      className="mb-6 flex items-start gap-2 border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-text"
    >
      <ListPlus
        className="mt-0.5 h-4 w-4 shrink-0 text-accent"
        strokeWidth={1.5}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        {checked === null ? (
          <p>
            Checking {checking} {checking === 1 ? "ticker" : "tickers"}…
          </p>
        ) : (
          <>
            {checked.found.length > 0 && (
              <>
                <p className="font-semibold">
                  Add {companies(checked.found.length)} to your watchlist?
                </p>
                <ul className="mt-2 space-y-0.5">
                  {checked.found.map((c) => (
                    <li key={c.ticker}>
                      <span className="font-sans font-semibold">
                        {c.ticker}
                      </span>{" "}
                      <span className="text-muted">{c.name}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div className="mt-2 space-y-0.5 text-muted first:mt-0">
              {nothingParsed && <p>This link has no tickers in it.</p>}
              {checked.already.length > 0 && (
                <p>
                  {formatList(checked.already)} {verb(checked.already)} already
                  on your watchlist.
                </p>
              )}
              {checked.missing.length > 0 && (
                <p>
                  {formatList(checked.missing)}{" "}
                  {checked.missing.length === 1 ? "wasn't" : "weren't"} found.
                </p>
              )}
              {checked.unchecked.length > 0 && (
                <p>Couldn&apos;t check {formatList(checked.unchecked)}.</p>
              )}
              {checked.found.length > 0 && checked.room <= 0 && (
                <p>
                  Your watchlist is full at {MAX_ITEMS} companies, so none can
                  be added.
                </p>
              )}
              {checked.room > 0 && checked.found.length > checked.room && (
                <p>
                  Your watchlist has room for {checked.room}, so{" "}
                  {checked.found.length - checked.room} will be skipped.
                </p>
              )}
              {saveFailed && (
                <p>Couldn&apos;t save to this browser&apos;s storage.</p>
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {canAdd ? (
                <>
                  <Button onClick={add}>Add</Button>
                  <Button variant="secondary" onClick={() => onClose(null)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button variant="secondary" onClick={() => onClose(null)}>
                  Dismiss
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
