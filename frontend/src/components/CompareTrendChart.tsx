"use client";

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
import { mergeTrendPoints } from "@/lib/financials";
import type { TrendPoint } from "@/lib/types";

interface CompareTrendChartProps {
  aTicker: string;
  bTicker: string;
  /** Annual points only — quarterly fiscal calendars differ between companies,
   * so a shared x-axis would line up periods that aren't comparable. */
  aPoints: TrendPoint[];
  bPoints: TrendPoint[];
}

// Company maps to color, metric maps to line style. The single-company rule in
// docs/design-system.md colors by metric, which can't separate two companies.
const COLOR_A = "var(--color-primary)";
const COLOR_B = "var(--color-accent)";
const DASH_NET_INCOME = "5 3";
const COLOR_GRID = "var(--color-border)";
const COLOR_AXIS = "var(--color-muted)";

export default function CompareTrendChart({
  aTicker,
  bTicker,
  aPoints,
  bPoints,
}: CompareTrendChartProps) {
  if (aPoints.length < 2 || bPoints.length < 2) return null;

  const data = mergeTrendPoints(aPoints, bPoints);
  const span = `${data[0].label} to ${data[data.length - 1].label}`;

  return (
    <div
      className="mt-6"
      aria-label={`Line chart comparing ${aTicker} and ${bTicker} revenue and net income, ${span}`}
    >
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
        Revenue &amp; Net Income
      </h3>
      <p className="mt-1 text-xs text-muted">
        Annual XBRL figures. Solid lines are revenue, dashed are net income.
      </p>
      <div className="mt-4">
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={data}>
            <CartesianGrid vertical={false} stroke={COLOR_GRID} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: COLOR_AXIS }}
              stroke={COLOR_GRID}
            />
            <YAxis
              tickFormatter={(v) => formatCurrencyCompact(v)}
              tick={{ fontSize: 10, fill: COLOR_AXIS }}
              stroke={COLOR_GRID}
              width={80}
            />
            <Tooltip
              formatter={(value) => formatCurrencyCompact(Number(value))}
              contentStyle={{
                backgroundColor: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text)",
              }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line
              type="monotone"
              dataKey="aRevenue"
              name={`${aTicker} Revenue`}
              stroke={COLOR_A}
              strokeWidth={1.4}
              dot={false}
              connectNulls={false}
            />
            <Line
              type="monotone"
              dataKey="bRevenue"
              name={`${bTicker} Revenue`}
              stroke={COLOR_B}
              strokeWidth={1.4}
              dot={false}
              connectNulls={false}
            />
            <Line
              type="monotone"
              dataKey="aNetIncome"
              name={`${aTicker} Net Income`}
              stroke={COLOR_A}
              strokeDasharray={DASH_NET_INCOME}
              strokeWidth={1.4}
              dot={false}
              connectNulls={false}
            />
            <Line
              type="monotone"
              dataKey="bNetIncome"
              name={`${bTicker} Net Income`}
              stroke={COLOR_B}
              strokeDasharray={DASH_NET_INCOME}
              strokeWidth={1.4}
              dot={false}
              connectNulls={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
