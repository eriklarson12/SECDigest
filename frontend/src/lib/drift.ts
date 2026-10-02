/** Language drift (roadmap 12.1): everything the card decides, kept out of the component so it
 * can be tested. Vitest runs in a node environment against `.test.ts` files only. */

import { formatDate, formatShare } from "./format";
import type { DriftResponse } from "./types";

export type DriftView =
  | { kind: "note"; text: string }
  | {
      kind: "ready";
      priorDate: string;
      priorLabel: string;
      figure: string;
      passages: string[];
    };

/** One muted line for the two states with nothing to show, never an empty card. */
export function driftView(data: DriftResponse, formType: string): DriftView {
  if (data.state === "no_prior") {
    return {
      kind: "note",
      text: `No earlier ${formType} has been analyzed here to compare this filing's wording against.`,
    };
  }
  const priorLabel = `${data.prior_form_type ?? formType} filed ${formatDate(data.prior_filing_date)}`;
  if (data.state === "not_indexed" || data.carried_over === null) {
    return {
      kind: "note",
      text: `Wording is compared with the ${priorLabel} once both filings finish indexing.`,
    };
  }
  return {
    kind: "ready",
    priorDate: formatDate(data.prior_filing_date),
    priorLabel,
    figure: formatShare(data.carried_over),
    passages: data.novel_passages.map((p) => p.excerpt),
  };
}
