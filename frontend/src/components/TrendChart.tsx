"use client";

import { useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { formatCurrencyCompact } from "@/lib/format";
import type { TrendPoint } from "@/lib/types";
import SegmentedControl from "./SegmentedControl";

interface TrendChartProps {
  ticker: string;
  title: string;
  /** Small note under the title, e.g. the data source. */
  caption?: string;
  /** Chronological points; the chart renders only with 2+. */
  points: TrendPoint[];
  /** Optional quarterly series — a segmented toggle appears when both this
   * and `points` have 2+ points. */
  quarterlyPoints?: TrendPoint[];
}

const COLOR_REVENUE = "var(--color-primary)";
const COLOR_NET_INCOME = "var(--color-positive)";
const COLOR_GRID = "var(--color-border)";
const COLOR_AXIS = "var(--color-muted)";

type Period = "annual" | "quarterly";

const PERIODS = [
  { value: "annual", label: "Annual" },
  { value: "quarterly", label: "Quarterly" },
] as const satisfies readonly { value: Period; label: string }[];

export default function TrendChart({
  ticker,
  title,
  caption,
  points,
  quarterlyPoints = [],
}: TrendChartProps) {
  const [period, setPeriod] = useState<Period>("annual");

  const annualOk = points.length >= 2;
  const quarterlyOk = quarterlyPoints.length >= 2;
  if (!annualOk && !quarterlyOk) return null;

  const showToggle = annualOk && quarterlyOk;
  const active: Period = !annualOk
    ? "quarterly"
    : !quarterlyOk
      ? "annual"
      : period;
  const activePoints = active === "quarterly" ? quarterlyPoints : points;

  const data = activePoints.map((p) => ({
    label: p.label,
    Revenue: p.revenue,
    "Net Income": p.netIncome,
  }));

  return (
    <div
      className="rounded-xl border border-border bg-surface p-5"
      aria-label={`Line chart of ${ticker} revenue and net income across ${activePoints.length} periods`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
            {title}
          </h3>
          {caption && <p className="mt-1 text-xs text-muted">{caption}</p>}
        </div>
        {showToggle && (
          <SegmentedControl
            label="Chart period"
            options={PERIODS}
            value={active}
            onChange={setPeriod}
          />
        )}
      </div>
      <div className="mt-4">
        <ResponsiveContainer width="100%" height={250}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke={COLOR_GRID} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 12, fill: COLOR_AXIS }}
              stroke={COLOR_GRID}
            />
            <YAxis
              tickFormatter={(v) => formatCurrencyCompact(v)}
              tick={{ fontSize: 12, fill: COLOR_AXIS }}
              stroke={COLOR_GRID}
              width={80}
            />
            <Tooltip
              formatter={(value) => formatCurrencyCompact(Number(value))}
              contentStyle={{
                borderRadius: "8px",
                backgroundColor: "var(--color-surface-2)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text)",
              }}
            />
            <Legend wrapperStyle={{ fontSize: 13 }} />
            <Line
              type="monotone"
              dataKey="Revenue"
              stroke={COLOR_REVENUE}
              strokeWidth={2}
              dot={{ r: 3 }}
            />
            <Line
              type="monotone"
              dataKey="Net Income"
              stroke={COLOR_NET_INCOME}
              strokeWidth={2}
              dot={{ r: 3 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
