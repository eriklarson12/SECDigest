/** Splits an answer's "(excerpt N)" markers into linkable pieces (roadmap 13.2).
 *
 * The model writes the forms its prompt shows and a few it doesn't: "(excerpt 2)",
 * "(excerpts 1, 3)", "(excerpt 1 and 4)" and, because the prompt numbers excerpts "[1]",
 * "(excerpts [1], [2])". Same family as the backend's `_CITATION_RE` in `evals/qa_scoring.py`. */

export type AnswerSegment =
  | { kind: "text"; text: string }
  /** `source` is 0-based: "(excerpt 2)" is sources[1]. */
  | { kind: "cite"; text: string; source: number };

const MARKER = /\(\s*excerpts?\s+[[\]\d\s,and&-]+\)/gi;
const NUMBER = /\d+/g;

export function splitCitations(
  answer: string,
  sourceCount: number,
): AnswerSegment[] {
  const segments: AnswerSegment[] = [];
  let buffer = "";
  let last = 0;

  const flush = () => {
    if (buffer) segments.push({ kind: "text", text: buffer });
    buffer = "";
  };

  for (const marker of answer.matchAll(MARKER)) {
    const start = marker.index ?? 0;
    buffer += answer.slice(last, start);
    let cursor = 0;
    for (const number of marker[0].matchAll(NUMBER)) {
      const at = number.index ?? 0;
      buffer += marker[0].slice(cursor, at);
      const source = Number(number[0]) - 1;
      if (source >= 0 && source < sourceCount) {
        flush();
        segments.push({ kind: "cite", text: number[0], source });
      } else {
        // A number the response has no source for stays plain text, never a dead link.
        buffer += number[0];
      }
      cursor = at + number[0].length;
    }
    buffer += marker[0].slice(cursor);
    last = start + marker[0].length;
  }
  buffer += answer.slice(last);
  flush();
  return segments;
}
