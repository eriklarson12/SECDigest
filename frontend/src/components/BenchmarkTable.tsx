import Link from "next/link";
import { X } from "lucide-react";
import Delta from "@/components/Delta";
import {
  formatCurrency,
  formatMultiple,
  formatPercent,
} from "@/lib/format";
import { formatPercentile } from "@/lib/percentiles";
import type { BenchmarkRow, SortDir, SortKey } from "@/lib/ratios";

const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: "ticker", label: "Ticker", numeric: false },
  { key: "fiscalYear", label: "FY", numeric: true },
  { key: "revenue", label: "Revenue", numeric: true },
  { key: "netMargin", label: "Net margin", numeric: true },
  { key: "ocfMargin", label: "OCF margin", numeric: true },
  { key: "grossMargin", label: "Gross margin", numeric: true },
  { key: "operatingMargin", label: "Op. margin", numeric: true },
  { key: "fcfMargin", label: "FCF margin", numeric: true },
  { key: "liabilitiesToEquity", label: "Liab./equity", numeric: true },
  { key: "currentRatio", label: "Current ratio", numeric: true },
  { key: "revenueCagr", label: "3-yr rev CAGR", numeric: true },
  { key: "revenuePercentile", label: "Revenue rank", numeric: true },
];

/** A margin is a level, not a change: it keeps its own minus sign, so the figure
 * reads correctly with colour ignored entirely. Colour only reinforces a loss. */
function Margin({ value }: { value: number | null }) {
  if (value == null) return <span className="text-muted">&mdash;</span>;
  return (
    <span className={value < 0 ? "text-negative" : "text-text"}>
      {formatPercent(value)}
    </span>
  );
}

/** A multiple has a direction but no goodness: high leverage is a fact, not a loss. No colour. */
function Multiple({ value }: { value: number | null }) {
  if (value == null) return <span className="text-muted">&mdash;</span>;
  return <span className="text-text">{formatMultiple(value)}</span>;
}

function SortHeader({
  column: { key, label, numeric },
  sort,
  onSort,
}: {
  column: (typeof COLUMNS)[number];
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
}) {
  return (
    <th
      scope="col"
      aria-sort={
        sort.key === key
          ? sort.dir === "asc"
            ? "ascending"
            : "descending"
          : "none"
      }
      className={`whitespace-nowrap py-1.5 font-normal ${
        numeric ? "pl-4 text-right" : "pr-4"
      }`}
    >
      <button
        type="button"
        onClick={() => onSort(key)}
        className="cursor-pointer uppercase tracking-[0.06em] transition-colors duration-150 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        {label}
        <span aria-hidden className="ml-1">
          {sort.key === key ? (sort.dir === "asc" ? "▲" : "▼") : ""}
        </span>
      </button>
    </th>
  );
}

/** The figure cells of one loaded row, in COLUMNS order after the ticker. */
function FigureCells({ row }: { row: BenchmarkRow }) {
  return (
    <>
      <td className="whitespace-nowrap py-1.5 pl-4 text-right tabular-nums text-muted">
        {row.fiscalYear ?? "—"}
      </td>
      <td className="whitespace-nowrap py-1.5 pl-4 text-right tabular-nums text-text">
        {row.revenue == null ? "—" : formatCurrency(row.revenue)}
      </td>
      <td className="whitespace-nowrap py-1.5 pl-4 text-right tabular-nums">
        <Margin value={row.netMargin} />
      </td>
      <td className="whitespace-nowrap py-1.5 pl-4 text-right tabular-nums">
        <Margin value={row.ocfMargin} />
      </td>
      <td className="whitespace-nowrap py-1.5 pl-4 text-right tabular-nums">
        <Margin value={row.grossMargin} />
      </td>
      <td className="whitespace-nowrap py-1.5 pl-4 text-right tabular-nums">
        <Margin value={row.operatingMargin} />
      </td>
      <td className="whitespace-nowrap py-1.5 pl-4 text-right tabular-nums">
        <Margin value={row.fcfMargin} />
      </td>
      <td className="whitespace-nowrap py-1.5 pl-4 text-right tabular-nums">
        <Multiple value={row.liabilitiesToEquity} />
      </td>
      <td className="whitespace-nowrap py-1.5 pl-4 text-right tabular-nums">
        <Multiple value={row.currentRatio} />
      </td>
      <td className="whitespace-nowrap py-1.5 pl-4 text-right tabular-nums">
        {row.revenueCagr == null ? (
          <span className="text-muted">&mdash;</span>
        ) : (
          <Delta value={row.revenueCagr} />
        )}
      </td>
      {/* A position, not a direction — no Delta, and no positive/negative. */}
      <td className="whitespace-nowrap py-1.5 pl-4 text-right tabular-nums text-text">
        {row.revenuePercentile == null ? (
          <span className="text-muted">&mdash;</span>
        ) : (
          formatPercentile(row.revenuePercentile)
        )}
      </td>
    </>
  );
}

function BenchmarkTableRow({
  row,
  onRemove,
}: {
  row: BenchmarkRow;
  onRemove: (ticker: string) => void;
}) {
  return (
    <tr className="border-b border-border transition-colors duration-150 hover:bg-surface-2">
      <td className="py-1.5 pr-4">
        <Link
          href={`/company/${row.item.ticker}`}
          className="font-serif text-sm text-text transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {row.item.ticker}
        </Link>
        <span className="ml-2 text-muted">{row.item.name}</span>
      </td>

      {row.state === "loading" ? (
        <td colSpan={COLUMNS.length - 1} className="py-1.5 pl-4">
          <div className="ml-auto h-4 w-40 bg-surface-2 motion-safe:animate-pulse" />
        </td>
      ) : row.state === "error" ? (
        <td
          colSpan={COLUMNS.length - 1}
          className="py-1.5 pl-4 text-right text-muted"
        >
          Couldn&apos;t load financials
        </td>
      ) : (
        <FigureCells row={row} />
      )}

      <td className="py-1.5 pl-2">
        <button
          type="button"
          onClick={() => onRemove(row.item.ticker)}
          aria-label={`Remove ${row.item.ticker} from the comparison`}
          title="Remove from the comparison"
          className="flex h-11 w-11 cursor-pointer items-center justify-center text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <X className="h-4 w-4" strokeWidth={1.5} aria-hidden />
        </button>
      </td>
    </tr>
  );
}

/** The sortable ratio table and its definitions. `rows` arrive already sorted. */
export default function BenchmarkTable({
  rows,
  sort,
  onSort,
  onRemove,
}: {
  rows: BenchmarkRow[];
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
  onRemove: (ticker: string) => void;
}) {
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-left font-sans text-xs">
          <caption className="sr-only">
            Peer financial ratios, sortable by column
          </caption>
          <thead>
            <tr className="border-b border-text text-2xs uppercase tracking-[0.06em] text-muted">
              {COLUMNS.map((column) => (
                <SortHeader
                  key={column.key}
                  column={column}
                  sort={sort}
                  onSort={onSort}
                />
              ))}
              {/* `relative` is load-bearing: sr-only is position:absolute, and in the
                  last column of a horizontally scrolling table it would otherwise
                  resolve against the page and widen the document at 375px. */}
              <th scope="col" className="relative w-11">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <BenchmarkTableRow
                key={row.item.ticker}
                row={row}
                onRemove={onRemove}
              />
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 font-sans text-2xs text-muted">
        Margins are net income, operating cash flow, gross profit, operating income
        and free cash flow (operating cash flow less capex) as a share of revenue.
        Liab./equity is total liabilities over equity, a leverage proxy rather than
        debt over equity. A dash means the company does not report that figure;
        banks and insurers, for one, file no current assets or liabilities.
        CAGR is compound annual revenue growth across three fiscal years, left
        blank where a company has not tagged that many. Revenue rank is the
        company&apos;s standing among every SEC filer that tagged revenue for one
        shared period, not among all public companies. That period is the same for
        every row, so for a company with an off-calendar fiscal year it may not be
        the year the FY column names.
      </p>
    </>
  );
}
