/** Red flags (roadmap 12.4): the few disclosures that matter more than the rest.
 *
 * Two sources. Event flags are read here from the filings feed the page already fetches: an 8-K's
 * item 4.01 (auditor change) or 4.02 (non-reliance on prior financials), and an NT 10-K / NT 10-Q
 * late-filing notice. Text flags (going concern, material weakness) are detected by the backend
 * at analysis time and arrive on `AnalysisResponse.flags`. */

import { EVENT_FORMS, isEvent, isNotice } from "./eightk";
import type { AnalysisResponse, Filing } from "./types";

/** Late-filing notices. EDGAR matches form types exactly, so each is asked for by name. */
export const NOTICE_FORMS = ["NT 10-K", "NT 10-Q"] as const;

/** Every form type a red-flag scan needs from the filings feed. */
export const FLAG_SCAN_FORMS = [...EVENT_FORMS, ...NOTICE_FORMS] as const;

/** An auditor change from 2012 is history, not a warning. Applies to every flag on the company
 * page; on the analysis page a filing's own text flags show whatever its age. */
export const FLAG_WINDOW_YEARS = 3;

export type FlagKind =
  | "auditor_change"
  | "non_reliance"
  | "late_filing"
  | "going_concern"
  | "material_weakness";

export interface PanelFlag {
  kind: FlagKind;
  /** ISO date the source filing was filed. Null only for a stored analysis without one. */
  date: string | null;
  accession: string;
  formType: string;
  /** The sentence that tripped the detector, for text flags. */
  excerpt?: string | null;
}

const LABELS: Record<FlagKind, string> = {
  auditor_change: "Change of auditor",
  non_reliance: "Prior financial statements no longer reliable",
  late_filing: "Late filing notice",
  going_concern: "Going-concern doubt",
  material_weakness: "Material weakness in internal control",
};

export function flagLabel(flag: PanelFlag): string {
  if (flag.kind === "late_filing") return `${LABELS.late_filing} (${flag.formType})`;
  return LABELS[flag.kind];
}

const EVENT_ITEMS: Record<string, FlagKind> = {
  "4.01": "auditor_change",
  "4.02": "non_reliance",
};

function windowStart(now: Date): string {
  const start = new Date(now);
  start.setUTCFullYear(start.getUTCFullYear() - FLAG_WINDOW_YEARS);
  return start.toISOString().slice(0, 10);
}

export function withinWindow(flags: PanelFlag[], now: Date): PanelFlag[] {
  const start = windowStart(now);
  return flags.filter((f) => f.date !== null && f.date >= start);
}

/** Flags from the filings feed, inside the window. Read from the **unsliced** response: the
 * events strip keeps only the newest ten 8-Ks, and a 4.01 can be older than that. */
export function eventFlags(rows: Filing[], now: Date): PanelFlag[] {
  const flags: PanelFlag[] = [];
  for (const row of rows) {
    const base = {
      date: row.filing_date,
      accession: row.accession_number,
      formType: row.form_type,
    };
    if (isNotice(row.form_type)) {
      flags.push({ kind: "late_filing", ...base });
    } else if (isEvent(row.form_type)) {
      for (const item of row.items) {
        const kind = EVENT_ITEMS[item];
        if (kind) flags.push({ kind, ...base });
      }
    }
  }
  return withinWindow(flags, now);
}

/** A stored analysis's text flags. `flags` is absent on an older backend. */
export function textFlags(analysis: AnalysisResponse | null | undefined): PanelFlag[] {
  return (analysis?.flags ?? []).map((f) => ({
    kind: f.kind,
    date: f.filed_date,
    accession: f.accession_number,
    formType: f.form_type,
    excerpt: f.excerpt,
  }));
}

/** Newest first; one row per (filing, kind), since an amendment can repeat its original. */
export function mergeFlags(...groups: PanelFlag[][]): PanelFlag[] {
  const seen = new Set<string>();
  const merged: PanelFlag[] = [];
  for (const flag of groups.flat()) {
    const key = `${flag.accession.replace(/-/g, "")}:${flag.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(flag);
  }
  return merged.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
}

/** The company page's text flags: those of the newest analyzed filing only, inside the window.
 * An older filing's going-concern doubt is superseded by the filing after it. */
export function latestTextFlags(analyses: AnalysisResponse[], now: Date): PanelFlag[] {
  let newest: AnalysisResponse | null = null;
  for (const a of analyses) {
    if (!newest || (a.filing_date ?? "") > (newest.filing_date ?? "")) newest = a;
  }
  return withinWindow(textFlags(newest), now);
}
