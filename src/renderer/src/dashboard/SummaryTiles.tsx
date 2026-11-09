import type { Summary } from '@shared/contract'
import { formatCompact, formatCount, formatPercent, safeCount, summaryPercentBlocked } from './helpers'

/** Full digits while they fit a tile, compact beyond that; the title always has the full number. */
function tileNumber(value: number): string {
  return safeCount(value) >= 100_000_000 ? formatCompact(value) : formatCount(value)
}

interface TileProps {
  label: string
  value: string
  title: string
  swatch?: string
}

function Tile({ label, value, title, swatch }: TileProps) {
  return (
    <div className="dash-tile" title={title}>
      <div className="dash-tile-label">
        {swatch ? <span className="dash-tile-swatch" style={{ background: swatch }} /> : null}
        {label}
      </div>
      <div className="dash-tile-value">{value}</div>
    </div>
  )
}

export function BlockingStatus({ enabled }: { enabled: boolean | null }) {
  if (enabled === null || enabled === undefined) return null
  return (
    <div className="dash-status" data-enabled={enabled} role="status">
      <span className="dash-status-dot" aria-hidden="true" />
      {enabled ? 'Blocking enabled' : 'Blocking disabled'}
    </div>
  )
}

export function SummaryTiles({ summary }: { summary: Summary }) {
  const percent = summaryPercentBlocked(summary)
  return (
    <div className="dash-tiles">
      <Tile
        label="Total queries"
        value={tileNumber(summary.totalQueries)}
        title={`${formatCount(summary.totalQueries)} queries`}
      />
      <Tile
        label="Queries blocked"
        value={tileNumber(summary.blockedQueries)}
        title={`${formatCount(summary.blockedQueries)} queries blocked`}
        swatch="var(--blocked, #d03b3b)"
      />
      <Tile label="Percent blocked" value={formatPercent(percent)} title={`${formatPercent(percent)} of queries blocked`} />
      <Tile
        label="Domains on blocklists"
        value={tileNumber(summary.domainsOnBlocklists)}
        title={`${formatCount(summary.domainsOnBlocklists)} domains on blocklists`}
      />
      <Tile
        label="Active clients"
        value={tileNumber(summary.activeClients)}
        title={`${formatCount(summary.activeClients)} active clients`}
      />
    </div>
  )
}
