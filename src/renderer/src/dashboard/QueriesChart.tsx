import { useMemo } from 'react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { HistoryPoint } from '@shared/contract'
import {
  formatCompact,
  formatCount,
  formatDateTime,
  formatPercent,
  formatTime,
  hasHistoryData,
  historyToRows,
  timeTicks,
  type HistoryRow
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

const ALLOWED = 'var(--ok, #1a9f53)'
const BLOCKED = 'var(--blocked, #d03b3b)'

const LEGEND = [
  { key: 'blocked', label: 'Blocked', color: BLOCKED },
  { key: 'allowed', label: 'Allowed', color: ALLOWED }
]

function HistoryTooltip({ row }: { row: HistoryRow }) {
  return (
    <ChartTooltip
      title={formatDateTime(row.t)}
      rows={[
        { key: 'allowed', label: 'Allowed', value: formatCount(row.allowed), color: ALLOWED },
        { key: 'blocked', label: 'Blocked', value: formatCount(row.blocked), color: BLOCKED }
      ]}
      footer={[
        { key: 'total', label: 'Total', value: formatCount(row.total) },
        { key: 'percent', label: 'Percent blocked', value: formatPercent(row.percentBlocked) }
      ]}
    />
  )
}

export function QueriesChart({ history }: { history: HistoryPoint[] }) {
  const rows = useMemo(() => historyToRows(history), [history])
  const domain = timeDomain(rows)
  const ticks = useMemo(() => timeTicks(domain[0], domain[1], 6), [domain[0], domain[1]])
  const single = rows.length === 1

  return (
    <Panel title="Queries over time" subtitle="Last 24 hours" wide>
      {hasHistoryData(rows) ? (
        <>
          <Legend items={LEGEND} />
          <div className="dash-chart">
            <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 600, height: 230 }}>
              <AreaChart data={rows} margin={{ top: 4, right: 12, bottom: 0, left: 0 }} accessibilityLayer={false}>
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
                    const row = active ? (payload?.[0]?.payload as HistoryRow | undefined) : undefined
                    return row ? <HistoryTooltip row={row} /> : null
                  }}
                />
                <Area
                  dataKey="blocked"
                  name="Blocked"
                  stackId="queries"
                  type="monotone"
                  fill={BLOCKED}
                  fillOpacity={0.9}
                  stroke={SURFACE}
                  strokeWidth={1}
                  dot={single ? { r: 4, fill: BLOCKED, stroke: SURFACE } : false}
                  activeDot={{ r: 4, fill: BLOCKED, stroke: SURFACE, strokeWidth: 2 }}
                  isAnimationActive={false}
                />
                <Area
                  dataKey="allowed"
                  name="Allowed"
                  stackId="queries"
                  type="monotone"
                  fill={ALLOWED}
                  fillOpacity={0.9}
                  stroke={SURFACE}
                  strokeWidth={1}
                  dot={single ? { r: 4, fill: ALLOWED, stroke: SURFACE } : false}
                  activeDot={{ r: 4, fill: ALLOWED, stroke: SURFACE, strokeWidth: 2 }}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </>
      ) : (
        <EmptyState>No queries recorded in the last 24 hours.</EmptyState>
      )}
    </Panel>
  )
}
