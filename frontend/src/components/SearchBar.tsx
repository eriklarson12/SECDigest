"use client";

import { useState, useEffect, useRef } from "react";
import { History, SearchX } from "lucide-react";
import { searchCompanies } from "@/lib/api";
import { addRecent, getRecent } from "@/lib/recentSearches";
import type { CompanySearchResult } from "@/lib/types";

interface SearchBarProps {
  onSelect: (company: CompanySearchResult) => void;
}

export default function SearchBar({ onSelect }: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CompanySearchResult[]>([]);
  const [recents, setRecents] = useState<CompanySearchResult[]>([]);
  const [showingRecents, setShowingRecents] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);

  // The visible option list — either live results or the recents shortcut
  const options = showingRecents ? recents : results;

  // Search is driven by the change handler, not an effect — this only cleans
  // up a pending debounce on unmount.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  /** Focus/empty-input path: offer recent selections (localStorage, lazy read). */
  function openRecents() {
    const stored = getRecent();
    setRecents(stored);
    setShowingRecents(true);
    setActiveIndex(-1);
    setIsOpen(stored.length > 0);
  }

  function handleChange(value: string) {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (value.trim().length < 1) {
      setResults([]);
      setHasSearched(false);
      openRecents();
      return;
    }

    setShowingRecents(false);
    debounceRef.current = setTimeout(async () => {
      setIsLoading(true);
      try {
        const data = await searchCompanies(value);
        setResults(data);
        setActiveIndex(-1);
        setHasSearched(true);
        setShowingRecents(false);
        setIsOpen(true);
      } catch {
        setResults([]);
        setHasSearched(false);
        setIsOpen(false);
      } finally {
        setIsLoading(false);
      }
    }, 300);
  }

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function handleSelect(company: CompanySearchResult) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    addRecent(company);
    setQuery(`${company.ticker} — ${company.name}`);
    setIsOpen(false);
    setShowingRecents(false);
    setActiveIndex(-1);
    onSelect(company);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!isOpen || options.length === 0) {
      if (e.key === "Escape") setIsOpen(false);
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % options.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => (i <= 0 ? options.length - 1 : i - 1));
        break;
      case "Enter":
        if (activeIndex >= 0) {
          e.preventDefault();
          handleSelect(options[activeIndex]);
        }
        break;
      case "Escape":
        setIsOpen(false);
        setActiveIndex(-1);
        break;
    }
  }

  const showNoResults =
    isOpen && !showingRecents && hasSearched && !isLoading && results.length === 0;

  return (
    <div ref={containerRef} className="relative w-full max-w-xl">
      <input
        type="text"
        role="combobox"
        aria-expanded={isOpen}
        aria-controls="company-listbox"
        aria-activedescendant={
          activeIndex >= 0 ? `company-option-${activeIndex}` : undefined
        }
        aria-label="Search ticker or company name"
        value={query}
        onChange={(e) => handleChange(e.target.value)}
        onFocus={() => {
          if (query.trim().length < 1) openRecents();
        }}
        onKeyDown={handleKeyDown}
        placeholder="Search ticker or company name (e.g. AAPL, Microsoft)..."
        className="h-12 w-full rounded-lg border border-border bg-surface px-4 text-text placeholder:text-muted transition-colors duration-200 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40"
      />
      {isLoading && (
        <div className="absolute right-3 top-3.5" aria-hidden>
          <div className="h-5 w-5 motion-safe:animate-spin rounded-full border-2 border-border border-t-primary" />
        </div>
      )}
      {isOpen && options.length > 0 && (
        <ul
          id="company-listbox"
          role="listbox"
          className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-border bg-surface-2 shadow-lg shadow-black/40"
        >
          {showingRecents && (
            <li
              aria-hidden
              className="flex items-center gap-1.5 px-4 pb-1 pt-2.5 text-xs font-medium uppercase tracking-wide text-muted"
            >
              <History className="h-3.5 w-3.5" strokeWidth={1.5} />
              Recent
            </li>
          )}
          {options.map((company, i) => (
            <li
              key={company.cik}
              id={`company-option-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              onClick={() => handleSelect(company)}
              onMouseEnter={() => setActiveIndex(i)}
              className={`cursor-pointer px-4 py-3 transition-colors duration-150 ${
                i === activeIndex ? "bg-primary/15" : ""
              }`}
            >
              <span className="font-mono font-semibold text-primary">
                {company.ticker}
              </span>
              <span className="ml-2 text-text">{company.name}</span>
              <span className="ml-2 font-mono text-xs tabular-nums text-muted">
                CIK: {company.cik}
              </span>
            </li>
          ))}
        </ul>
      )}
      {showNoResults && (
        <div className="absolute z-10 mt-1 flex w-full items-center gap-2 rounded-lg border border-border bg-surface-2 px-4 py-3 text-sm text-muted shadow-lg shadow-black/40">
          <SearchX className="h-4 w-4" strokeWidth={1.5} aria-hidden />
          No companies found for &ldquo;{query}&rdquo;
        </div>
      )}
    </div>
  );
}
