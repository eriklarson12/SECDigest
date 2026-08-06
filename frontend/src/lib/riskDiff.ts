/** Risk-factor drift between filings.
 *
 * Risk factors are LLM-paraphrased sentences, so exact matching is useless —
 * two filings describing the same risk will word it differently. Jaccard
 * overlap on content words is enough to pair "same risk, new wording" while
 * letting genuinely new risks through.
 */

import type { AnalysisResponse } from "./types";

const STOPWORDS = new Set([
  "the", "and", "for", "that", "with", "from", "its", "are", "our", "has",
  "have", "may", "could", "would", "will", "can", "not", "any", "into",
  "which", "their", "there", "been", "being", "this", "these", "those",
  "company", "companys", "risk", "risks", "including", "such", "other",
  "significant", "material", "adverse", "adversely", "affect", "impact",
]);

export function tokenize(sentence: string): Set<string> {
  const tokens = sentence
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return new Set(tokens);
}

/** Jaccard similarity of content-word sets; 0..1. */
export function similarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }
  return intersection / (setA.size + setB.size - intersection);
}

const SIMILARITY_THRESHOLD = 0.25;

export interface RiskDrift {
  /** Parallel to the current risk list — true = no counterpart in the prior filing. */
  isNew: boolean[];
  /** Prior-filing risks with no counterpart in the current list. */
  dropped: string[];
}

export function diffRisks(
  current: string[],
  prior: string[],
  threshold = SIMILARITY_THRESHOLD
): RiskDrift {
  const isNew = current.map(
    (risk) => !prior.some((p) => similarity(risk, p) >= threshold)
  );
  const dropped = prior.filter(
    (p) => !current.some((risk) => similarity(risk, p) >= threshold)
  );
  return { isNew, dropped };
}

/** The "no material changes" sentinel carries no risks worth diffing. */
export function hasSubstantiveRisks(risks: string[]): boolean {
  if (risks.length === 0) return false;
  if (risks.length === 1 && /no material changes/i.test(risks[0])) return false;
  return true;
}

/** The stored analysis filed most recently before `analysis` for the same ticker. */
export function findPriorAnalysis(
  analysis: AnalysisResponse,
  tickerHistory: AnalysisResponse[]
): AnalysisResponse | null {
  if (!analysis.filing_date) return null;
  let prior: AnalysisResponse | null = null;
  for (const candidate of tickerHistory) {
    if (candidate.accession_number === analysis.accession_number) continue;
    if (!candidate.filing_date || candidate.filing_date >= analysis.filing_date) continue;
    if (!prior || candidate.filing_date > prior.filing_date!) prior = candidate;
  }
  return prior;
}
