// A mock Pi-hole v6 HTTP API for tests and UI demos.
// Runs under plain `node` (type stripping): erasable syntax and node: built-ins only.
import http from 'node:http'
import https from 'node:https'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'

export type MockMode =
  /** Behave like a Pi-hole v6. */
  | 'pihole'
  /** Some other web server: every path is an HTML 404. */
  | 'not-found'
  /** Some other web server: every path is an HTML 200 page. */
  | 'html'
  /** Login works, data endpoints return broken JSON. */
  | 'bad-json'
  /** Login works, data endpoints return JSON of the wrong shape. */
  | 'wrong-shape'

export interface MockKnobs {
  mode: MockMode
  /** Answer every login attempt with 429. */
  rateLimitLogins: boolean
  /** Require a TOTP code on login (2FA enabled). */
  totpRequired: boolean
  /** Make GET /api/dns/blocking fail with a 500. */
  failBlocking: boolean
  /** Make GET /api/info/version fail with a 500. */
  failVersion: boolean
  /** Session seats; logins beyond this get 429 like the real thing. */
  maxSessions: number
  /** Artificial delay before answering a login, in ms. */
  loginDelayMs: number
  /** Artificial delay before answering (and auth-checking) a data request, in ms. */
  dataDelayMs: number
  /** Pad every data response with this many extra bytes. */
  padDataBytes: number
  /** DNS blocking state reported by /api/dns/blocking. */
  blocking: 'enabled' | 'disabled'
}

export interface MockStats {
  /** Successful logins (sessions created). */
  logins: number
  /** All POST /api/auth attempts. */
  loginAttempts: number
  /** Sessions ended via DELETE /api/auth. */
  logouts: number
  /** Authenticated requests rejected with 401. */
  unauthorized: number
  /** "METHOD /path?query" of every request, in order. */
  requests: string[]
}

export interface MockPiholeOptions {
  /** 0 or omitted = ephemeral port. */
  port?: number
  host?: string
  /** Empty string or omitted = Pi-hole without a password. */
  password?: string
  /** Serve HTTPS with this key/cert (PEM). */
  tls?: { key: string; cert: string }
  knobs?: Partial<MockKnobs>
}

export interface MockPihole {
  url: string
  port: number
  password: string
  knobs: MockKnobs
  stats: MockStats
  /** Number of currently valid sessions. */
  activeSessions(): number
  /** Invalidate all sessions, as if they had timed out. */
  expireSessions(): void
  resetStats(): void
  close(): Promise<void>
}

// ---------- fake data ----------

const BUCKET_SECONDS = 600
const BUCKET_COUNT = 144

interface FakeClient {
  ip: string
  name: string
  /** Typical queries per 10 minutes at peak. */
  weight: number
  blockRate: number
  /** 0 = follows the household's day, 1 = constant chatter (IoT). */
  flatness: number
}

const CLIENTS: FakeClient[] = [
  { ip: '192.168.1.42', name: 'living-room-tv.lan', weight: 95, blockRate: 0.46, flatness: 0.3 },
  { ip: '192.168.1.20', name: 'hunters-desktop.lan', weight: 80, blockRate: 0.14, flatness: 0.1 },
  { ip: '192.168.1.23', name: 'pixel-9.lan', weight: 62, blockRate: 0.27, flatness: 0.2 },
  { ip: '192.168.1.31', name: 'work-laptop.lan', weight: 55, blockRate: 0.09, flatness: 0.05 },
  { ip: '192.168.1.24', name: 'ipad.lan', weight: 41, blockRate: 0.22, flatness: 0.15 },
  { ip: '192.168.1.57', name: '', weight: 36, blockRate: 0.61, flatness: 0.9 },
  { ip: '192.168.1.60', name: 'echo-kitchen.lan', weight: 28, blockRate: 0.33, flatness: 0.8 },
  { ip: '192.168.1.11', name: 'nas.lan', weight: 22, blockRate: 0.03, flatness: 1 },
  { ip: '192.168.1.45', name: 'xbox.lan', weight: 19, blockRate: 0.18, flatness: 0.1 },
  { ip: '192.168.1.71', name: 'thermostat.lan', weight: 12, blockRate: 0.05, flatness: 1 },
  { ip: '192.168.1.66', name: 'printer.lan', weight: 7, blockRate: 0.4, flatness: 1 },
  { ip: '127.0.0.1', name: 'localhost', weight: 5, blockRate: 0, flatness: 1 }
]

/** Share of all blocked queries per domain (sums to < 1; the rest is long tail). */
const BLOCKED_DOMAINS: [string, number][] = [
  ['doubleclick.net', 0.118],
  ['googleads.g.doubleclick.net', 0.094],
  ['graph.facebook.com', 0.081],
  ['app-measurement.com', 0.066],
  ['samsungads.com', 0.058],
  ['ads.roku.com', 0.049],
  ['device-metrics-us.amazon.com', 0.043],
  ['googlesyndication.com', 0.038],
  ['scorecardresearch.com', 0.031],
  ['mobile.pipe.aria.microsoft.com', 0.027],
  ['adservice.google.com', 0.024],
  ['analytics.tiktok.com', 0.021],
  ['logs.netflix.com', 0.018],
  ['telemetry.sonos.com', 0.014],
  ['amazon-adsystem.com', 0.011]
]

const PERMITTED_DOMAINS: [string, number][] = [
  ['www.google.com', 0.09],
  ['api.github.com', 0.06],
  ['clients4.google.com', 0.05],
  ['outlook.office365.com', 0.04],
  ['time.cloudflare.com', 0.035],
  ['i.ytimg.com', 0.03],
  ['api.spotify.com', 0.027],
  ['connectivitycheck.gstatic.com', 0.024],
  ['www.reddit.com', 0.02],
  ['pool.ntp.org', 0.015]
]

/** Deterministic pseudo-random number in [0, 1) from three integers. */
function rand(a: number, b: number, c: number): number {
  let h = (a ^ Math.imul(b + 1, 0x9e3779b1) ^ Math.imul(c + 1, 0x85ebca6b)) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad)
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97)
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296
}

/** Household activity level in [0, 1] for a unix timestamp. */
function activity(timestamp: number): number {
  const date = new Date(timestamp * 1000)
  const hour = date.getHours() + date.getMinutes() / 60
  const bump = (centre: number, width: number): number =>
    Math.exp(-((hour - centre) ** 2) / (2 * width * width))
  return Math.min(1, 0.08 + 0.55 * bump(8.5, 1.5) + 0.5 * bump(13, 2) + 0.95 * bump(20, 2.2))
}

interface Snapshot {
  timestamps: number[]
  /** perClient[c][b] */
  total: number[][]
  blocked: number[][]
  clientTotals: number[]
  clientBlocked: number[]
  sumTotal: number
  sumBlocked: number
}

function snapshot(nowMs: number): Snapshot {
  const now = Math.floor(nowMs / 1000)
  const last = Math.floor(now / BUCKET_SECONDS) * BUCKET_SECONDS
  const timestamps: number[] = []
  for (let i = BUCKET_COUNT - 1; i >= 0; i--) timestamps.push(last - i * BUCKET_SECONDS)
  // The newest bucket is still filling up.
  const partial = Math.max(0.02, (now - last) / BUCKET_SECONDS)

  const total: number[][] = []
  const blocked: number[][] = []
  const clientTotals: number[] = []
  const clientBlocked: number[] = []
  let sumTotal = 0
  let sumBlocked = 0
  CLIENTS.forEach((client, c) => {
    const totals: number[] = []
    const blocks: number[] = []
    timestamps.forEach((ts, b) => {
      const level = client.flatness + (1 - client.flatness) * activity(ts)
      const burst = rand(ts, c, 3) > 0.93 ? 1.8 : 1
      const scale = b === timestamps.length - 1 ? partial : 1
      const count = Math.round(
        client.weight * level * (0.55 + 0.9 * rand(ts, c, 1)) * burst * scale
      )
      const block = Math.min(
        count,
        Math.round(count * client.blockRate * (0.6 + 0.8 * rand(ts, c, 2)))
      )
      totals.push(count)
      blocks.push(block)
    })
    const t = totals.reduce((a, n) => a + n, 0)
    const k = blocks.reduce((a, n) => a + n, 0)
    total.push(totals)
    blocked.push(blocks)
    clientTotals.push(t)
    clientBlocked.push(k)
    sumTotal += t
    sumBlocked += k
  })
  return { timestamps, total, blocked, clientTotals, clientBlocked, sumTotal, sumBlocked }
}

function intParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name)
  if (raw === null) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function dataResponse(url: URL, knobs: MockKnobs): { status: number; body: unknown } | null {
  const snap = snapshot(Date.now())
  const path = url.pathname.replace(/\/+$/, '')
  switch (path) {
    case '/api/stats/summary': {
      const cached = Math.round((snap.sumTotal - snap.sumBlocked) * 0.37)
      const forwarded = snap.sumTotal - snap.sumBlocked - cached
      return {
        status: 200,
        body: {
          queries: {
            total: snap.sumTotal,
            blocked: snap.sumBlocked,
            percent_blocked: snap.sumTotal ? (snap.sumBlocked / snap.sumTotal) * 100 : 0,
            unique_domains: 1840 + Math.round(snap.sumTotal / 90),
            forwarded,
            cached,
            frequency: snap.sumTotal / 86400,
            types: { A: Math.round(snap.sumTotal * 0.62), AAAA: Math.round(snap.sumTotal * 0.29) },
            status: { GRAVITY: snap.sumBlocked, FORWARDED: forwarded, CACHE: cached },
            replies: { IP: Math.round(snap.sumTotal * 0.71), NODATA: Math.round(snap.sumTotal * 0.1) }
          },
          clients: {
            active: snap.clientTotals.filter((n) => n > 0).length,
            total: CLIENTS.length + 3
          },
          gravity: {
            domains_being_blocked: 1_284_317,
            last_update: Math.floor(Date.now() / 1000) - 3 * 86400
          },
          took: 0.0003
        }
      }
    }
    case '/api/history': {
      return {
        status: 200,
        body: {
          history: snap.timestamps.map((timestamp, b) => {
            let total = 0
            let blocked = 0
            for (let c = 0; c < CLIENTS.length; c++) {
              total += snap.total[c][b]
              blocked += snap.blocked[c][b]
            }
            const cached = Math.round((total - blocked) * (0.3 + 0.15 * rand(timestamp, 99, 4)))
            return { timestamp, total, cached, blocked, forwarded: total - blocked - cached }
          }),
          took: 0.0004
        }
      }
    }
    case '/api/history/clients': {
      const limit = intParam(url, 'N', 20)
      const order = CLIENTS.map((_, c) => c).sort(
        (a, b) => snap.clientTotals[b] - snap.clientTotals[a]
      )
      const chosen = limit === 0 ? order : order.slice(0, limit)
      const clients: Record<string, { name: string | null; total: number }> = {}
      for (const c of chosen) {
        clients[CLIENTS[c].ip] = { name: CLIENTS[c].name || null, total: snap.clientTotals[c] }
      }
      return {
        status: 200,
        body: {
          clients,
          history: snap.timestamps.map((timestamp, b) => {
            // Like the real API, idle clients are left out of a bucket.
            const data: Record<string, number> = {}
            for (const c of chosen) {
              if (snap.total[c][b] > 0) data[CLIENTS[c].ip] = snap.total[c][b]
            }
            return { timestamp, data }
          }),
          took: 0.0006
        }
      }
    }
    case '/api/stats/top_domains': {
      const blockedOnly = url.searchParams.get('blocked') === 'true'
      const count = intParam(url, 'count', 10)
      const base = blockedOnly ? snap.sumBlocked : snap.sumTotal - snap.sumBlocked
      const domains = (blockedOnly ? BLOCKED_DOMAINS : PERMITTED_DOMAINS)
        .map(([domain, share]) => ({ domain, count: Math.round(base * share) }))
        .sort((a, b) => b.count - a.count)
        .slice(0, count)
      return {
        status: 200,
        body: {
          domains,
          total_queries: snap.sumTotal,
          blocked_queries: snap.sumBlocked,
          took: 0.0005
        }
      }
    }
    case '/api/stats/top_clients': {
      const blockedOnly = url.searchParams.get('blocked') === 'true'
      const count = intParam(url, 'count', 10)
      const source = blockedOnly ? snap.clientBlocked : snap.clientTotals
      const clients = CLIENTS.map((client, c) => ({
        ip: client.ip,
        name: client.name,
        count: source[c]
      }))
        .filter((entry) => entry.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, count)
      return {
        status: 200,
        body: {
          clients,
          total_queries: snap.sumTotal,
          blocked_queries: snap.sumBlocked,
          took: 0.0005
        }
      }
    }
    case '/api/dns/blocking': {
      if (knobs.failBlocking) return { status: 500, body: errorBody('internal_error', 'Mock failure') }
      return { status: 200, body: { blocking: knobs.blocking, timer: null, took: 0.0001 } }
    }
    case '/api/info/version': {
      if (knobs.failVersion) return { status: 500, body: errorBody('internal_error', 'Mock failure') }
      const component = (version: string, hash: string): unknown => ({
        local: { branch: 'master', version, hash },
        remote: { version, hash }
      })
      return {
        status: 200,
        body: {
          version: {
            core: component('v6.1.4', 'a1b2c3d4'),
            web: component('v6.2.1', 'b2c3d4e5'),
            ftl: { ...(component('v6.2.3', 'c3d4e5f6') as object), date: '2026-06-12 10:11:12 +0100' },
            docker: { local: null, remote: null }
          },
          took: 0.0002
        }
      }
    }
    default:
      return null
  }
}

function errorBody(key: string, message: string, hint: string | null = null): unknown {
  return { error: { key, message, hint }, took: 0.0001 }
}

// ---------- server ----------

const HTML_PAGE = '<!DOCTYPE html><html><head><title>Router</title></head><body>Welcome</body></html>'

export function startMockPihole(options: MockPiholeOptions = {}): Promise<MockPihole> {
  const password = options.password ?? ''
  const knobs: MockKnobs = {
    mode: 'pihole',
    rateLimitLogins: false,
    totpRequired: false,
    failBlocking: false,
    failVersion: false,
    maxSessions: 16,
    loginDelayMs: 0,
    dataDelayMs: 0,
    padDataBytes: 0,
    blocking: 'enabled',
    ...options.knobs
  }
  const stats: MockStats = { logins: 0, loginAttempts: 0, logouts: 0, unauthorized: 0, requests: [] }
  const sessions = new Map<string, { csrf: string }>()

  const sendJson = (res: http.ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text)
    })
    res.end(text)
  }
  const sendText = (res: http.ServerResponse, status: number, type: string, text: string): void => {
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(text) })
    res.end(text)
  }
  const sessionBody = (valid: boolean, sid: string | null, message: string): unknown => ({
    session: {
      valid,
      totp: knobs.totpRequired,
      sid,
      csrf: sid ? (sessions.get(sid)?.csrf ?? null) : null,
      validity: valid && sid ? 1800 : -1,
      message
    },
    took: 0.0002
  })
  const sidOf = (req: http.IncomingMessage, url: URL): string | null => {
    const header = req.headers['x-ftl-sid']
    if (typeof header === 'string' && header) return header
    return url.searchParams.get('sid')
  }
  const isAuthed = (req: http.IncomingMessage, url: URL): boolean => {
    if (password === '') return true
    const sid = sidOf(req, url)
    return sid !== null && sessions.has(sid)
  }

  const handleLogin = (res: http.ServerResponse, rawBody: string): void => {
    stats.loginAttempts++
    if (knobs.rateLimitLogins) {
      sendJson(res, 429, errorBody('rate_limiting', 'Rate-limiting login attempts'))
      return
    }
    let payload: unknown
    try {
      payload = JSON.parse(rawBody)
    } catch {
      sendJson(res, 400, errorBody('bad_request', 'Invalid request body data (no valid JSON)'))
      return
    }
    const fields = (typeof payload === 'object' && payload !== null ? payload : {}) as {
      password?: unknown
      totp?: unknown
    }
    if (typeof fields.password !== 'string') {
      sendJson(res, 400, errorBody('bad_request', 'No password found in JSON payload'))
      return
    }
    if (password === '') {
      sendJson(res, 200, sessionBody(true, null, 'no password set'))
      return
    }
    if (fields.password !== password) {
      sendJson(res, 401, sessionBody(false, null, 'password incorrect'))
      return
    }
    if (knobs.totpRequired && typeof fields.totp !== 'number') {
      sendJson(res, 400, errorBody('bad_request', 'No 2FA token found in JSON payload'))
      return
    }
    if (sessions.size >= knobs.maxSessions) {
      sendJson(
        res,
        429,
        errorBody('api_seats_exceeded', 'API seats exceeded', 'increase webserver.api.max_sessions')
      )
      return
    }
    const sid = randomBytes(24).toString('base64')
    sessions.set(sid, { csrf: randomBytes(24).toString('base64') })
    stats.logins++
    sendJson(res, 200, sessionBody(true, sid, 'password correct'))
  }

  const handle = (req: http.IncomingMessage, res: http.ServerResponse, rawBody: string): void => {
    const url = new URL(req.url ?? '/', 'http://mock.invalid')
    const method = req.method ?? 'GET'
    stats.requests.push(`${method} ${url.pathname}${url.search}`)

    if (knobs.mode === 'not-found') {
      sendText(res, 404, 'text/html', '<html><body><h1>404 Not Found</h1></body></html>')
      return
    }
    if (knobs.mode === 'html') {
      sendText(res, 200, 'text/html', HTML_PAGE)
      return
    }

    const path = url.pathname.replace(/\/+$/, '')
    if (!path.startsWith('/api')) {
      sendText(res, path === '' || path.startsWith('/admin') ? 200 : 404, 'text/html', HTML_PAGE)
      return
    }

    if (path === '/api/auth') {
      if (method === 'POST') {
        if (knobs.loginDelayMs > 0) {
          setTimeout(() => handleLogin(res, rawBody), knobs.loginDelayMs)
        } else {
          handleLogin(res, rawBody)
        }
        return
      }
      if (method === 'GET') {
        if (password === '') {
          sendJson(res, 200, sessionBody(true, null, 'no password set'))
          return
        }
        const sid = sidOf(req, url)
        if (sid !== null && sessions.has(sid)) {
          sendJson(res, 200, sessionBody(true, sid, 'sid valid'))
        } else {
          sendJson(res, 401, sessionBody(false, null, 'no SID provided'))
        }
        return
      }
      if (method === 'DELETE') {
        const sid = sidOf(req, url)
        if (password !== '' && (sid === null || !sessions.has(sid))) {
          stats.unauthorized++
          sendJson(res, 401, errorBody('unauthorized', 'Unauthorized'))
          return
        }
        if (sid !== null && sessions.delete(sid)) stats.logouts++
        res.writeHead(204)
        res.end()
        return
      }
      sendJson(res, 405, errorBody('bad_request', 'Method not allowed'))
      return
    }

    if (knobs.dataDelayMs > 0) {
      setTimeout(() => handleData(req, res, url, method), knobs.dataDelayMs)
    } else {
      handleData(req, res, url, method)
    }
  }

  const handleData = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    method: string
  ): void => {
    if (!isAuthed(req, url)) {
      stats.unauthorized++
      sendJson(res, 401, errorBody('unauthorized', 'Unauthorized'))
      return
    }
    if (method !== 'GET') {
      sendJson(res, 405, errorBody('bad_request', 'Method not allowed'))
      return
    }
    if (knobs.mode === 'bad-json') {
      sendText(res, 200, 'application/json', '{"queries": {"total": 12')
      return
    }
    if (knobs.mode === 'wrong-shape') {
      sendJson(res, 200, { status: 'ok', data: [1, 2, 3] })
      return
    }
    const result = dataResponse(url, knobs)
    if (!result) {
      sendJson(res, 404, errorBody('not_found', 'Not found', url.pathname))
      return
    }
    if (knobs.padDataBytes > 0 && typeof result.body === 'object' && result.body !== null) {
      sendJson(res, result.status, { ...result.body, padding: 'x'.repeat(knobs.padDataBytes) })
      return
    }
    sendJson(res, result.status, result.body)
  }

  const listener = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      try {
        handle(req, res, Buffer.concat(chunks).toString('utf8'))
      } catch {
        if (!res.headersSent) sendJson(res, 500, errorBody('internal_error', 'Mock server error'))
        else res.end()
      }
    })
  }

  const server = options.tls
    ? https.createServer({ key: options.tls.key, cert: options.tls.cert }, listener)
    : http.createServer(listener)
  const host = options.host ?? '127.0.0.1'

  return new Promise<MockPihole>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject)
      const port = (server.address() as AddressInfo).port
      resolve({
        url: `${options.tls ? 'https' : 'http'}://${host}:${port}`,
        port,
        password,
        knobs,
        stats,
        activeSessions: () => sessions.size,
        expireSessions: () => sessions.clear(),
        resetStats: () => {
          stats.logins = 0
          stats.loginAttempts = 0
          stats.logouts = 0
          stats.unauthorized = 0
          stats.requests.length = 0
        },
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done())
            server.closeAllConnections()
          })
      })
    })
  })
}
