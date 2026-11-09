// Pi-hole v6 REST API client (main process). Uses only Node built-ins.
import type {
  AppErrorCode,
  ConnectionInfo,
  DashboardData,
  PiholeClientApi,
  PiholeConnection
} from '@shared/contract'
import { httpRequest, type HttpResponse } from './http'
import {
  MAX_HISTORY_CLIENTS,
  ShapeError,
  normalizeBlocking,
  normalizeClientHistory,
  normalizeHistory,
  normalizeSummary,
  normalizeTopClients,
  normalizeTopDomains,
  normalizeVersion
} from './normalize'

export class PiholeError extends Error {
  readonly code: AppErrorCode
  constructor(code: AppErrorCode, message: string) {
    super(message)
    this.name = 'PiholeError'
    this.code = code
  }
}

const REQUEST_TIMEOUT_MS = 10_000
const TOP_COUNT = 10

const NOT_V6_MESSAGE =
  'This address did not answer like a Pi-hole v6 API. Check the address, and note that Pi-hole v6 or newer is required.'

/** An authenticated session. `sid` is null when the Pi-hole has no password. */
interface Session {
  sid: string | null
}

const TLS_CERT_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'CERT_SIGNATURE_FAILURE',
  'CERT_CHAIN_TOO_LONG',
  'INVALID_CA',
  'INVALID_PURPOSE',
  'HOSTNAME_MISMATCH',
  'ERR_TLS_CERT_ALTNAME_INVALID'
])

function errorCode(err: unknown): string {
  if (typeof err !== 'object' || err === null) return ''
  const e = err as { code?: unknown; errors?: unknown }
  if (typeof e.code === 'string' && e.code) return e.code
  // AggregateError from dual-stack connection attempts.
  if (Array.isArray(e.errors)) {
    for (const inner of e.errors) {
      const code = errorCode(inner)
      if (code) return code
    }
  }
  return ''
}

function mapTransportError(err: unknown): PiholeError {
  const code = errorCode(err)
  if (TLS_CERT_CODES.has(code)) {
    return new PiholeError(
      'tls',
      'The Pi-hole\'s HTTPS certificate could not be verified. If it uses a self-signed certificate, enable "Allow self-signed certificates".'
    )
  }
  if (code.startsWith('ERR_SSL') || code.startsWith('ERR_TLS') || code === 'EPROTO') {
    return new PiholeError(
      'tls',
      'A secure (HTTPS) connection could not be established. If the Pi-hole only serves plain HTTP on this port, use http:// instead.'
    )
  }
  switch (code) {
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
      return new PiholeError(
        'unreachable',
        'The Pi-hole did not respond in time. Check the address and that the device is on.'
      )
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'EAI_FAIL':
      return new PiholeError('unreachable', 'The Pi-hole host name could not be found.')
    case 'ECONNREFUSED':
      return new PiholeError(
        'unreachable',
        'The connection was refused. Check the address and port of the Pi-hole.'
      )
    case 'ECONNRESET':
    case 'ECONNABORTED':
    case 'EPIPE':
    case 'EHOSTUNREACH':
    case 'EHOSTDOWN':
    case 'ENETUNREACH':
    case 'ENETDOWN':
    case 'EADDRNOTAVAIL':
      return new PiholeError('unreachable', 'The Pi-hole could not be reached over the network.')
    case 'HPE_INVALID_CONSTANT':
    case 'HPE_INVALID_VERSION':
    case 'HPE_INVALID_HEADER_TOKEN':
      return new PiholeError('bad_response', NOT_V6_MESSAGE)
    default:
      return new PiholeError('unknown', 'An unexpected error occurred while contacting the Pi-hole.')
  }
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown
  } catch {
    return undefined
  }
}

/**
 * Turn the configured base URL into the API root (no trailing slash).
 * Accepts a trailing slash and a trailing "/admin" (the web UI address).
 */
function resolveApiRoot(baseUrl: string): string {
  let url: URL
  try {
    url = new URL(baseUrl.trim())
  } catch {
    throw new PiholeError(
      'invalid_url',
      'The Pi-hole address is not a valid URL. Use something like http://pi.hole or https://192.168.1.2.'
    )
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
    throw new PiholeError('invalid_url', 'The Pi-hole address must start with http:// or https://.')
  }
  let path = url.pathname.replace(/\/+$/, '')
  path = path.replace(/\/admin(\/(login|index)(\.\w+)?)?$/i, '')
  path = path.replace(/\/api$/i, '').replace(/\/+$/, '')
  return `${url.protocol}//${url.host}${path}/api`
}

export class PiholeClient implements PiholeClientApi {
  readonly connection: PiholeConnection
  private session: Session | null = null
  private loginInFlight: Promise<Session> | null = null

  constructor(connection: PiholeConnection) {
    this.connection = connection
  }

  async testConnection(): Promise<ConnectionInfo> {
    await this.ensureSession()
    try {
      return { version: normalizeVersion(await this.get('/info/version')) }
    } catch (err) {
      if (err instanceof PiholeError && (err.code === 'bad_response' || err.code === 'unknown')) {
        return { version: null }
      }
      throw err
    }
  }

  async fetchDashboard(): Promise<DashboardData> {
    // Log in before fanning out so the parallel requests share one session.
    await this.ensureSession()
    const blockedTop = `blocked=true&count=${TOP_COUNT}`
    const [summary, history, clientHistory, topDomains, topBlocked, topTotal, blocking] =
      await Promise.all([
        this.get('/stats/summary'),
        this.get('/history'),
        this.get(`/history/clients?N=${MAX_HISTORY_CLIENTS}`),
        this.get(`/stats/top_domains?${blockedTop}`),
        this.get(`/stats/top_clients?${blockedTop}`),
        this.get(`/stats/top_clients?count=${TOP_COUNT}`),
        this.get('/dns/blocking').catch(() => null)
      ])
    try {
      return {
        summary: normalizeSummary(summary, normalizeBlocking(blocking)),
        history: normalizeHistory(history),
        topBlockedDomains: normalizeTopDomains(topDomains).slice(0, TOP_COUNT),
        topClientsBlocked: normalizeTopClients(topBlocked).slice(0, TOP_COUNT),
        topClientsTotal: normalizeTopClients(topTotal).slice(0, TOP_COUNT),
        clientHistory: normalizeClientHistory(clientHistory),
        fetchedAt: Date.now()
      }
    } catch (err) {
      if (err instanceof ShapeError) {
        throw new PiholeError(
          'bad_response',
          'The Pi-hole returned data in an unexpected format. Pi-hole v6 or newer is required.'
        )
      }
      throw err
    }
  }

  async logout(): Promise<void> {
    try {
      const pending = this.loginInFlight
      let session = this.session
      this.session = null
      if (pending) {
        session = await pending.catch(() => null)
        if (this.session === session) this.session = null
      }
      if (!session?.sid) return
      await this.send('DELETE', '/auth', { sid: session.sid })
    } catch {
      // Logging out is best effort; the session expires on its own otherwise.
    }
  }

  // ---------- session ----------

  private ensureSession(): Promise<Session> {
    if (this.session) return Promise.resolve(this.session)
    if (!this.loginInFlight) {
      const attempt = this.login()
        .then((session) => {
          this.session = session
          return session
        })
        .finally(() => {
          if (this.loginInFlight === attempt) this.loginInFlight = null
        })
      this.loginInFlight = attempt
    }
    return this.loginInFlight
  }

  private async login(): Promise<Session> {
    const password = this.connection.password
    const res =
      password === ''
        ? await this.send('GET', '/auth', {})
        : await this.send('POST', '/auth', { body: JSON.stringify({ password }) })
    const json = parseJson(res.body)
    const session = isObj(json) && isObj(json.session) ? json.session : null
    const apiError = isObj(json) && isObj(json.error) ? json.error : null

    if (res.status === 429) throw rateLimited()
    if (res.status === 404) throw new PiholeError('bad_response', NOT_V6_MESSAGE)

    if (res.status >= 200 && res.status < 300) {
      if (!session) throw new PiholeError('bad_response', NOT_V6_MESSAGE)
      if (session.valid === true) {
        const sid = typeof session.sid === 'string' && session.sid ? session.sid : null
        return { sid }
      }
      if (session.totp === true) throw totpRequired()
      throw authFailed(password === '')
    }

    if (res.status === 401) {
      // Only trust a 401 as "wrong password" when it looks like Pi-hole.
      if (!session && !apiError) throw new PiholeError('bad_response', NOT_V6_MESSAGE)
      throw authFailed(password === '')
    }

    if (res.status === 400 && apiError) {
      const text = `${String(apiError.key ?? '')} ${String(apiError.message ?? '')}`
      if (/totp|2fa/i.test(text)) throw totpRequired()
    }

    if (!session && !apiError) throw new PiholeError('bad_response', NOT_V6_MESSAGE)
    throw new PiholeError(
      'bad_response',
      `The Pi-hole rejected the login request (HTTP ${res.status}).`
    )
  }

  // ---------- requests ----------

  /** Authenticated GET returning parsed JSON; re-logs in once on a 401. */
  private async get(path: string): Promise<unknown> {
    let session = await this.ensureSession()
    let res = await this.send('GET', path, { sid: session.sid })
    if (res.status === 401) {
      // Session expired or was revoked. Drop it (unless a concurrent caller
      // already replaced it) and retry once with a fresh login.
      if (this.session === session) this.session = null
      session = await this.ensureSession()
      res = await this.send('GET', path, { sid: session.sid })
      if (res.status === 401) {
        if (this.session === session) this.session = null
        throw new PiholeError(
          'auth_failed',
          'The Pi-hole keeps rejecting the session. Check the password and try again.'
        )
      }
    }
    if (res.status === 429) throw rateLimited()
    if (res.status < 200 || res.status >= 300) {
      throw new PiholeError(
        'bad_response',
        `The Pi-hole answered with an unexpected status (HTTP ${res.status}). Pi-hole v6 or newer is required.`
      )
    }
    const json = parseJson(res.body)
    if (!isObj(json)) {
      throw new PiholeError(
        'bad_response',
        'The Pi-hole returned a response that is not valid JSON. Pi-hole v6 or newer is required.'
      )
    }
    return json
  }

  private async send(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    extra: { sid?: string | null; body?: string }
  ): Promise<HttpResponse> {
    const root = resolveApiRoot(this.connection.baseUrl)
    const headers: Record<string, string> = {}
    if (extra.sid) headers['X-FTL-SID'] = extra.sid
    try {
      return await httpRequest({
        url: new URL(root + path),
        method,
        headers,
        body: extra.body,
        timeoutMs: REQUEST_TIMEOUT_MS,
        allowSelfSigned: this.connection.allowSelfSigned
      })
    } catch (err) {
      throw mapTransportError(err)
    }
  }
}

function rateLimited(): PiholeError {
  return new PiholeError(
    'rate_limited',
    'The Pi-hole is refusing logins right now: too many attempts, or all of its API session seats are in use. Wait a moment and try again.'
  )
}

function totpRequired(): PiholeError {
  return new PiholeError(
    'totp_required',
    'This Pi-hole has two-factor authentication enabled. Create an app password in the Pi-hole web interface and use that instead.'
  )
}

function authFailed(noPasswordSent: boolean): PiholeError {
  return new PiholeError(
    'auth_failed',
    noPasswordSent
      ? 'This Pi-hole requires a password. Enter it in the settings.'
      : 'The Pi-hole rejected the password.'
  )
}
