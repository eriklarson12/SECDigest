"use client";

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
import { formatDate, formatPercent } from "@/lib/format";
import type { MetricPoint } from "@/lib/evals";

const COLOR_SERIES = "var(--color-accent)";
const COLOR_ENDPOINT = "var(--color-primary)";
const COLOR_GRID = "var(--color-border)";
const COLOR_AXIS = "var(--color-muted)";

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

function endpointLabel(lastIndex: number) {
  function Label({ x: px, y: py, index, value }: MarkProps) {
    const x = coord(px);
    const y = coord(py);
    const v = coord(value);
    if (index !== lastIndex || x == null || y == null || v == null) return null;
    return (
      <text x={x + 8} y={y + 4} fill="var(--color-text)" fontSize={12}>
        {formatPercent(v)}
      </text>
    );
  }
  Label.displayName = "EvalEndpointLabel";
  return Label;
}

function endpointDot(lastIndex: number) {
  function Dot({ cx, cy, index }: MarkProps) {
    const x = coord(cx);
    const y = coord(cy);
    if (index !== lastIndex || x == null || y == null) return null;
    return <circle cx={x} cy={y} r={2.5} fill={COLOR_ENDPOINT} />;
  }
  Dot.displayName = "EvalEndpointDot";
  return Dot;
}

/** One metric across eval runs. Every panel shares a 0 to 100 scale, so a
 * glance across the grid compares levels, not each panel's own range. */
export default function EvalMetricChart({
  title,
  points,
}: {
  title: string;
  points: MetricPoint[];
}) {
  const latest = points.at(-1);

  if (points.length < 2) {
    return (
      <figure>
        <figcaption className="font-sans text-2xs uppercase tracking-[0.06em] text-muted">
          {title}
        </figcaption>
        <p className="mt-2 font-sans text-lg tabular-nums text-text">
          {latest ? formatPercent(latest.value) : "N/A"}
        </p>
        <p className="mt-0.5 font-sans text-2xs text-muted">
          {latest ? `One run so far, ${formatDate(latest.date)}` : "No runs yet"}
        </p>
      </figure>
    );
  }

  const data = points.map((p) => ({ label: formatDate(p.date), value: p.value }));
  const lastIndex = data.length - 1;
  const summary = points
    .map((p) => `${formatPercent(p.value)} on ${formatDate(p.date)}`)
    .join(", ");

  return (
    <figure aria-label={`${title}: ${summary}`}>
      <figcaption className="font-sans text-2xs uppercase tracking-[0.06em] text-muted">
        {title}
      </figcaption>
      <div className="mt-2">
        <ResponsiveContainer width="100%" height={140}>
          <LineChart data={data} margin={{ top: 8, right: 56, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke={COLOR_GRID} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: COLOR_AXIS }}
              stroke={COLOR_GRID}
              tickLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              domain={[0, 100]}
              ticks={[0, 50, 100]}
              tickFormatter={(v) => `${v}%`}
              tick={{ fontSize: 11, fill: COLOR_AXIS }}
              stroke={COLOR_GRID}
              tickLine={false}
              axisLine={false}
              width={40}
            />
            <Tooltip
              formatter={(value) => formatPercent(Number(value))}
              contentStyle={{
                backgroundColor: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text)",
                fontSize: 13,
              }}
            />
            <Line
              type="linear"
              dataKey="value"
              name={title}
              stroke={COLOR_SERIES}
              strokeWidth={1.4}
              dot={endpointDot(lastIndex)}
              isAnimationActive={false}
            >
              <LabelList dataKey="value" content={endpointLabel(lastIndex)} />
            </Line>
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
