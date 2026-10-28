'use client';

import {
  Bar,
  BarChart,
  Cell,
  LabelList,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatUSD, toCents } from '@/lib/money';
import { monthLabel, type CategorySlice, type TrendPoint } from '@/lib/insights';
import { categoryColorVar } from '@/app/_components/category-tag';

// Shared tooltip chrome, styled like the app's popovers instead of the
// Recharts default. Payload shapes differ per chart, so each chart passes
// its own row renderer via `content`.
function TooltipCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md">
      {children}
    </div>
  );
}

const UNCATEGORIZED_LABEL = 'Uncategorized';

// Horizontal category bars. Identity is carried by the row label (color is
// reinforcement, matching the category tags everywhere else); the value is
// direct-labeled at every bar tip, so no gridlines or value axis.
export function CategoryBarChart({ slices }: { slices: CategorySlice[] }) {
  const data = slices.map((s) => ({
    name: s.name ?? UNCATEGORIZED_LABEL,
    value: s.totalCents,
    fill: s.name ? categoryColorVar(s.name) : 'var(--color-muted-foreground)',
  }));
  const height = data.length * 30 + 8;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 0, right: 72, bottom: 0, left: 0 }}
        barCategoryGap={6}
      >
        <XAxis type="number" hide domain={[0, 'dataMax']} />
        <YAxis
          type="category"
          dataKey="name"
          width={104}
          axisLine={false}
          tickLine={false}
          tick={{
            fontSize: 12,
            fill: 'var(--color-muted-foreground)',
          }}
        />
        <Tooltip
          cursor={{ fill: 'var(--color-muted)', opacity: 0.5 }}
          content={({ active, payload }) =>
            active && payload?.length ? (
              <TooltipCard>
                {payload[0].payload.name}{' '}
                <span className="font-mono font-medium">
                  {formatUSD(toCents(payload[0].payload.value))}
                </span>
              </TooltipCard>
            ) : null
          }
        />
        <Bar
          dataKey="value"
          barSize={14}
          radius={[0, 4, 4, 0]}
          isAnimationActive={false}
        >
          {data.map((entry) => (
            <Cell key={entry.name} fill={entry.fill} />
          ))}
          <LabelList
            dataKey="value"
            position="right"
            formatter={(value) => formatUSD(toCents(Number(value)))}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              fill: 'var(--color-foreground)',
            }}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// Six-month spending sparkline: a single 2px line in the accent hue with a
// marked endpoint. No axes — the flanking month labels and the hover
// tooltip carry the scale.
export function SpendTrendSparkline({ points }: { points: TrendPoint[] }) {
  const data = points.map((p) => ({ ...p, value: p.totalCents }));
  const last = data.length - 1;
  return (
    <ResponsiveContainer width="100%" height={56}>
      <LineChart data={data} margin={{ top: 6, right: 8, bottom: 6, left: 8 }}>
        <XAxis dataKey="month" hide />
        <YAxis hide domain={[0, 'dataMax']} />
        <Tooltip
          cursor={{ stroke: 'var(--color-border)', strokeWidth: 1 }}
          content={({ active, payload }) =>
            active && payload?.length ? (
              <TooltipCard>
                {monthLabel(payload[0].payload.month)}{' '}
                <span className="font-mono font-medium">
                  {formatUSD(toCents(payload[0].payload.value))}
                </span>
              </TooltipCard>
            ) : null
          }
        />
        <Line
          type="monotone"
          dataKey="value"
          stroke="var(--color-chart-1)"
          strokeWidth={2}
          strokeLinecap="round"
          isAnimationActive={false}
          // Mark only the current-period endpoint, ringed in the surface
          // color so it stays legible on the line.
          dot={({ key, index, cx, cy }) =>
            index === last && cx != null && cy != null ? (
              <circle
                key={key}
                cx={cx}
                cy={cy}
                r={4}
                fill="var(--color-chart-1)"
                stroke="var(--color-card)"
                strokeWidth={2}
              />
            ) : (
              <g key={key} />
            )
          }
          activeDot={{
            r: 4,
            fill: 'var(--color-chart-1)',
            stroke: 'var(--color-card)',
            strokeWidth: 2,
          }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
