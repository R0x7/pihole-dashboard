import { formatCount, formatPercent, percentOf, type RankedRow } from './helpers'
import { EmptyState } from './Panel'

export interface RankedBarsProps {
  rows: RankedRow[]
  /** Bar colour (a CSS colour or var()). */
  color: string
  /** Noun for the hover title, e.g. "blocked queries". */
  unit: string
  /** When given, each row also shows its share of this total. */
  shareOf?: number
  empty: string
}

/** A horizontal ranked bar list: label and value on one line, a thin bar beneath. */
export function RankedBars({ rows, color, unit, shareOf, empty }: RankedBarsProps) {
  if (rows.length === 0) return <EmptyState>{empty}</EmptyState>
  const showShare = typeof shareOf === 'number' && shareOf > 0
  return (
    <ol className="dash-rank">
      {rows.map((row) => {
        const share = showShare ? formatPercent(percentOf(row.count, shareOf)) : null
        const title =
          `${row.label}${row.detail ? ` (${row.detail})` : ''}: ${formatCount(row.count)} ${unit}` +
          (share ? `, ${share} of all ${unit}` : '')
        return (
          <li key={row.key} className="dash-rank-row" title={title}>
            <span className="dash-rank-label">
              <span className="dash-rank-num">{row.rank}.</span>
              {row.shortLabel}
              {row.detail ? <span className="dash-rank-detail">{row.detail}</span> : null}
            </span>
            <span className="dash-rank-value">
              {formatCount(row.count)}
              {share ? <span className="dash-rank-share">{share}</span> : null}
            </span>
            <div className="dash-rank-track">
              <div
                className="dash-rank-fill"
                style={{ width: `${Math.max(0, Math.min(1, row.fraction)) * 100}%`, background: color }}
              />
            </div>
          </li>
        )
      })}
    </ol>
  )
}
