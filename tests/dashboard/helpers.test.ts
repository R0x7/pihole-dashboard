import { describe, expect, it } from 'vitest'
import type { ClientHistory, HistoryPoint, Summary } from '@shared/contract'
import {
  clientHistoryToChart,
  clientLabel,
  formatCompact,
  formatCount,
  formatPercent,
  formatTime,
  hasHistoryData,
  historyToRows,
  OTHER_SERIES_KEY,
  percentOf,
  rankClients,
  rankDomains,
  safeCount,
  summaryPercentBlocked,
  timeTicks,
  truncateEnd,
  truncateMiddle
} from '@renderer/dashboard/helpers'
import { emptyDashboardData, mockDashboardData } from '@renderer/dashboard/mockData'

const summary = (over: Partial<Summary>): Summary => ({
  totalQueries: 0,
  blockedQueries: 0,
  percentBlocked: 0,
  domainsOnBlocklists: 0,
  activeClients: 0,
  blockingEnabled: null,
  ...over
})

describe('numbers', () => {
  it('safeCount rejects NaN, infinities, negatives and non-numbers', () => {
    expect(safeCount(12)).toBe(12)
    expect(safeCount(NaN)).toBe(0)
    expect(safeCount(Infinity)).toBe(0)
    expect(safeCount(-3)).toBe(0)
    expect(safeCount(undefined)).toBe(0)
    expect(safeCount('7')).toBe(0)
  })

  it('percentOf never divides by zero', () => {
    expect(percentOf(25, 100)).toBe(25)
    expect(percentOf(0, 0)).toBe(0)
    expect(percentOf(5, 0)).toBe(0)
    expect(percentOf(NaN, 10)).toBe(0)
    expect(percentOf(10, NaN)).toBe(0)
    expect(percentOf(20, 10)).toBe(100)
  })

  it('summaryPercentBlocked uses the reported value, clamped', () => {
    expect(summaryPercentBlocked(summary({ percentBlocked: 12.34 }))).toBe(12.34)
    expect(summaryPercentBlocked(summary({ percentBlocked: 140 }))).toBe(100)
    expect(summaryPercentBlocked(summary({ percentBlocked: -1 }))).toBe(0)
  })

  it('summaryPercentBlocked falls back to the counts when the reported value is unusable', () => {
    expect(summaryPercentBlocked(summary({ percentBlocked: NaN, totalQueries: 200, blockedQueries: 50 }))).toBe(25)
    expect(summaryPercentBlocked(summary({ percentBlocked: NaN }))).toBe(0)
  })

  it('formats counts with thousands separators', () => {
    expect(formatCount(1234567, 'en-US')).toBe('1,234,567')
    expect(formatCount(0, 'en-US')).toBe('0')
    expect(formatCount(NaN, 'en-US')).toBe('0')
    expect(formatCount(12.6, 'en-US')).toBe('13')
  })

  it('formats compact numbers', () => {
    expect(formatCompact(950, 'en-US')).toBe('950')
    expect(formatCompact(1234, 'en-US')).toBe('1.2K')
    expect(formatCompact(3_400_000, 'en-US')).toBe('3.4M')
    expect(formatCompact(NaN, 'en-US')).toBe('0')
  })

  it('formats percentages to one decimal and never prints NaN', () => {
    expect(formatPercent(12.345, 'en-US')).toBe('12.3%')
    expect(formatPercent(0, 'en-US')).toBe('0.0%')
    expect(formatPercent(100, 'en-US')).toBe('100.0%')
    expect(formatPercent(NaN, 'en-US')).toBe('0.0%')
    expect(formatPercent(percentOf(0, 0), 'en-US')).toBe('0.0%')
  })
})

describe('text', () => {
  it('truncateMiddle keeps both ends within the limit', () => {
    expect(truncateMiddle('doubleclick.net', 34)).toBe('doubleclick.net')
    const long = 'a-very-long-tracking-subdomain.metrics.example-cdn.com'
    const short = truncateMiddle(long, 20)
    expect(short).toHaveLength(20)
    expect(short.startsWith('a-very-lon')).toBe(true)
    expect(short.endsWith('e-cdn.com')).toBe(true)
    expect(short).toContain('…')
  })

  it('truncation handles tiny limits and empty text', () => {
    expect(truncateMiddle('abcdef', 0)).toBe('')
    expect(truncateMiddle('abcdef', 1)).toBe('…')
    expect(truncateMiddle('abcdef', 2)).toBe('a…')
    expect(truncateMiddle('', 5)).toBe('')
    expect(truncateEnd('abcdef', 4)).toBe('abc…')
    expect(truncateEnd('abc', 4)).toBe('abc')
    expect(truncateEnd('abcdef', 0)).toBe('')
  })

  it('clientLabel drops an IP that only repeats the name', () => {
    expect(clientLabel('tv', '192.168.1.40')).toEqual({ primary: 'tv', secondary: '192.168.1.40' })
    expect(clientLabel('192.168.1.87', '192.168.1.87')).toEqual({ primary: '192.168.1.87', secondary: null })
    expect(clientLabel('', '192.168.1.5')).toEqual({ primary: '192.168.1.5', secondary: null })
    expect(clientLabel('', '')).toEqual({ primary: 'Unknown client', secondary: null })
  })
})

describe('time', () => {
  it('timeTicks returns local whole hours inside the range, capped in number', () => {
    const end = Date.UTC(2026, 10, 8, 18, 7, 0)
    const start = end - 24 * 3_600_000
    const ticks = timeTicks(start, end, 6)
    expect(ticks.length).toBeGreaterThan(2)
    expect(ticks.length).toBeLessThanOrEqual(7)
    for (const tick of ticks) {
      expect(tick).toBeGreaterThanOrEqual(start)
      expect(tick).toBeLessThanOrEqual(end)
      const d = new Date(tick)
      expect(d.getMinutes()).toBe(0)
      expect(d.getSeconds()).toBe(0)
    }
    expect([...ticks].sort((a, b) => a - b)).toEqual(ticks)
  })

  it('timeTicks is empty for an empty or invalid range', () => {
    expect(timeTicks(1000, 1000)).toEqual([])
    expect(timeTicks(2000, 1000)).toEqual([])
    expect(timeTicks(NaN, 1000)).toEqual([])
  })

  it('formatTime tolerates invalid input', () => {
    expect(formatTime(NaN)).toBe('')
    expect(formatTime(Date.UTC(2026, 10, 8, 18, 0, 0), 'en-US')).toMatch(/\d{1,2}:00/)
  })
})

describe('historyToRows', () => {
  it('converts to milliseconds and computes percent blocked', () => {
    const history: HistoryPoint[] = [
      { timestamp: 1_800_000_600, total: 100, blocked: 25, allowed: 75 },
      { timestamp: 1_800_000_000, total: 40, blocked: 0, allowed: 40 }
    ]
    const rows = historyToRows(history)
    expect(rows).toEqual([
      { t: 1_800_000_000_000, allowed: 40, blocked: 0, total: 40, percentBlocked: 0 },
      { t: 1_800_000_600_000, allowed: 75, blocked: 25, total: 100, percentBlocked: 25 }
    ])
  })

  it('handles empty, missing and all-zero history', () => {
    expect(historyToRows([])).toEqual([])
    expect(historyToRows(undefined)).toEqual([])
    expect(hasHistoryData([])).toBe(false)
    const zeros = historyToRows([
      { timestamp: 1, total: 0, blocked: 0, allowed: 0 },
      { timestamp: 2, total: 0, blocked: 0, allowed: 0 }
    ])
    expect(zeros).toHaveLength(2)
    expect(zeros.every((r) => r.percentBlocked === 0 && r.total === 0)).toBe(true)
    expect(hasHistoryData(zeros)).toBe(false)
  })

  it('sanitises bad values so nothing becomes NaN', () => {
    const rows = historyToRows([
      { timestamp: 10, total: NaN, blocked: -5, allowed: NaN },
      { timestamp: 20, total: 10, blocked: 30, allowed: -20 },
      { timestamp: NaN, total: 10, blocked: 1, allowed: 9 }
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ t: 10_000, allowed: 0, blocked: 0, total: 0, percentBlocked: 0 })
    expect(rows[1]).toEqual({ t: 20_000, allowed: 0, blocked: 30, total: 30, percentBlocked: 100 })
    for (const row of rows) {
      for (const value of Object.values(row)) expect(Number.isFinite(value)).toBe(true)
    }
  })
})

describe('ranked rows', () => {
  it('ranks domains by count with fractions of the largest', () => {
    const rows = rankDomains([
      { domain: 'b.example', count: 50 },
      { domain: 'a.example', count: 200 },
      { domain: 'zero.example', count: 0 }
    ])
    expect(rows.map((r) => r.label)).toEqual(['a.example', 'b.example'])
    expect(rows.map((r) => r.rank)).toEqual([1, 2])
    expect(rows.map((r) => r.fraction)).toEqual([1, 0.25])
  })

  it('truncates long domains but keeps the full label', () => {
    const domain = 'telemetry.subdomain.with-a-very-long-name.analytics.example.com'
    const [row] = rankDomains([{ domain, count: 3 }], 10, 24)
    expect(row.label).toBe(domain)
    expect(row.shortLabel).toHaveLength(24)
  })

  it('applies the limit and survives empty input', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ domain: `d${i}.example`, count: i + 1 }))
    expect(rankDomains(many, 10)).toHaveLength(10)
    expect(rankDomains([])).toEqual([])
    expect(rankDomains(undefined)).toEqual([])
    expect(rankClients([])).toEqual([])
    expect(rankClients([{ name: 'tv', ip: '10.0.0.2', count: 0 }])).toEqual([])
  })

  it('ranks clients with name and IP', () => {
    const rows = rankClients([
      { name: 'tv', ip: '10.0.0.2', count: 10 },
      { name: '10.0.0.9', ip: '10.0.0.9', count: 40 }
    ])
    expect(rows[0]).toMatchObject({ label: '10.0.0.9', detail: null, count: 40, fraction: 1 })
    expect(rows[1]).toMatchObject({ label: 'tv', detail: '10.0.0.2', count: 10, fraction: 0.25 })
    expect(new Set(rows.map((r) => r.key)).size).toBe(2)
  })
})

describe('clientHistoryToChart', () => {
  const history: ClientHistory = {
    clients: [
      { name: 'tv', ip: '10.0.0.2' },
      { name: 'pc', ip: '10.0.0.3' },
      { name: 'phone', ip: '10.0.0.4' }
    ],
    points: [
      { timestamp: 600, counts: [1, 2, 3] },
      { timestamp: 0, counts: [5, 0, 1] }
    ]
  }

  it('produces one series per client and rows keyed by series', () => {
    const chart = clientHistoryToChart(history)
    expect(chart.hasData).toBe(true)
    expect(chart.series.map((s) => s.key)).toEqual(['c0', 'c1', 'c2'])
    expect(chart.series.map((s) => s.colorIndex)).toEqual([0, 1, 2])
    expect(chart.series.map((s) => s.total)).toEqual([6, 2, 4])
    expect(chart.rows).toEqual([
      { t: 0, total: 6, c0: 5, c1: 0, c2: 1 },
      { t: 600_000, total: 6, c0: 1, c1: 2, c2: 3 }
    ])
  })

  it('folds clients beyond the series limit into Other', () => {
    const chart = clientHistoryToChart(history, 1)
    expect(chart.series.map((s) => s.key)).toEqual(['c0', OTHER_SERIES_KEY])
    expect(chart.series[1]).toMatchObject({ isOther: true, colorIndex: -1, name: 'Other (2 clients)', total: 6 })
    expect(chart.rows[0]).toEqual({ t: 0, total: 6, c0: 5, [OTHER_SERIES_KEY]: 1 })
    expect(chart.rows[1]).toEqual({ t: 600_000, total: 6, c0: 1, [OTHER_SERIES_KEY]: 5 })
  })

  it('handles empty and all-zero input', () => {
    expect(clientHistoryToChart({ clients: [], points: [] })).toEqual({ series: [], rows: [], hasData: false })
    expect(clientHistoryToChart(undefined).hasData).toBe(false)
    expect(clientHistoryToChart({ clients: history.clients, points: [] }).hasData).toBe(false)
    expect(
      clientHistoryToChart({ clients: history.clients, points: [{ timestamp: 0, counts: [0, 0, 0] }] }).hasData
    ).toBe(false)
    expect(clientHistoryToChart({ clients: [], points: [{ timestamp: 0, counts: [] }] }).hasData).toBe(false)
  })

  it('treats short or invalid count arrays as zeros', () => {
    const chart = clientHistoryToChart({
      clients: history.clients,
      points: [{ timestamp: 0, counts: [4, NaN] }]
    })
    expect(chart.rows[0]).toEqual({ t: 0, total: 4, c0: 4, c1: 0, c2: 0 })
  })
})

describe('mock data', () => {
  it('is 24 hours of 10-minute buckets, oldest first and internally consistent', () => {
    const { history, summary: s, clientHistory } = mockDashboardData
    expect(history).toHaveLength(144)
    for (let i = 1; i < history.length; i++) {
      expect(history[i].timestamp - history[i - 1].timestamp).toBe(600)
    }
    for (const point of history) expect(point.allowed).toBe(point.total - point.blocked)
    expect(history.reduce((sum, p) => sum + p.total, 0)).toBe(s.totalQueries)
    expect(history.reduce((sum, p) => sum + p.blocked, 0)).toBe(s.blockedQueries)
    expect(s.percentBlocked).toBeGreaterThan(5)
    expect(s.percentBlocked).toBeLessThan(60)

    expect(clientHistory.clients).toHaveLength(10)
    expect(clientHistory.points).toHaveLength(144)
    clientHistory.points.forEach((point, i) => {
      expect(point.counts).toHaveLength(10)
      expect(point.counts.reduce((a, b) => a + b, 0)).toBe(history[i].total)
    })
  })

  it('has ranked lists sorted descending', () => {
    for (const list of [
      mockDashboardData.topBlockedDomains,
      mockDashboardData.topClientsBlocked,
      mockDashboardData.topClientsTotal
    ]) {
      expect(list.length).toBeGreaterThan(0)
      for (let i = 1; i < list.length; i++) expect(list[i].count).toBeLessThanOrEqual(list[i - 1].count)
    }
  })

  it('shapes cleanly through every helper', () => {
    const rows = historyToRows(mockDashboardData.history)
    expect(hasHistoryData(rows)).toBe(true)
    const chart = clientHistoryToChart(mockDashboardData.clientHistory, 7)
    expect(chart.series).toHaveLength(8)
    expect(chart.series[7].isOther).toBe(true)
    chart.rows.forEach((row, i) => expect(row.total).toBe(rows[i].total))
    expect(rankDomains(mockDashboardData.topBlockedDomains)).toHaveLength(10)
    expect(rankClients(mockDashboardData.topClientsBlocked)).toHaveLength(10)
  })

  it('the empty fixture produces empty states, not errors', () => {
    expect(hasHistoryData(historyToRows(emptyDashboardData.history))).toBe(false)
    expect(clientHistoryToChart(emptyDashboardData.clientHistory).hasData).toBe(false)
    expect(rankDomains(emptyDashboardData.topBlockedDomains)).toEqual([])
    expect(rankClients(emptyDashboardData.topClientsTotal)).toEqual([])
    expect(formatPercent(summaryPercentBlocked(emptyDashboardData.summary), 'en-US')).toBe('0.0%')
  })
})
