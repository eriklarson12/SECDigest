"use client";

import { useState } from "react";
import {
  LineChart,
  Line,
  LabelList,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
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

// Two data colours, total. Series are separated by dash pattern, never hue.
const COLOR_SERIES = "var(--color-accent)";
const COLOR_ENDPOINT = "var(--color-primary)";
const COLOR_GRID = "var(--color-border)";
const COLOR_AXIS = "var(--color-muted)";

/** Recharts types the label/dot channels loosely (cx, cy and value can each
 * arrive as string, number or a renderable). Accept anything and coerce here. */
interface MarkProps {
  cx?: unknown;
  cy?: unknown;
  x?: unknown;
  y?: unknown;
  index?: number;
  value?: unknown;
}

function coord(v: unknown): number | null {
  const n =
    typeof v === "string" ? Number(v) : typeof v === "number" ? v : null;
  return n == null || Number.isNaN(n) ? null : n;
}

/** Direct labels replace the legend: each series is named at its endpoint with
 * its value attached, so the chart reads without a lookup. */
function endpointLabel(name: string, lastIndex: number) {
  function Label({ cx, cy, x: px, y: py, index, value }: MarkProps) {
    // LabelList supplies x/y; the dot channel supplies cx/cy.
    const x = coord(cx ?? px);
    const y = coord(cy ?? py);
    const v = coord(value);
    if (index !== lastIndex || x == null || y == null || v == null) return null;
    return (
      <g>
        <text x={x + 8} y={y - 2} fill="var(--color-text)" fontSize={12}>
          {name}
        </text>
        <text x={x + 8} y={y + 10} fill="var(--color-muted)" fontSize={11}>
          {formatCurrencyCompact(v)}
        </text>
      </g>
    );
  }
  Label.displayName = `EndpointLabel(${name})`;
  return Label;
}

function endpointDot(lastIndex: number) {
  function Dot({ cx, cy, index }: MarkProps) {
    const x = coord(cx);
    const y = coord(cy);
    if (index !== lastIndex || x == null || y == null) return null;
    return <circle cx={x} cy={y} r={2.5} fill={COLOR_ENDPOINT} />;
  }
  Dot.displayName = "EndpointDot";
  return Dot;
}

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

  const lastIndex = data.length - 1;

  return (
    <div
      aria-label={`Line chart of ${ticker} revenue and net income across ${activePoints.length} periods`}
    >
      <div className="flex items-end justify-between gap-3 border-b border-text pb-1.5">
        <div>
          <h3 className="font-sans text-xs font-semibold uppercase tracking-[0.07em] text-text">
            {title}
          </h3>
          {caption && (
            <p className="mt-0.5 font-sans text-2xs text-muted">{caption}</p>
          )}
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
      <div className="mt-3">
        <ResponsiveContainer width="100%" height={240}>
          <LineChart
            data={data}
            margin={{ top: 8, right: 108, bottom: 0, left: 0 }}
          >
            <CartesianGrid vertical={false} stroke={COLOR_GRID} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 12, fill: COLOR_AXIS }}
              stroke={COLOR_GRID}
              tickLine={false}
            />
            <YAxis
              tickFormatter={(v) => formatCurrencyCompact(v)}
              tick={{ fontSize: 12, fill: COLOR_AXIS }}
              stroke={COLOR_GRID}
              tickLine={false}
              axisLine={false}
              width={64}
            />
            {/* Kept for precision, but the direct labels mean it is never the
                only way to identify a line. */}
            <Tooltip
              formatter={(value) => formatCurrencyCompact(Number(value))}
              contentStyle={{
                backgroundColor: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text)",
                fontSize: 13,
              }}
            />
            <Line
              type="linear"
              dataKey="Revenue"
              stroke={COLOR_SERIES}
              strokeWidth={1.4}
              dot={endpointDot(lastIndex)}
              isAnimationActive={false}
            >
              <LabelList
                dataKey="Revenue"
                content={endpointLabel("Revenue", lastIndex)}
              />
            </Line>
            <Line
              type="linear"
              dataKey="Net Income"
              stroke={COLOR_SERIES}
              strokeWidth={1.4}
              strokeDasharray="4 3"
              dot={endpointDot(lastIndex)}
              isAnimationActive={false}
            >
              <LabelList
                dataKey="Net Income"
                content={endpointLabel("Net income", lastIndex)}
              />
            </Line>
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
