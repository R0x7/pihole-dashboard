/**
 * A realistic DashboardData fixture: 24 hours of 10-minute buckets, 10
 * clients and plausible ad/tracker domains. Used by the tests and for demos.
 * No React or DOM imports.
 */
import type { DashboardData, HistoryPoint, TopClient, TopDomain } from '@shared/contract'

const BUCKET_SECONDS = 600
const BUCKETS = 144

interface MockClient {
  name: string
  ip: string
  /** Share of the household's traffic. */
  weight: number
  /** Typical fraction of this client's queries that get blocked. */
  blockRatio: number
}

const CLIENTS: MockClient[] = [
  { name: 'living-room-tv', ip: '192.168.1.40', weight: 0.22, blockRatio: 0.42 },
  { name: 'hunters-pc', ip: '192.168.1.10', weight: 0.18, blockRatio: 0.12 },
  { name: 'pixel-8', ip: '192.168.1.21', weight: 0.13, blockRatio: 0.24 },
  { name: 'ipad', ip: '192.168.1.22', weight: 0.1, blockRatio: 0.2 },
  { name: 'work-laptop', ip: '192.168.1.11', weight: 0.09, blockRatio: 0.08 },
  { name: 'roku-bedroom', ip: '192.168.1.41', weight: 0.08, blockRatio: 0.38 },
  { name: 'echo-kitchen', ip: '192.168.1.52', weight: 0.06, blockRatio: 0.3 },
  // A device without a hostname: the contract says name falls back to the IP.
  { name: '192.168.1.87', ip: '192.168.1.87', weight: 0.05, blockRatio: 0.5 },
  { name: 'nintendo-switch', ip: '192.168.1.60', weight: 0.05, blockRatio: 0.1 },
  { name: 'hp-officejet', ip: '192.168.1.70', weight: 0.04, blockRatio: 0.05 }
]

/** Domain and its share of all blocked queries (the remainder is the long tail). */
const BLOCKED_DOMAINS: [string, number][] = [
  ['doubleclick.net', 0.14],
  ['googleads.g.doubleclick.net', 0.11],
  ['graph.facebook.com', 0.085],
  ['app-measurement.com', 0.07],
  ['logs.netflix.com', 0.06],
  ['scribe.logs.roku.com', 0.055],
  ['device-metrics-us.amazon.com', 0.045],
  ['mobile.pipe.aria.microsoft.com', 0.04],
  ['ssl.google-analytics.com', 0.035],
  ['settings-win.data.microsoft.com', 0.03],
  ['samsungads.com', 0.025],
  ['incoming.telemetry.mozilla.org', 0.015]
]

/** Small deterministic PRNG so the fixture is stable for a given `nowMs`. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 0.15 overnight, rising through the day to a peak in the evening. */
function activityAt(timestampSeconds: number): number {
  const d = new Date(timestampSeconds * 1000)
  const hour = d.getHours() + d.getMinutes() / 60
  if (hour < 6.5) return 0.15
  const day = Math.sin(((hour - 6.5) / 17.5) * Math.PI)
  const evening = Math.exp(-((hour - 20.5) ** 2) / 4)
  return 0.15 + 0.55 * day + 0.5 * evening
}

export function createMockDashboardData(nowMs: number = Date.now()): DashboardData {
  const rand = mulberry32(20261108)
  const lastBucket = Math.floor(nowMs / 1000 / BUCKET_SECONDS) * BUCKET_SECONDS
  const firstBucket = lastBucket - (BUCKETS - 1) * BUCKET_SECONDS

  const history: HistoryPoint[] = []
  const perClientCounts: number[][] = []
  const clientTotals = CLIENTS.map(() => 0)
  const clientBlocked = CLIENTS.map(() => 0)

  for (let b = 0; b < BUCKETS; b++) {
    const timestamp = firstBucket + b * BUCKET_SECONDS
    const activity = activityAt(timestamp)
    const counts: number[] = []
    let total = 0
    let blocked = 0
    CLIENTS.forEach((client, i) => {
      const queries = Math.round(520 * activity * client.weight * (0.6 + 0.8 * rand()))
      const blockedQueries = Math.min(queries, Math.round(queries * client.blockRatio * (0.75 + 0.5 * rand())))
      counts.push(queries)
      total += queries
      blocked += blockedQueries
      clientTotals[i] += queries
      clientBlocked[i] += blockedQueries
    })
    perClientCounts.push(counts)
    history.push({ timestamp, total, blocked, allowed: total - blocked })
  }

  const totalQueries = clientTotals.reduce((a, b) => a + b, 0)
  const blockedQueries = clientBlocked.reduce((a, b) => a + b, 0)

  // Column order for clientHistory: busiest first.
  const order = CLIENTS.map((_, i) => i).sort((a, b) => clientTotals[b] - clientTotals[a])

  const topClientsTotal: TopClient[] = order.map((i) => ({
    name: CLIENTS[i].name,
    ip: CLIENTS[i].ip,
    count: clientTotals[i]
  }))
  const topClientsBlocked: TopClient[] = CLIENTS.map((client, i) => ({
    name: client.name,
    ip: client.ip,
    count: clientBlocked[i]
  })).sort((a, b) => b.count - a.count)

  const topBlockedDomains: TopDomain[] = BLOCKED_DOMAINS.slice(0, 10)
    .map(([domain, share]) => ({ domain, count: Math.round(blockedQueries * share) }))
    .sort((a, b) => b.count - a.count)

  return {
    summary: {
      totalQueries,
      blockedQueries,
      percentBlocked: totalQueries > 0 ? (blockedQueries / totalQueries) * 100 : 0,
      domainsOnBlocklists: 1_284_519,
      activeClients: CLIENTS.length,
      blockingEnabled: true
    },
    history,
    topBlockedDomains,
    topClientsBlocked,
    topClientsTotal,
    clientHistory: {
      clients: order.map((i) => ({ name: CLIENTS[i].name, ip: CLIENTS[i].ip })),
      points: history.map((point, b) => ({
        timestamp: point.timestamp,
        counts: order.map((i) => perClientCounts[b][i])
      }))
    },
    fetchedAt: nowMs
  }
}

/** A stable snapshot (fetched 2026-11-08 18:00 UTC) for tests. */
export const mockDashboardData: DashboardData = createMockDashboardData(Date.UTC(2026, 10, 8, 18, 0, 0))

/** What a freshly installed Pi-hole reports: nothing yet. */
export const emptyDashboardData: DashboardData = {
  summary: {
    totalQueries: 0,
    blockedQueries: 0,
    percentBlocked: 0,
    domainsOnBlocklists: 0,
    activeClients: 0,
    blockingEnabled: null
  },
  history: [],
  topBlockedDomains: [],
  topClientsBlocked: [],
  topClientsTotal: [],
  clientHistory: { clients: [], points: [] },
  fetchedAt: Date.UTC(2026, 10, 8, 18, 0, 0)
}
