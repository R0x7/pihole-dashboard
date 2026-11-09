import { useMemo } from 'react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { ClientHistory } from '@shared/contract'
import {
  clientHistoryToChart,
  formatCompact,
  formatCount,
  formatDateTime,
  formatTime,
  timeTicks,
  type ClientChartRow,
  type ClientSeries
} from './helpers'
import {
  AXIS_LINE,
  AXIS_TICK,
  ChartTooltip,
  CURSOR,
  EmptyState,
  GRID_STROKE,
  Legend,
  Panel,
  SURFACE,
  timeDomain
} from './Panel'

/** Seven palette slots are defined in dashboard.css; further clients fold into "Other". */
const MAX_SERIES = 7

function seriesColor(series: ClientSeries): string {
  return series.isOther ? 'var(--dash-series-other, #898781)' : `var(--dash-series-${series.colorIndex + 1}, #898781)`
}

function seriesTitle(series: ClientSeries): string {
  return series.ip ? `${series.name} (${series.ip})` : series.name
}

function ClientTooltip({ row, series }: { row: ClientChartRow; series: ClientSeries[] }) {
  // Top of the stack first, matching how the areas are drawn.
  const rows = [...series]
    .reverse()
    .filter((s) => (row[s.key] ?? 0) > 0)
    .map((s) => ({ key: s.key, label: s.shortName, value: formatCount(row[s.key] ?? 0), color: seriesColor(s) }))
  return (
    <ChartTooltip
      title={formatDateTime(row.t)}
      rows={rows}
      footer={[{ key: 'total', label: 'Total', value: formatCount(row.total) }]}
    />
  )
}

export function ClientActivityChart({ clientHistory }: { clientHistory: ClientHistory }) {
  const chart = useMemo(() => clientHistoryToChart(clientHistory, MAX_SERIES), [clientHistory])
  const domain = timeDomain(chart.rows)
  const ticks = useMemo(() => timeTicks(domain[0], domain[1], 6), [domain[0], domain[1]])
  const single = chart.rows.length === 1

  return (
    <Panel title="Client activity over time" subtitle="Queries per client, last 24 hours" wide>
      {chart.hasData ? (
        <>
          <Legend
            items={chart.series.map((s) => ({
              key: s.key,
              label: s.shortName,
              title: seriesTitle(s),
              color: seriesColor(s)
            }))}
          />
          <div className="dash-chart">
            <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 600, height: 230 }}>
              <AreaChart data={chart.rows} margin={{ top: 4, right: 12, bottom: 0, left: 0 }} accessibilityLayer={false}>
                <CartesianGrid vertical={false} stroke={GRID_STROKE} />
                <XAxis
                  dataKey="t"
                  type="number"
                  scale="time"
                  domain={domain}
                  ticks={ticks}
                  tickFormatter={(value) => formatTime(Number(value))}
                  tick={AXIS_TICK}
                  axisLine={AXIS_LINE}
                  tickLine={false}
                  tickMargin={6}
                />
                <YAxis
                  allowDecimals={false}
                  tickFormatter={(value) => formatCompact(Number(value))}
                  tick={AXIS_TICK}
                  axisLine={false}
                  tickLine={false}
                  width={44}
                />
                <Tooltip
                  isAnimationActive={false}
                  cursor={CURSOR}
                  content={({ active, payload }) => {
                    const row = active ? (payload?.[0]?.payload as ClientChartRow | undefined) : undefined
                    return row ? <ClientTooltip row={row} series={chart.series} /> : null
                  }}
                />
                {chart.series.map((s) => {
                  const color = seriesColor(s)
                  return (
                    <Area
                      key={s.key}
                      dataKey={s.key}
                      name={s.name}
                      stackId="clients"
                      type="monotone"
                      fill={color}
                      fillOpacity={0.9}
                      stroke={SURFACE}
                      strokeWidth={1}
                      dot={single ? { r: 4, fill: color, stroke: SURFACE } : false}
                      activeDot={{ r: 3, fill: color, stroke: SURFACE, strokeWidth: 2 }}
                      isAnimationActive={false}
                    />
                  )
                })}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </>
      ) : (
        <EmptyState>No client activity recorded in the last 24 hours.</EmptyState>
      )}
    </Panel>
  )
}
