"use client";

import { useEffect, type RefObject } from "react";

/** Registered search inputs in mount order. `/compare` renders two SearchBars, so
 * every instance's handler focuses registry[0] rather than its own ref — otherwise
 * both fire and whichever mounted last wins. */
const registry: RefObject<HTMLInputElement | null>[] = [];

/** Duck-typed rather than `instanceof HTMLElement`: vitest runs in the node
 * environment, where that global doesn't exist. */
export function isTypingTarget(
  target: { tagName?: string; isContentEditable?: boolean } | null,
): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName?.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** "/" focuses the first search input on the page. Pages without a SearchBar never
 * bind the listener, so the key keeps its normal behaviour there. */
export function useSlashFocus(ref: RefObject<HTMLInputElement | null>): void {
  useEffect(() => {
    // Register and unregister must stay symmetric: Strict Mode runs
    // effect -> cleanup -> effect, and a stale entry would own the shortcut.
    registry.push(ref);

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target as HTMLElement | null)) return;
      const input = registry[0]?.current;
      if (!input) return;
      e.preventDefault();
      input.focus();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      registry.splice(registry.indexOf(ref), 1);
    };
  }, [ref]);
}
