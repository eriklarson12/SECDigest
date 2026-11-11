import type { AnalysisResponse } from "./types";

/** A form family. Amendments count as their parent form, as `formDescription` does. */
export type PeriodForm = "10-K" | "10-Q";

/** Preference order when nothing is asked for: annual first. */
const FORMS: readonly PeriodForm[] = ["10-K", "10-Q"];

/** Analyses fetched per side. Twelve stored filings reach back about three years. */
export const COMPARE_HISTORY = 12;

export function periodForm(formType: string): PeriodForm | null {
  return FORMS.find((form) => formType.startsWith(form)) ?? null;
}

/** What one analysis's figures cover, as the metric blocks label it. */
export function periodLabel(formType: string): string | null {
  const form = periodForm(formType);
  if (form === "10-K") return "Fiscal year";
  if (form === "10-Q") return "Quarter";
  return null;
}

/** Reads `?form=`. Anything else is no preference. */
export function parseFormParam(raw: string | null): PeriodForm | null {
  return FORMS.find((form) => form === raw) ?? null;
}

/** Newest by filing date; an undated analysis is oldest, and a tie keeps list order. */
function newest(
  analyses: AnalysisResponse[],
  form: PeriodForm | null,
): AnalysisResponse | null {
  let best: AnalysisResponse | null = null;
  for (const candidate of analyses) {
    if (form && periodForm(candidate.form_type) !== form) continue;
    if (!best || (candidate.filing_date ?? "") > (best.filing_date ?? "")) {
      best = candidate;
    }
  }
  return best;
}

function formsOf(analyses: AnalysisResponse[]): Set<PeriodForm> {
  const forms = new Set<PeriodForm>();
  for (const analysis of analyses) {
    const form = periodForm(analysis.form_type);
    if (form) forms.add(form);
  }
  return forms;
}

export interface ComparePair {
  a: AnalysisResponse | null;
  b: AnalysisResponse | null;
  /** The form both sides were picked by. Null when they share none. */
  form: PeriodForm | null;
  /** Forms the reader can switch between: both, or none. */
  choices: PeriodForm[];
}

/** One analysis per side, of the same form when the two sides have one in common.
 *
 * A side with nothing stored, or not picked yet, constrains nothing: the other side still
 * takes its newest annual. That keeps a lone column from switching form when the second
 * company arrives. */
export function pickComparePair(
  a: AnalysisResponse[],
  b: AnalysisResponse[],
  preferred: PeriodForm | null = null,
): ComparePair {
  const formsA = formsOf(a);
  const formsB = formsOf(b);
  const common = FORMS.filter(
    (form) =>
      (a.length === 0 || formsA.has(form)) &&
      (b.length === 0 || formsB.has(form)),
  );
  const form =
    preferred && common.includes(preferred) ? preferred : (common[0] ?? null);
  const choices =
    a.length > 0 && b.length > 0 && common.length === FORMS.length
      ? [...FORMS]
      : [];
  return { a: newest(a, form), b: newest(b, form), form, choices };
}

/** "AAPL's figures cover a fiscal year, MSFT's one quarter." Null when the periods match. */
export function periodMismatch(
  a: AnalysisResponse,
  b: AnalysisResponse,
): string | null {
  const formA = periodForm(a.form_type);
  const formB = periodForm(b.form_type);
  if (!formA || !formB || formA === formB) return null;
  const span = (form: PeriodForm) =>
    form === "10-K" ? "a fiscal year" : "one quarter";
  return `${a.ticker}'s figures cover ${span(formA)}, ${b.ticker}'s ${span(formB)}.`;
}
