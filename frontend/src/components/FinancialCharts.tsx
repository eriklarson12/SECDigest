"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { formatCurrencyCompact } from "@/lib/format";
import type { AnalysisResponse } from "@/lib/types";

interface FinancialChartsProps {
  analysis: AnalysisResponse;
}

// Chart marks resolve the same semantic tokens via CSS variables
const COLOR_SERIES = "var(--color-accent)";
const COLOR_NEGATIVE = "var(--color-negative)";
const COLOR_GRID = "var(--color-border)";
const COLOR_AXIS = "var(--color-muted)";

export default function FinancialCharts({ analysis }: FinancialChartsProps) {
  const data = [
    {
      name: "Revenue",
      value: analysis.revenue_current ?? 0,
      fill: COLOR_SERIES,
    },
    {
      name: "Net Income",
      value: analysis.net_income_current ?? 0,
      fill:
        analysis.net_income_current && analysis.net_income_current < 0
          ? COLOR_NEGATIVE
          : COLOR_SERIES,
    },
  ];

  if (!analysis.revenue_current && !analysis.net_income_current) {
    return null;
  }

  return (
    <div
      aria-label={`Bar chart comparing ${analysis.ticker} revenue and net income for the period`}
    >
      <h3 className="mb-3 border-b border-text pb-1.5 font-sans text-[10px] uppercase tracking-[0.1em] text-muted">
        This filing
      </h3>
      <ResponsiveContainer width="100%" height={250}>
        <BarChart data={data} barSize={60}>
          <CartesianGrid vertical={false} stroke={COLOR_GRID} />
          <XAxis
            dataKey="name"
            tick={{ fontSize: 11, fill: COLOR_AXIS }}
            stroke={COLOR_GRID}
            tickLine={false}
          />
          <YAxis
            tickFormatter={(v) => formatCurrencyCompact(v)}
            tick={{ fontSize: 10, fill: COLOR_AXIS }}
            stroke={COLOR_GRID}
            tickLine={false}
            axisLine={false}
            width={64}
          />
          <Tooltip
            formatter={(value) => formatCurrencyCompact(Number(value))}
            cursor={{ fill: "var(--color-surface-2)" }}
            contentStyle={{
              backgroundColor: "var(--color-bg)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text)",
              fontSize: 12,
            }}
          />
          <Bar dataKey="value" isAnimationActive={false}>
            {data.map((entry, index) => (
              <Cell key={index} fill={entry.fill} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
