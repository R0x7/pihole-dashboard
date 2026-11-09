// Translation of raw Pi-hole v6 API payloads into the app's contract shapes.
import type {
  ClientHistory,
  HistoryPoint,
  Summary,
  TopClient,
  TopDomain
} from '@shared/contract'

/** Thrown when a payload does not look like the expected Pi-hole response. */
export class ShapeError extends Error {
  constructor(what: string) {
    super(what)
    this.name = 'ShapeError'
  }
}

export const MAX_HISTORY_CLIENTS = 10
/** Only the most recent entries of a history are kept (a real one has ~144). */
export const MAX_HISTORY_POINTS = 2000

type Obj = Record<string, unknown>

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function requireObj(value: unknown, what: string): Obj {
  if (!isObj(value)) throw new ShapeError(what)
  return value
}

function requireArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new ShapeError(what)
  return value
}

export function normalizeBlocking(raw: unknown): boolean | null {
  if (!isObj(raw)) return null
  if (raw.blocking === 'enabled' || raw.blocking === true) return true
  if (raw.blocking === 'disabled' || raw.blocking === false) return false
  return null
}

export function normalizeSummary(raw: unknown, blockingEnabled: boolean | null): Summary {
  const root = requireObj(raw, 'summary')
  const queries = requireObj(root.queries, 'summary.queries')
  if (typeof queries.total !== 'number' || typeof queries.blocked !== 'number') {
    throw new ShapeError('summary.queries')
  }
  const clients = isObj(root.clients) ? root.clients : {}
  const gravity = isObj(root.gravity) ? root.gravity : {}
  const total = num(queries.total)
  const blocked = num(queries.blocked)
  const percent =
    typeof queries.percent_blocked === 'number' && Number.isFinite(queries.percent_blocked)
      ? queries.percent_blocked
      : total > 0
        ? (blocked / total) * 100
        : 0
  return {
    totalQueries: total,
    blockedQueries: blocked,
    percentBlocked: Math.min(100, Math.max(0, percent)),
    domainsOnBlocklists: num(gravity.domains_being_blocked),
    activeClients: num(clients.active),
    blockingEnabled
  }
}

export function normalizeHistory(raw: unknown): HistoryPoint[] {
  const list = requireArray(requireObj(raw, 'history').history, 'history.history')
  const points: HistoryPoint[] = []
  for (const item of list) {
    if (!isObj(item) || typeof item.timestamp !== 'number') continue
    const total = num(item.total)
    const blocked = num(item.blocked)
    points.push({
      timestamp: item.timestamp,
      total,
      blocked,
      allowed: Math.max(0, total - blocked)
    })
  }
  return points.sort((a, b) => a.timestamp - b.timestamp).slice(-MAX_HISTORY_POINTS)
}

export function normalizeTopDomains(raw: unknown): TopDomain[] {
  const list = requireArray(requireObj(raw, 'top_domains').domains, 'top_domains.domains')
  const out: TopDomain[] = []
  for (const item of list) {
    if (!isObj(item)) continue
    const domain = str(item.domain)
    if (!domain) continue
    out.push({ domain, count: num(item.count) })
  }
  return out.sort((a, b) => b.count - a.count)
}

export function normalizeTopClients(raw: unknown): TopClient[] {
  const list = requireArray(requireObj(raw, 'top_clients').clients, 'top_clients.clients')
  const out: TopClient[] = []
  for (const item of list) {
    if (!isObj(item)) continue
    const ip = str(item.ip)
    const name = str(item.name) || ip
    if (!name) continue
    out.push({ name, ip, count: num(item.count) })
  }
  return out.sort((a, b) => b.count - a.count)
}

export function normalizeClientHistory(raw: unknown): ClientHistory {
  const root = requireObj(raw, 'history/clients')
  const rawHistory = requireArray(root.history, 'history/clients.history')
  const rawClients = isObj(root.clients) ? root.clients : {}

  const allBuckets: { timestamp: number; data: Obj }[] = []
  for (const item of rawHistory) {
    if (!isObj(item) || typeof item.timestamp !== 'number') continue
    allBuckets.push({ timestamp: item.timestamp, data: isObj(item.data) ? item.data : {} })
  }
  allBuckets.sort((a, b) => a.timestamp - b.timestamp)
  const buckets = allBuckets.slice(-MAX_HISTORY_POINTS)

  // Rank by the reported total, falling back to the sum over the history.
  const sums = new Map<string, number>()
  for (const bucket of buckets) {
    for (const [ip, count] of Object.entries(bucket.data)) {
      sums.set(ip, (sums.get(ip) ?? 0) + num(count))
    }
  }
  const ips = new Set<string>([...Object.keys(rawClients), ...sums.keys()])
  const ranked = [...ips]
    .map((ip) => {
      const info = rawClients[ip]
      const meta = isObj(info) ? info : {}
      const total = typeof meta.total === 'number' ? num(meta.total) : (sums.get(ip) ?? 0)
      return { ip, name: str(meta.name) || ip, total }
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, MAX_HISTORY_CLIENTS)

  return {
    clients: ranked.map(({ name, ip }) => ({ name, ip })),
    points: buckets.map((bucket) => ({
      timestamp: bucket.timestamp,
      counts: ranked.map(({ ip }) => num(bucket.data[ip]))
    }))
  }
}

/** Pick a display version out of GET /api/info/version. */
export function normalizeVersion(raw: unknown): string | null {
  if (!isObj(raw)) return null
  const version = raw.version
  if (typeof version === 'string') return version.trim() || null
  if (!isObj(version)) return null
  for (const component of ['core', 'ftl', 'web']) {
    const entry = version[component]
    if (!isObj(entry)) continue
    const local = isObj(entry.local) ? entry.local : entry
    const value = str(local.version)
    if (value) return value
  }
  return null
}
