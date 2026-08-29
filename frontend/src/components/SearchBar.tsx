"use client";

import { useState, useEffect, useRef } from "react";
import { History, SearchX, X } from "lucide-react";
import { searchCompanies } from "@/lib/api";
import { addRecent, getRecent } from "@/lib/recentSearches";
import { useSlashFocus } from "@/lib/useSlashFocus";
import type { CompanySearchResult } from "@/lib/types";

interface SearchBarProps {
  onSelect: (company: CompanySearchResult) => void;
  /** Empty the box after a pick. For surfaces that collect companies one after
   * another (/benchmark): leaving the last name in place means the next search
   * has to be cleared by hand before it can be typed. */
  clearOnSelect?: boolean;
}

export default function SearchBar({
  onSelect,
  clearOnSelect = false,
}: SearchBarProps) {
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
  const inputRef = useRef<HTMLInputElement>(null);

  useSlashFocus(inputRef);

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
    setQuery(clearOnSelect ? "" : `${company.ticker} — ${company.name}`);
    setIsOpen(false);
    setShowingRecents(false);
    setActiveIndex(-1);
    onSelect(company);
  }

  function clearQuery() {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setQuery("");
    setResults([]);
    setHasSearched(false);
    setIsOpen(false);
    setActiveIndex(-1);
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // Escape with the list closed clears the box; with it open it closes the
    // list first, so one press never does both.
    if (!isOpen || options.length === 0) {
      if (e.key === "Escape") {
        if (isOpen) setIsOpen(false);
        else if (query) clearQuery();
      }
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
    isOpen &&
    !showingRecents &&
    hasSearched &&
    !isLoading &&
    results.length === 0;

  return (
    <div ref={containerRef} className="relative w-full max-w-xl">
      <input
        ref={inputRef}
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
        className="h-12 w-full border-0 border-b border-text bg-transparent px-1 text-lg text-text placeholder:text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      />
      {isLoading ? (
        <div className="absolute right-3 top-3.5" aria-hidden>
          <div className="h-5 w-5 motion-safe:animate-spin border-2 border-border border-t-primary" />
        </div>
      ) : (
        query.length > 0 && (
          <button
            type="button"
            onClick={clearQuery}
            aria-label="Clear search"
            className="absolute right-0 top-0 flex h-12 w-11 cursor-pointer items-center justify-center text-muted transition-colors duration-150 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <X className="h-5 w-5" strokeWidth={1.5} aria-hidden />
          </button>
        )
      )}
      {isOpen && options.length > 0 && (
        <ul
          id="company-listbox"
          role="listbox"
          className="absolute z-10 max-h-60 w-full overflow-auto border border-text bg-bg"
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
                i === activeIndex ? "bg-surface-2" : ""
              }`}
            >
              <span className="font-sans font-semibold text-primary">
                {company.ticker}
              </span>
              <span className="ml-2 text-text">{company.name}</span>
              <span className="ml-2 font-sans text-xs tabular-nums text-muted">
                CIK: {company.cik}
              </span>
            </li>
          ))}
        </ul>
      )}
      {showNoResults && (
        <div className="absolute z-10 flex w-full items-center gap-2 border border-text bg-bg px-4 py-3 text-sm text-muted">
          <SearchX className="h-4 w-4" strokeWidth={1.5} aria-hidden />
          No companies found for &ldquo;{query}&rdquo;
        </div>
      )}
    </div>
  );
}
