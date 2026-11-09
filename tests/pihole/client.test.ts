import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppErrorCode } from '@shared/contract'
import { PiholeClient, PiholeError } from '../../src/main/pihole/client'
import {
  startMockPihole,
  type MockPihole,
  type MockPiholeOptions
} from '../mock-pihole/server.ts'

const PASSWORD = 'correct horse battery staple'

const mocks: MockPihole[] = []

async function mockPihole(options: MockPiholeOptions = {}): Promise<MockPihole> {
  const mock = await startMockPihole({ password: PASSWORD, ...options })
  mocks.push(mock)
  return mock
}

function clientFor(mock: MockPihole, overrides: Partial<PiholeClient['connection']> = {}): PiholeClient {
  return new PiholeClient({
    baseUrl: mock.url,
    password: mock.password,
    allowSelfSigned: false,
    ...overrides
  })
}

async function failure(promise: Promise<unknown>): Promise<PiholeError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(PiholeError)
    return err as PiholeError
  }
  throw new Error('Expected the call to reject')
}

async function expectCode(promise: Promise<unknown>, code: AppErrorCode): Promise<PiholeError> {
  const err = await failure(promise)
  expect(err.code).toBe(code)
  expect(err.message.length).toBeGreaterThan(10)
  return err
}

function loginRequests(mock: MockPihole): number {
  return mock.stats.requests.filter((r) => r === 'POST /api/auth').length
}

afterEach(async () => {
  await Promise.all(mocks.splice(0).map((mock) => mock.close()))
})

describe('fetchDashboard', () => {
  it('normalises the Pi-hole payloads into DashboardData', async () => {
    const mock = await mockPihole()
    const before = Date.now()
    const data = await clientFor(mock).fetchDashboard()

    expect(data.fetchedAt).toBeGreaterThanOrEqual(before)

    const { summary } = data
    expect(summary.totalQueries).toBeGreaterThan(1000)
    expect(summary.blockedQueries).toBeGreaterThan(0)
    expect(summary.blockedQueries).toBeLessThan(summary.totalQueries)
    expect(summary.percentBlocked).toBeCloseTo(
      (summary.blockedQueries / summary.totalQueries) * 100,
      5
    )
    expect(summary.domainsOnBlocklists).toBe(1_284_317)
    expect(summary.activeClients).toBe(12)
    expect(summary.blockingEnabled).toBe(true)

    expect(data.history).toHaveLength(144)
    for (let i = 0; i < data.history.length; i++) {
      const point = data.history[i]
      expect(point.allowed).toBe(point.total - point.blocked)
      if (i > 0) expect(point.timestamp - data.history[i - 1].timestamp).toBe(600)
    }
    expect(data.history.reduce((sum, p) => sum + p.total, 0)).toBe(summary.totalQueries)

    expect(data.topBlockedDomains).toHaveLength(10)
    expect(data.topBlockedDomains[0].domain).toBe('doubleclick.net')
    for (let i = 1; i < data.topBlockedDomains.length; i++) {
      expect(data.topBlockedDomains[i].count).toBeLessThanOrEqual(
        data.topBlockedDomains[i - 1].count
      )
    }

    expect(data.topClientsTotal).toHaveLength(10)
    expect(data.topClientsBlocked.length).toBeGreaterThan(0)
    expect(data.topClientsBlocked.length).toBeLessThanOrEqual(10)
    expect(data.topClientsTotal[0].count).toBeGreaterThan(data.topClientsBlocked[0].count)
    // The client without a hostname falls back to its IP.
    const unnamed = data.topClientsTotal.find((c) => c.ip === '192.168.1.57')
    expect(unnamed?.name).toBe('192.168.1.57')
    expect(data.topClientsTotal.find((c) => c.ip === '192.168.1.20')?.name).toBe(
      'hunters-desktop.lan'
    )

    const { clientHistory } = data
    expect(clientHistory.clients).toHaveLength(10)
    expect(clientHistory.clients.map((c) => c.ip)).toEqual(data.topClientsTotal.map((c) => c.ip))
    expect(clientHistory.clients.find((c) => c.ip === '192.168.1.57')?.name).toBe('192.168.1.57')
    expect(clientHistory.points).toHaveLength(144)
    for (const point of clientHistory.points) {
      expect(point.counts).toHaveLength(10)
      for (const count of point.counts) expect(Number.isFinite(count)).toBe(true)
    }
    // Columns line up with the clients array: column sums equal each client's total.
    clientHistory.clients.forEach((client, column) => {
      const sum = clientHistory.points.reduce((acc, p) => acc + p.counts[column], 0)
      expect(sum).toBe(data.topClientsTotal.find((c) => c.ip === client.ip)?.count)
    })

    expect(mock.stats.requests).toContain('GET /api/stats/top_domains?blocked=true&count=10')
    expect(mock.stats.requests).toContain('GET /api/stats/top_clients?blocked=true&count=10')
    expect(mock.stats.requests).toContain('GET /api/stats/top_clients?count=10')
  })

  it('reports disabled blocking', async () => {
    const mock = await mockPihole({ knobs: { blocking: 'disabled' } })
    const data = await clientFor(mock).fetchDashboard()
    expect(data.summary.blockingEnabled).toBe(false)
  })

  it('yields blockingEnabled null when the blocking status call fails', async () => {
    const mock = await mockPihole({ knobs: { failBlocking: true } })
    const data = await clientFor(mock).fetchDashboard()
    expect(data.summary.blockingEnabled).toBeNull()
    expect(data.history).toHaveLength(144)
  })

  it('works against a Pi-hole without a password', async () => {
    const mock = await mockPihole({ password: '' })
    const client = clientFor(mock)
    const data = await client.fetchDashboard()
    expect(data.summary.totalQueries).toBeGreaterThan(0)
    expect(mock.stats.loginAttempts).toBe(0)
    expect(mock.stats.requests[0]).toBe('GET /api/auth')
    await expect(client.logout()).resolves.toBeUndefined()
    expect(mock.stats.requests.some((r) => r.startsWith('DELETE'))).toBe(false)
  })

  it('accepts a stored password when the Pi-hole has none', async () => {
    const mock = await mockPihole({ password: '' })
    const data = await clientFor(mock, { password: 'leftover' }).fetchDashboard()
    expect(data.history).toHaveLength(144)
  })
})

describe('session handling', () => {
  it('logs in once across sequential and concurrent fetches', async () => {
    const mock = await mockPihole({ knobs: { loginDelayMs: 40 } })
    const client = clientFor(mock)

    await Promise.all([client.fetchDashboard(), client.fetchDashboard(), client.testConnection()])
    await client.fetchDashboard()
    await client.fetchDashboard()
    await Promise.all([client.fetchDashboard(), client.fetchDashboard()])

    expect(loginRequests(mock)).toBe(1)
    expect(mock.stats.logins).toBe(1)
    expect(mock.activeSessions()).toBe(1)
    expect(mock.stats.unauthorized).toBe(0)
  })

  it('logs in again once when the session has expired', async () => {
    const mock = await mockPihole()
    const client = clientFor(mock)
    await client.fetchDashboard()
    expect(mock.stats.logins).toBe(1)

    mock.expireSessions()
    const data = await client.fetchDashboard()
    expect(data.history).toHaveLength(144)
    expect(mock.stats.logins).toBe(2)
    expect(mock.activeSessions()).toBe(1)

    await client.fetchDashboard()
    expect(mock.stats.logins).toBe(2)
  })

  it('shares one re-login between concurrent fetches after expiry', async () => {
    const mock = await mockPihole({ knobs: { loginDelayMs: 30 } })
    const client = clientFor(mock)
    await client.fetchDashboard()
    mock.expireSessions()
    await Promise.all([client.fetchDashboard(), client.fetchDashboard()])
    expect(mock.stats.logins).toBe(2)
    expect(mock.activeSessions()).toBe(1)
  })

  it('logout releases the session and never throws', async () => {
    const mock = await mockPihole()
    const client = clientFor(mock)

    await expect(client.logout()).resolves.toBeUndefined() // not logged in yet
    expect(mock.stats.requests).toHaveLength(0)

    await client.fetchDashboard()
    expect(mock.activeSessions()).toBe(1)
    await client.logout()
    expect(mock.activeSessions()).toBe(0)
    expect(mock.stats.logouts).toBe(1)

    await client.logout() // second call is a no-op
    expect(mock.stats.logouts).toBe(1)

    // The client is still usable and logs in afresh.
    await client.fetchDashboard()
    expect(mock.stats.logins).toBe(2)

    // Logout against a dead server still resolves.
    await mock.close()
    await expect(client.logout()).resolves.toBeUndefined()
  })

  it('logout with an already expired session does not throw', async () => {
    const mock = await mockPihole()
    const client = clientFor(mock)
    await client.fetchDashboard()
    mock.expireSessions()
    await expect(client.logout()).resolves.toBeUndefined()
  })
})

describe('testConnection', () => {
  it('authenticates and returns the version', async () => {
    const mock = await mockPihole()
    const info = await clientFor(mock).testConnection()
    expect(info).toEqual({ version: 'v6.1.4' })
    expect(mock.stats.logins).toBe(1)
  })

  it('returns a null version when it cannot be read', async () => {
    const mock = await mockPihole({ knobs: { failVersion: true } })
    expect(await clientFor(mock).testConnection()).toEqual({ version: null })
  })

  it('rejects a wrong password', async () => {
    const mock = await mockPihole()
    await expectCode(clientFor(mock, { password: 'nope' }).testConnection(), 'auth_failed')
  })
})

describe('error mapping', () => {
  it('maps a wrong password to auth_failed without leaking it', async () => {
    const mock = await mockPihole()
    const wrong = 'wrong-secret-pass'
    const client = clientFor(mock, { password: wrong })
    const err = await expectCode(client.fetchDashboard(), 'auth_failed')
    expect(err.message).not.toContain(wrong)
    expect(mock.activeSessions()).toBe(0)
    // No hammering: one attempt per call.
    expect(mock.stats.loginAttempts).toBe(1)
  })

  it('maps a missing password to auth_failed', async () => {
    const mock = await mockPihole()
    await expectCode(clientFor(mock, { password: '' }).fetchDashboard(), 'auth_failed')
  })

  it('maps 429 on login to rate_limited', async () => {
    const mock = await mockPihole({ knobs: { rateLimitLogins: true } })
    await expectCode(clientFor(mock).fetchDashboard(), 'rate_limited')
  })

  it('maps exhausted session seats to rate_limited', async () => {
    const mock = await mockPihole({ knobs: { maxSessions: 1 } })
    const first = clientFor(mock)
    await first.fetchDashboard()
    await expectCode(clientFor(mock).fetchDashboard(), 'rate_limited')
    await first.logout()
    await expect(clientFor(mock).fetchDashboard()).resolves.toBeDefined()
  })

  it('maps a 2FA-protected Pi-hole to totp_required', async () => {
    const mock = await mockPihole({ knobs: { totpRequired: true } })
    await expectCode(clientFor(mock).fetchDashboard(), 'totp_required')
  })

  it('maps a server without /api/auth to bad_response mentioning v6', async () => {
    const mock = await mockPihole({ knobs: { mode: 'not-found' } })
    const err = await expectCode(clientFor(mock).fetchDashboard(), 'bad_response')
    expect(err.message).toMatch(/v6/)
  })

  it('maps an HTML-serving server to bad_response', async () => {
    const mock = await mockPihole({ knobs: { mode: 'html' } })
    const err = await expectCode(clientFor(mock).testConnection(), 'bad_response')
    expect(err.message).toMatch(/v6/)
  })

  it('maps broken JSON to bad_response', async () => {
    const mock = await mockPihole({ knobs: { mode: 'bad-json' } })
    await expectCode(clientFor(mock).fetchDashboard(), 'bad_response')
  })

  it('maps wrongly shaped JSON to bad_response', async () => {
    const mock = await mockPihole({ knobs: { mode: 'wrong-shape' } })
    await expectCode(clientFor(mock).fetchDashboard(), 'bad_response')
  })

  it('maps a closed port to unreachable', async () => {
    const mock = await mockPihole()
    const client = clientFor(mock)
    await mock.close()
    await expectCode(client.fetchDashboard(), 'unreachable')
    await expectCode(client.testConnection(), 'unreachable')
  })

  it('maps an unresolvable host to unreachable', async () => {
    const client = new PiholeClient({
      baseUrl: 'http://pihole-does-not-exist.invalid',
      password: PASSWORD,
      allowSelfSigned: false
    })
    await expectCode(client.fetchDashboard(), 'unreachable')
  })

  it.each(['', 'not a url', 'pi.hole', 'ftp://pi.hole', 'file:///etc/passwd', 'http://'])(
    'maps base URL %j to invalid_url',
    async (baseUrl) => {
      const client = new PiholeClient({ baseUrl, password: PASSWORD, allowSelfSigned: false })
      await expectCode(client.fetchDashboard(), 'invalid_url')
      await expectCode(client.testConnection(), 'invalid_url')
      await expect(client.logout()).resolves.toBeUndefined()
    }
  )
})

describe('base URL handling', () => {
  it.each(['/', '/admin', '/admin/', '/ADMIN', '/api', '//'])(
    'tolerates a trailing %j',
    async (suffix) => {
      const mock = await mockPihole()
      const client = clientFor(mock, { baseUrl: mock.url + suffix })
      const data = await client.fetchDashboard()
      expect(data.history).toHaveLength(144)
      expect(mock.stats.requests[0]).toBe('POST /api/auth')
      expect(mock.stats.requests.every((r) => /^[A-Z]+ \/api\/[a-z]/.test(r))).toBe(true)
    }
  )

  it('tolerates surrounding whitespace', async () => {
    const mock = await mockPihole()
    const info = await clientFor(mock, { baseUrl: `  ${mock.url}/admin/  ` }).testConnection()
    expect(info.version).toBe('v6.1.4')
  })
})

describe('HTTPS', () => {
  const fixture = (name: string): string =>
    readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')
  const tls = (): { key: string; cert: string } => ({
    key: fixture('test-key.pem'),
    cert: fixture('test-cert.pem')
  })

  it('rejects a self-signed certificate with a tls error by default', async () => {
    const mock = await mockPihole({ tls: tls() })
    await expectCode(clientFor(mock).fetchDashboard(), 'tls')
    expect(mock.stats.requests).toHaveLength(0)
  })

  it('accepts a self-signed certificate when allowed, without touching global TLS state', async () => {
    const mock = await mockPihole({ tls: tls() })
    const data = await clientFor(mock, { allowSelfSigned: true }).fetchDashboard()
    expect(data.history).toHaveLength(144)
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined()
    // Another client on the same server still verifies certificates.
    await expectCode(clientFor(mock).fetchDashboard(), 'tls')
  })

  it('maps HTTPS against a plain HTTP port to a tls error', async () => {
    const mock = await mockPihole()
    const client = clientFor(mock, { baseUrl: mock.url.replace('http://', 'https://') })
    await expectCode(client.fetchDashboard(), 'tls')
  })
})
