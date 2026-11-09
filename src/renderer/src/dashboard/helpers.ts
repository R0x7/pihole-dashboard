/**
 * Pure data shaping for the dashboard views. No React or DOM imports, so this
 * module is unit-testable in a plain node environment.
 */
import type { ClientHistory, HistoryPoint, Summary, TopClient, TopDomain } from '@shared/contract'

// ---------- Numbers ----------

/** A finite, non-negative number; anything else (NaN, Infinity, negatives, non-numbers) becomes 0. */
export function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** part / total as 0-100. Never NaN: a zero or invalid total gives 0. */
export function percentOf(part: number, total: number): number {
  const p = safeCount(part)
  const t = safeCount(total)
  if (t === 0) return 0
  return Math.min(100, (p / t) * 100)
}

/**
 * The percent blocked to display for a summary: the reported value when it is
 * a usable number, otherwise derived from the counts.
 */
export function summaryPercentBlocked(summary: Summary): number {
  const reported = summary.percentBlocked
  if (typeof reported === 'number' && Number.isFinite(reported)) {
    return Math.min(100, Math.max(0, reported))
  }
  return percentOf(summary.blockedQueries, summary.totalQueries)
}

const formatterCache = new Map<string, Intl.NumberFormat>()

function numberFormat(locale: string | undefined, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale ?? ''}|${JSON.stringify(options)}`
  let fmt = formatterCache.get(key)
  if (!fmt) {
    fmt = new Intl.NumberFormat(locale, options)
    formatterCache.set(key, fmt)
  }
  return fmt
}

/** Whole number with thousands separators, e.g. 1,234,567. */
export function formatCount(value: number, locale?: string): string {
  return numberFormat(locale, { maximumFractionDigits: 0 }).format(Math.round(safeCount(value)))
}

/** Compact number for tight spaces, e.g. 1.2K, 3.4M. */
export function formatCompact(value: number, locale?: string): string {
  return numberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(safeCount(value))
}

/** A 0-100 value as a percentage with exactly one decimal, e.g. 12.3%. */
export function formatPercent(percent: number, locale?: string): string {
  const p = typeof percent === 'number' && Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0
  return numberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  }).format(p / 100)
}

// ---------- Text ----------

const ELLIPSIS = '…'

/**
 * Shorten long text by cutting out the middle, which keeps both the start of
 * a domain and its registrable end visible. The result is at most `max`
 * characters including the ellipsis.
 */
export function truncateMiddle(text: string, max: number): string {
  if (max <= 0) return ''
  if (text.length <= max) return text
  if (max === 1) return ELLIPSIS
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  return text.slice(0, head) + ELLIPSIS + (tail > 0 ? text.slice(text.length - tail) : '')
}

/** Shorten long text by cutting the end. At most `max` characters including the ellipsis. */
export function truncateEnd(text: string, max: number): string {
  if (max <= 0) return ''
  if (text.length <= max) return text
  if (max === 1) return ELLIPSIS
  return text.slice(0, max - 1) + ELLIPSIS
}

/** Name and IP for a client; the IP is dropped when it would only repeat the name. */
export function clientLabel(name: string, ip: string): { primary: string; secondary: string | null } {
  const n = (name ?? '').trim()
  const i = (ip ?? '').trim()
  if (!n) return { primary: i || 'Unknown client', secondary: null }
  if (!i || n === i) return { primary: n, secondary: null }
  return { primary: n, secondary: i }
}

// ---------- Time ----------

/** Local wall-clock time, e.g. 14:30 or 2:30 PM depending on the locale. */
export function formatTime(ms: number, locale?: string): string {
  if (!Number.isFinite(ms)) return ''
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(new Date(ms))
}

/** Local weekday and time for tooltips, e.g. Sun 14:30. */
export function formatDateTime(ms: number, locale?: string): string {
  if (!Number.isFinite(ms)) return ''
  return new Intl.DateTimeFormat(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(
    new Date(ms)
  )
}

const TICK_STEPS_HOURS = [1, 2, 3, 4, 6, 12, 24]
const HOUR_MS = 3_600_000

/**
 * Axis ticks (ms) on local whole hours between start and end, with the step
 * chosen so that there are at most `maxTicks` of them.
 */
export function timeTicks(startMs: number, endMs: number, maxTicks = 6): number[] {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || maxTicks < 1) return []
  const spanHours = (endMs - startMs) / HOUR_MS
  const step = TICK_STEPS_HOURS.find((s) => spanHours / s <= maxTicks) ?? 24

  const cursor = new Date(startMs)
  if (cursor.getMinutes() !== 0 || cursor.getSeconds() !== 0 || cursor.getMilliseconds() !== 0) {
    cursor.setHours(cursor.getHours() + 1, 0, 0, 0)
  }
  let guard = 0
  while (cursor.getHours() % step !== 0 && guard < 24) {
    cursor.setHours(cursor.getHours() + 1)
    guard += 1
  }

  const ticks: number[] = []
  while (cursor.getTime() <= endMs && ticks.length < 100) {
    ticks.push(cursor.getTime())
    const before = cursor.getTime()
    cursor.setHours(cursor.getHours() + step)
    if (cursor.getTime() <= before) cursor.setTime(before + step * HOUR_MS) // DST safety
  }
  return ticks
}

// ---------- Queries over time ----------

export interface HistoryRow {
  /** Bucket start, Unix milliseconds. */
  t: number
  allowed: number
  blocked: number
  total: number
  /** 0-100, 0 for an empty bucket. */
  percentBlocked: number
}

/** History points to chart rows: ms timestamps, sanitised counts, oldest first. */
export function historyToRows(history: readonly HistoryPoint[] | null | undefined): HistoryRow[] {
  if (!Array.isArray(history)) return []
  const rows: HistoryRow[] = []
  for (const point of history) {
    if (!point || !Number.isFinite(point.timestamp)) continue
    const blocked = safeCount(point.blocked)
    // Trust total - blocked when a total is given, so the stack always sums to the total.
    const total = Math.max(safeCount(point.total), blocked)
    const allowed = total > 0 ? total - blocked : safeCount(point.allowed)
    const sum = allowed + blocked
    rows.push({
      t: point.timestamp * 1000,
      allowed,
      blocked,
      total: sum,
      percentBlocked: percentOf(blocked, sum)
    })
  }
  rows.sort((a, b) => a.t - b.t)
  return rows
}

/** False when there is nothing worth plotting (no rows, or every bucket is zero). */
export function hasHistoryData(rows: readonly HistoryRow[]): boolean {
  return rows.some((row) => row.total > 0)
}

// ---------- Ranked bars ----------

export interface RankedRow {
  key: string
  rank: number
  /** Full, untruncated label. */
  label: string
  /** Label shortened for display. */
  shortLabel: string
  /** Secondary text, e.g. a client's IP. */
  detail: string | null
  count: number
  /** 0-1 relative to the largest count, for the bar length. */
  fraction: number
}

function rank<T>(
  items: readonly T[] | null | undefined,
  limit: number,
  count: (item: T) => number,
  describe: (item: T) => { key: string; label: string; detail: string | null },
  maxLabel: number,
  truncate: (text: string, max: number) => string
): RankedRow[] {
  if (!Array.isArray(items)) return []
  const kept = (items as T[])
    .filter((item) => item != null && safeCount(count(item)) > 0)
    .map((item) => ({ item, count: safeCount(count(item)) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.max(0, limit))
  const max = kept.length > 0 ? kept[0].count : 0
  return kept.map(({ item, count: c }, index) => {
    const d = describe(item)
    return {
      key: `${index}:${d.key}`,
      rank: index + 1,
      label: d.label,
      shortLabel: truncate(d.label, maxLabel),
      detail: d.detail,
      count: c,
      fraction: max > 0 ? c / max : 0
    }
  })
}

/** Top domains, largest first, zero-count entries dropped. */
export function rankDomains(
  domains: readonly TopDomain[] | null | undefined,
  limit = 10,
  maxLabel = 34
): RankedRow[] {
  return rank(
    domains,
    limit,
    (d) => d.count,
    (d) => ({ key: d.domain, label: d.domain || '(unknown domain)', detail: null }),
    maxLabel,
    truncateMiddle
  )
}

/** Top clients, largest first, zero-count entries dropped. */
export function rankClients(
  clients: readonly TopClient[] | null | undefined,
  limit = 10,
  maxLabel = 24
): RankedRow[] {
  return rank(
    clients,
    limit,
    (c) => c.count,
    (c) => {
      const label = clientLabel(c.name, c.ip)
      return { key: `${c.name}|${c.ip}`, label: label.primary, detail: label.secondary }
    },
    maxLabel,
    truncateEnd
  )
}

// ---------- Client activity over time ----------

export interface ClientSeries {
  /** Data key in each chart row. */
  key: string
  /** Full display name. */
  name: string
  shortName: string
  ip: string | null
  /** Sum over the whole period. */
  total: number
  /** True for the folded "Other" series. */
  isOther: boolean
  /** Index into the categorical palette; -1 for "Other". */
  colorIndex: number
}

export interface ClientChartRow {
  t: number
  total: number
  [seriesKey: string]: number
}

export interface ClientChart {
  series: ClientSeries[]
  rows: ClientChartRow[]
  /** False when there are no clients, no points, or every count is zero. */
  hasData: boolean
}

export const OTHER_SERIES_KEY = 'other'

/**
 * Client history to stacked chart rows. The first `maxSeries` clients (the
 * contract orders them busiest first) each get a series and a fixed palette
 * slot; the rest fold into one "Other" series so colours are never recycled.
 */
export function clientHistoryToChart(
  history: ClientHistory | null | undefined,
  maxSeries = 7,
  maxLabel = 18
): ClientChart {
  const clients = Array.isArray(history?.clients) ? history.clients : []
  const points = Array.isArray(history?.points) ? history.points : []
  const shown = Math.max(0, Math.min(maxSeries, clients.length))
  const folded = clients.length > shown

  const series: ClientSeries[] = []
  for (let i = 0; i < shown; i++) {
    const label = clientLabel(clients[i]?.name ?? '', clients[i]?.ip ?? '')
    series.push({
      key: `c${i}`,
      name: label.primary,
      shortName: truncateEnd(label.primary, maxLabel),
      ip: label.secondary,
      total: 0,
      isOther: false,
      colorIndex: i
    })
  }
  if (folded) {
    const n = clients.length - shown
    const name = `Other (${n} ${n === 1 ? 'client' : 'clients'})`
    series.push({
      key: OTHER_SERIES_KEY,
      name,
      shortName: name,
      ip: null,
      total: 0,
      isOther: true,
      colorIndex: -1
    })
  }

  const rows: ClientChartRow[] = []
  for (const point of points) {
    if (!point || !Number.isFinite(point.timestamp)) continue
    const counts = Array.isArray(point.counts) ? point.counts : []
    const row: ClientChartRow = { t: point.timestamp * 1000, total: 0 }
    for (let i = 0; i < shown; i++) {
      const value = safeCount(counts[i])
      row[`c${i}`] = value
      row.total += value
      series[i].total += value
    }
    if (folded) {
      let other = 0
      for (let i = shown; i < clients.length; i++) other += safeCount(counts[i])
      row[OTHER_SERIES_KEY] = other
      row.total += other
      series[shown].total += other
    }
    rows.push(row)
  }
  rows.sort((a, b) => a.t - b.t)

  return { series, rows, hasData: series.length > 0 && rows.some((row) => row.total > 0) }
}
