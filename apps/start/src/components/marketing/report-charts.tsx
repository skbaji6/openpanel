import type { DailyRow, Funnel } from './contract';
import { dailySeries, funnelSteps, NOT_REPORTED_LABEL } from './report-view';

const percent = new Intl.NumberFormat(undefined, {
  style: 'percent',
  maximumFractionDigits: 1,
});

const CHART_WIDTH = 640;
const CHART_HEIGHT = 200;
const PAD = { left: 36, right: 8, top: 8, bottom: 22 };
const TICKS = 4;

// Colour is never the only signal: each line also has its own dash pattern and a legend.
const DAILY_SERIES = [
  { key: 'sent', label: 'Sent', color: 'var(--chart-0)', dash: undefined },
  { key: 'clicked', label: 'Clicked', color: 'var(--chart-1)', dash: '6 3' },
  {
    key: 'converted',
    label: 'Converted',
    color: 'var(--chart-7)',
    dash: '2 3',
  },
] as const;

const SERIES_KEYS = DAILY_SERIES.map((series) => series.key);

function countText(count: number | null, share: number | null): string {
  if (count === null) {
    return NOT_REPORTED_LABEL;
  }
  return share === null ? String(count) : `${count} (${percent.format(share)})`;
}

export function FunnelBars({
  funnel,
  notReported,
}: {
  funnel: Funnel;
  notReported: string[];
}) {
  const steps = funnelSteps(funnel, notReported);
  return (
    <ul aria-label="Funnel" className="col gap-2">
      {steps.map((step) => (
        <li className="row items-center gap-3 text-sm" key={step.key}>
          <span className="w-24 shrink-0">{step.label}</span>
          <span aria-hidden className="h-3 flex-1 rounded bg-muted">
            <span
              className="block h-3 rounded"
              style={{
                width: `${(step.percentOfSent ?? 0) * 100}%`,
                background: 'var(--chart-0)',
              }}
            />
          </span>
          <span className="w-40 shrink-0 text-right tabular-nums">
            {countText(step.count, step.percentOfSent)}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function DailyChart({ daily }: { daily: DailyRow[] }) {
  const rows = dailySeries(daily, [...SERIES_KEYS]);
  if (rows.length === 0) {
    return <p className="text-muted-foreground text-sm">No activity yet.</p>;
  }
  const max = Math.max(
    1,
    ...rows.flatMap((row) => SERIES_KEYS.map((key) => Number(row[key])))
  );
  const plotWidth = CHART_WIDTH - PAD.left - PAD.right;
  const plotHeight = CHART_HEIGHT - PAD.top - PAD.bottom;
  const x = (index: number) =>
    PAD.left +
    (rows.length === 1
      ? plotWidth / 2
      : (index / (rows.length - 1)) * plotWidth);
  const y = (value: number) =>
    PAD.top + plotHeight - (value / max) * plotHeight;
  const ticks = Array.from({ length: TICKS + 1 }, (_, i) =>
    Math.round((max / TICKS) * i)
  );
  return (
    <div className="col gap-2">
      <svg
        aria-label="Messages per day"
        className="w-full"
        role="img"
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      >
        {ticks.map((value, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rounded ticks can repeat for small maxima
          <g key={index}>
            <line
              stroke="currentColor"
              strokeOpacity={0.12}
              x1={PAD.left}
              x2={CHART_WIDTH - PAD.right}
              y1={y(value)}
              y2={y(value)}
            />
            <text
              className="fill-muted-foreground text-[10px]"
              textAnchor="end"
              x={PAD.left - 4}
              y={y(value) + 3}
            >
              {value}
            </text>
          </g>
        ))}
        <text
          className="fill-muted-foreground text-[10px]"
          x={PAD.left}
          y={CHART_HEIGHT - 6}
        >
          {rows[0].day}
        </text>
        <text
          className="fill-muted-foreground text-[10px]"
          textAnchor="end"
          x={CHART_WIDTH - PAD.right}
          y={CHART_HEIGHT - 6}
        >
          {rows.at(-1)?.day}
        </text>
        {DAILY_SERIES.map((series) => (
          <polyline
            fill="none"
            key={series.key}
            points={rows
              .map((row, i) => `${x(i)},${y(Number(row[series.key]))}`)
              .join(' ')}
            stroke={series.color}
            strokeDasharray={series.dash}
            strokeLinejoin="round"
            strokeWidth={2}
          />
        ))}
      </svg>
      <ul className="row gap-4 text-sm">
        {DAILY_SERIES.map((series) => (
          <li className="row items-center gap-2" key={series.key}>
            <svg aria-hidden height="8" width="24">
              <line
                stroke={series.color}
                strokeDasharray={series.dash}
                strokeWidth={2}
                x1="0"
                x2="24"
                y1="4"
                y2="4"
              />
            </svg>
            {series.label}
          </li>
        ))}
      </ul>
      <details>
        <summary className="cursor-pointer text-muted-foreground text-sm">
          Show the daily numbers as a table
        </summary>
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Messages per day</caption>
          <thead>
            <tr>
              <th className="p-1" scope="col">
                Day
              </th>
              {DAILY_SERIES.map((series) => (
                <th className="p-1 text-right" key={series.key} scope="col">
                  {series.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr className="border-t" key={row.day}>
                <th className="p-1 font-normal" scope="row">
                  {row.day}
                </th>
                {DAILY_SERIES.map((series) => (
                  <td className="p-1 text-right tabular-nums" key={series.key}>
                    {row[series.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
