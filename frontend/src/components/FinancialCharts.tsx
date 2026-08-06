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
const COLOR_REVENUE = "var(--color-primary)";
const COLOR_POSITIVE = "var(--color-positive)";
const COLOR_NEGATIVE = "var(--color-negative)";
const COLOR_GRID = "var(--color-border)";
const COLOR_AXIS = "var(--color-muted)";

export default function FinancialCharts({ analysis }: FinancialChartsProps) {
  const data = [
    {
      name: "Revenue",
      value: analysis.revenue_current ?? 0,
      fill: COLOR_REVENUE,
    },
    {
      name: "Net Income",
      value: analysis.net_income_current ?? 0,
      fill:
        analysis.net_income_current && analysis.net_income_current >= 0
          ? COLOR_POSITIVE
          : COLOR_NEGATIVE,
    },
  ];

  if (!analysis.revenue_current && !analysis.net_income_current) {
    return null;
  }

  return (
    <div
      className="rounded-xl border border-border bg-surface p-5"
      aria-label={`Bar chart comparing ${analysis.ticker} revenue and net income for the period`}
    >
      <h3 className="mb-4 text-xs font-medium uppercase tracking-wide text-muted">
        Financial Overview
      </h3>
      <ResponsiveContainer width="100%" height={250}>
        <BarChart data={data} barSize={60}>
          <CartesianGrid strokeDasharray="3 3" stroke={COLOR_GRID} />
          <XAxis
            dataKey="name"
            tick={{ fontSize: 13, fill: COLOR_AXIS }}
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
            cursor={{ fill: "var(--color-surface-2)" }}
            contentStyle={{
              borderRadius: "8px",
              backgroundColor: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text)",
            }}
          />
          <Bar dataKey="value" radius={[6, 6, 0, 0]}>
            {data.map((entry, index) => (
              <Cell key={index} fill={entry.fill} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
