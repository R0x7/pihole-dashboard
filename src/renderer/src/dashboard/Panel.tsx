import type { ReactNode } from 'react'

export interface PanelProps {
  title: string
  subtitle?: string
  /** Controls shown at the right of the header, e.g. a toggle. */
  actions?: ReactNode
  wide?: boolean
  children: ReactNode
}

export function Panel({ title, subtitle, actions, wide, children }: PanelProps) {
  return (
    <section className={wide ? 'dash-panel dash-panel-wide' : 'dash-panel'}>
      <div className="dash-panel-head">
        <h2 className="dash-panel-title">
          {title}
          {subtitle ? <span className="dash-panel-sub">{subtitle}</span> : null}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  )
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="dash-empty">{children}</div>
}

export interface LegendItem {
  key: string
  label: string
  /** Full text for the hover title when the label is shortened. */
  title?: string
  color: string
}

export function Legend({ items }: { items: LegendItem[] }) {
  return (
    <ul className="dash-legend">
      {items.map((item) => (
        <li key={item.key} title={item.title ?? item.label}>
          <span className="dash-swatch" style={{ background: item.color }} />
          {item.label}
        </li>
      ))}
    </ul>
  )
}

export interface TooltipRow {
  key: string
  label: string
  value: string
  color?: string
}

/** Shared tooltip body for the time charts. */
export function ChartTooltip({ title, rows, footer }: { title: string; rows: TooltipRow[]; footer?: TooltipRow[] }) {
  return (
    <div className="dash-tooltip">
      <div className="dash-tooltip-title">{title}</div>
      {rows.map((row) => (
        <TooltipLine key={row.key} row={row} />
      ))}
      {footer && footer.length > 0 ? (
        <div className="dash-tooltip-foot">
          {footer.map((row) => (
            <TooltipLine key={row.key} row={row} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function TooltipLine({ row }: { row: TooltipRow }) {
  return (
    <div className="dash-tooltip-row">
      {row.color ? <span className="dash-swatch" style={{ background: row.color }} /> : null}
      <span className="dash-tooltip-name">{row.label}</span>
      <span className="dash-tooltip-value">{row.value}</span>
    </div>
  )
}

/** Axis and grid styling shared by the time charts; all colours are app variables. */
export const AXIS_TICK = { fill: 'var(--text-muted, #6b6a66)', fontSize: 11 } as const
export const AXIS_LINE = { stroke: 'var(--border, #e1e0d9)' } as const
export const GRID_STROKE = 'var(--border, #e1e0d9)'
export const CURSOR = { stroke: 'var(--text-muted, #6b6a66)', strokeWidth: 1 } as const
export const SURFACE = 'var(--surface, #fff)'

/** X domain for a time axis; widened when there is only a single bucket. */
export function timeDomain(rows: readonly { t: number }[]): [number, number] {
  if (rows.length === 0) return [0, 1]
  const first = rows[0].t
  const last = rows[rows.length - 1].t
  return last > first ? [first, last] : [first - 3_600_000, first + 3_600_000]
}
