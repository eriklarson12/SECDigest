import { describe, expect, it } from "vitest";

import { splitCitations, type AnswerSegment } from "@/lib/citations";

/** Rebuilds the visible text, so every test also proves nothing was dropped or duplicated. */
function joined(segments: AnswerSegment[]): string {
  return segments.map((s) => s.text).join("");
}

function cites(segments: AnswerSegment[]): number[] {
  return segments.flatMap((s) => (s.kind === "cite" ? [s.source] : []));
}

describe("splitCitations", () => {
  it("links a single marker to its 0-based source", () => {
    const answer = "Sales fell (excerpt 2).";
    const segments = splitCitations(answer, 6);
    expect(cites(segments)).toEqual([1]);
    expect(joined(segments)).toBe(answer);
    expect(segments).toEqual([
      { kind: "text", text: "Sales fell (excerpt " },
      { kind: "cite", text: "2", source: 1 },
      { kind: "text", text: ")." },
    ]);
  });

  it.each([
    ["(excerpts 1, 3)", [0, 2]],
    ["(excerpt 1 and 4)", [0, 3]],
    ["(excerpts [1], [2])", [0, 1]],
    ["(Excerpt 5)", [4]],
  ])("reads %s", (marker, expected) => {
    const answer = `It changed ${marker}.`;
    const segments = splitCitations(answer, 6);
    expect(cites(segments)).toEqual(expected);
    expect(joined(segments)).toBe(answer);
  });

  it("leaves a number with no source as plain text", () => {
    const answer = "It changed (excerpts 2, 9).";
    const segments = splitCitations(answer, 6);
    expect(cites(segments)).toEqual([1]);
    expect(joined(segments)).toBe(answer);
  });

  it("leaves figures outside a marker alone", () => {
    const answer =
      "Revenue was $416,161 million in 2025 (excerpt 1); 3 segments grew.";
    const segments = splitCitations(answer, 6);
    expect(cites(segments)).toEqual([0]);
    expect(joined(segments)).toBe(answer);
  });

  it("returns one text segment for an answer with no markers", () => {
    expect(splitCitations("No excerpt says.", 6)).toEqual([
      { kind: "text", text: "No excerpt says." },
    ]);
  });

  it("returns nothing for an empty answer", () => {
    expect(splitCitations("", 6)).toEqual([]);
  });
});
