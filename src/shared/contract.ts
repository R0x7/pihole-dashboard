/**
 * Shared contract between the Electron main process, the preload bridge and
 * the React renderer. Every layer imports its types from here.
 *
 * All shapes are the app's own normalised shapes, not raw Pi-hole responses.
 * The Pi-hole client (src/main/pihole) is responsible for the translation.
 */

// ---------- Settings ----------

export interface Settings {
  /** e.g. "http://pi.hole" or "https://192.168.1.2:8443". Empty when not configured. */
  baseUrl: string
  /** Seconds between automatic refreshes. */
  refreshSeconds: number
  /** Accept self-signed HTTPS certificates from the Pi-hole. */
  allowSelfSigned: boolean
  /** Whether a password is stored. The password itself never reaches the renderer. */
  hasPassword: boolean
}

export interface SaveSettingsInput {
  baseUrl: string
  refreshSeconds: number
  allowSelfSigned: boolean
  /**
   * undefined = keep the stored password, "" = clear it (Pi-hole without a
   * password), any other string = replace it.
   */
  password?: string
}

export const DEFAULT_REFRESH_SECONDS = 30
export const MIN_REFRESH_SECONDS = 5

// ---------- Dashboard data ----------

export interface Summary {
  totalQueries: number
  blockedQueries: number
  /** 0-100. */
  percentBlocked: number
  domainsOnBlocklists: number
  activeClients: number
  /** null when the Pi-hole did not report it. */
  blockingEnabled: boolean | null
}

export interface HistoryPoint {
  /** Unix seconds, start of the bucket. */
  timestamp: number
  total: number
  blocked: number
  /** total - blocked. */
  allowed: number
}

export interface TopDomain {
  domain: string
  count: number
}

export interface TopClient {
  /** Hostname if known, otherwise the IP. */
  name: string
  ip: string
  count: number
}

export interface ClientHistory {
  /** Clients in column order, busiest first. */
  clients: { name: string; ip: string }[]
  /** counts[i] belongs to clients[i]. */
  points: { timestamp: number; counts: number[] }[]
}

export interface DashboardData {
  summary: Summary
  /** Last 24 hours, oldest first. */
  history: HistoryPoint[]
  topBlockedDomains: TopDomain[]
  /** Clients ranked by blocked queries. */
  topClientsBlocked: TopClient[]
  /** Clients ranked by total queries. */
  topClientsTotal: TopClient[]
  clientHistory: ClientHistory
  /** Unix milliseconds when this snapshot was fetched. */
  fetchedAt: number
}

// ---------- Errors and results ----------

export type AppErrorCode =
  | 'not_configured' // no base URL saved yet
  | 'invalid_url'
  | 'unreachable' // DNS failure, refused, timeout
  | 'tls' // certificate rejected (self-signed and not allowed)
  | 'auth_failed' // wrong password
  | 'totp_required' // Pi-hole has 2FA enabled; use an app password instead
  | 'rate_limited' // too many login attempts or no free API session seats
  | 'bad_response' // not a Pi-hole v6 API, or unexpected payload
  | 'unknown'

export interface AppError {
  code: AppErrorCode
  /** Human readable, safe to show in the UI. Never contains the password. */
  message: string
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: AppError }

export interface ConnectionInfo {
  /** Pi-hole core/FTL version string if it could be read. */
  version: string | null
}

// ---------- IPC ----------

export const IPC = {
  getSettings: 'settings:get',
  saveSettings: 'settings:save',
  testConnection: 'pihole:test',
  getDashboard: 'pihole:dashboard',
  showMenu: 'widget:menu'
} as const

/** Exposed to the renderer as `window.pihole` by the preload script. */
export interface RendererApi {
  getSettings(): Promise<Settings>
  saveSettings(input: SaveSettingsInput): Promise<Result<Settings>>
  /**
   * Test a connection. With `input`, tests those values without saving them
   * (an undefined password falls back to the stored one, but only while the
   * address origin is unchanged and self-signed is not newly allowed;
   * otherwise it fails asking for the password again). Without it, tests
   * the saved settings.
   */
  testConnection(input?: SaveSettingsInput): Promise<Result<ConnectionInfo>>
  getDashboard(): Promise<Result<DashboardData>>
  /** Pop up the widget menu (pin to desktop, start with Windows, quit) at the pointer. */
  showMenu(): void
}

// ---------- Main-process Pi-hole client ----------

export interface PiholeConnection {
  baseUrl: string
  /** Empty string when the Pi-hole has no password. */
  password: string
  allowSelfSigned: boolean
}

/**
 * Implemented by src/main/pihole/client.ts. Methods reject with a PiholeError
 * (see that module) carrying an AppErrorCode.
 */
export interface PiholeClientApi {
  testConnection(): Promise<ConnectionInfo>
  fetchDashboard(): Promise<DashboardData>
  /** Release the Pi-hole API session. Safe to call when not logged in. */
  logout(): Promise<void>
}
