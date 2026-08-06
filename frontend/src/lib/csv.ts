/** CSV export of stored analyses (history page). */

import type { AnalysisResponse } from "./types";

const COLUMNS: { header: string; value: (a: AnalysisResponse) => string | number | null }[] = [
  { header: "ticker", value: (a) => a.ticker },
  { header: "company_name", value: (a) => a.company_name },
  { header: "form_type", value: (a) => a.form_type },
  { header: "filing_date", value: (a) => a.filing_date },
  { header: "accession_number", value: (a) => a.accession_number },
  { header: "revenue_current", value: (a) => a.revenue_current },
  { header: "revenue_yoy_change_pct", value: (a) => a.revenue_yoy_change_pct },
  { header: "net_income_current", value: (a) => a.net_income_current },
  { header: "net_income_yoy_change_pct", value: (a) => a.net_income_yoy_change_pct },
  { header: "risk_factors", value: (a) => a.risk_factors.join(" | ") },
  { header: "management_guidance", value: (a) => a.management_guidance },
  { header: "summary", value: (a) => a.summary },
  { header: "created_at", value: (a) => a.created_at },
];

export function csvEscape(value: string | number | null): string {
  if (value === null) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv(analyses: AnalysisResponse[]): string {
  const header = COLUMNS.map((c) => c.header).join(",");
  const rows = analyses.map((a) =>
    COLUMNS.map((c) => csvEscape(c.value(a))).join(",")
  );
  return [header, ...rows].join("\r\n") + "\r\n";
}

/** Trigger a browser download of the analyses as a CSV file. */
export function downloadCsv(analyses: AnalysisResponse[], filename = "secdigest-analyses.csv"): void {
  const blob = new Blob([toCsv(analyses)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
