/**
 * Settings persistence. This module is deliberately free of Electron imports:
 * the file path and the encrypt/decrypt pair are injected (see
 * createElectronSettingsStore in ./settingsElectron.ts) so the logic can be
 * unit-tested under plain Node.
 *
 * The password is only ever held on disk as base64 ciphertext produced by the
 * injected cipher. It is never logged and never returned to the renderer.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  DEFAULT_REFRESH_SECONDS,
  MIN_REFRESH_SECONDS,
  type AppError,
  type PiholeConnection,
  type Result,
  type SaveSettingsInput,
  type Settings
} from '@shared/contract'

/** Upper bound so a typo can't produce a timer that overflows setTimeout. */
export const MAX_REFRESH_SECONDS = 86_400

export interface Cipher {
  isAvailable(): boolean
  encrypt(plain: string): Buffer
  /** May throw if the ciphertext was produced by another user/machine. */
  decrypt(data: Buffer): string
}

/** The on-disk shape. */
export interface StoredSettings {
  baseUrl: string
  refreshSeconds: number
  allowSelfSigned: boolean
  /** base64 ciphertext, or null when no password is stored. */
  encryptedPassword: string | null
}

export const DEFAULT_STORED: Readonly<StoredSettings> = Object.freeze({
  baseUrl: '',
  refreshSeconds: DEFAULT_REFRESH_SECONDS,
  allowSelfSigned: false,
  encryptedPassword: null
})

function fail<T>(code: AppError['code'], message: string): Result<T> {
  return { ok: false, error: { code, message } }
}

// ---------- Pure helpers ----------

/**
 * Trim, default the scheme to http://, require http/https, and reduce to
 * origin + path. Credentials, query and fragment are dropped, as is a pasted
 * trailing "/admin" (the web UI path, not the API root).
 */
export function normalizeBaseUrl(raw: unknown): Result<string> {
  if (typeof raw !== 'string') return fail('invalid_url', 'Enter the address of your Pi-hole.')
  let text = raw.trim()
  if (text === '') return fail('invalid_url', 'Enter the address of your Pi-hole.')
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`

  let url: URL
  try {
    url = new URL(text)
  } catch {
    return fail('invalid_url', 'That address is not a valid URL.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return fail('invalid_url', 'The address must start with http:// or https://.')
  }
  if (url.hostname === '') return fail('invalid_url', 'That address is not a valid URL.')

  let path = url.pathname.replace(/\/+$/, '')
  path = path.replace(/\/admin$/i, '')
  return { ok: true, data: `${url.protocol}//${url.host}${path}` }
}

export function clampRefreshSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_REFRESH_SECONDS
  return Math.min(MAX_REFRESH_SECONDS, Math.max(MIN_REFRESH_SECONDS, Math.round(value)))
}

/** Parse file contents; anything missing, corrupt or mistyped falls back to defaults. */
export function parseStored(text: string | null): StoredSettings {
  if (text === null) return { ...DEFAULT_STORED }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ...DEFAULT_STORED }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...DEFAULT_STORED }
  const obj = raw as Record<string, unknown>

  let baseUrl = ''
  if (typeof obj['baseUrl'] === 'string' && obj['baseUrl'].trim() !== '') {
    const normalized = normalizeBaseUrl(obj['baseUrl'])
    if (normalized.ok) baseUrl = normalized.data
  }
  const enc = obj['encryptedPassword']
  return {
    baseUrl,
    refreshSeconds: clampRefreshSeconds(obj['refreshSeconds']),
    allowSelfSigned: obj['allowSelfSigned'] === true,
    encryptedPassword: typeof enc === 'string' && enc !== '' ? enc : null
  }
}

export function serializeStored(stored: StoredSettings): string {
  const out: StoredSettings = {
    baseUrl: stored.baseUrl,
    refreshSeconds: stored.refreshSeconds,
    allowSelfSigned: stored.allowSelfSigned,
    encryptedPassword: stored.encryptedPassword
  }
  return `${JSON.stringify(out, null, 2)}\n`
}

export function toPublicSettings(stored: StoredSettings): Settings {
  return {
    baseUrl: stored.baseUrl,
    refreshSeconds: stored.refreshSeconds,
    allowSelfSigned: stored.allowSelfSigned,
    hasPassword: stored.encryptedPassword !== null
  }
}

function originOf(baseUrl: string): string | null {
  const normalized = normalizeBaseUrl(baseUrl)
  if (!normalized.ok) return null
  return new URL(normalized.data).origin
}

/**
 * Whether the stored password may be sent to `next` without being re-entered.
 * It is bound to the origin (scheme + host + port) it was saved for, and is
 * not reused when certificate checking is being switched off.
 */
export function canReuseStoredPassword(
  saved: { baseUrl: string; allowSelfSigned: boolean },
  next: { baseUrl: string; allowSelfSigned: boolean }
): boolean {
  const savedOrigin = originOf(saved.baseUrl)
  if (savedOrigin === null || savedOrigin !== originOf(next.baseUrl)) return false
  return saved.allowSelfSigned || !next.allowSelfSigned
}

/** Error for a request that would reuse the stored password where it must not be. */
export function reenterPasswordError<T>(): Result<T> {
  return fail(
    'auth_failed',
    'The address or certificate setting changed, so the saved password was not used. Enter the password again.'
  )
}

/** Runtime check for values arriving over IPC. */
export function isSaveSettingsInput(value: unknown): value is SaveSettingsInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return (
    typeof v['baseUrl'] === 'string' &&
    v['baseUrl'].length <= 2048 &&
    typeof v['refreshSeconds'] === 'number' &&
    typeof v['allowSelfSigned'] === 'boolean' &&
    (v['password'] === undefined ||
      (typeof v['password'] === 'string' && v['password'].length <= 4096))
  )
}

/**
 * Apply a save request to the current stored settings.
 * password: undefined keeps, "" clears, anything else is encrypted and replaces.
 * Keeping is refused (see canReuseStoredPassword) when the address origin
 * changes or self-signed certificates are newly allowed.
 */
export function mergeSettings(
  current: StoredSettings,
  input: SaveSettingsInput,
  cipher: Cipher
): Result<StoredSettings> {
  const url = normalizeBaseUrl(input.baseUrl)
  if (!url.ok) return url

  let encryptedPassword = current.encryptedPassword
  if (
    input.password === undefined &&
    encryptedPassword !== null &&
    !canReuseStoredPassword(current, { baseUrl: url.data, allowSelfSigned: input.allowSelfSigned })
  ) {
    return reenterPasswordError()
  }
  if (input.password === '') {
    encryptedPassword = null
  } else if (input.password !== undefined) {
    if (!cipher.isAvailable()) {
      return fail(
        'unknown',
        'Secure storage is not available on this system, so the password was not saved.'
      )
    }
    try {
      encryptedPassword = cipher.encrypt(input.password).toString('base64')
    } catch {
      return fail('unknown', 'The password could not be encrypted, so nothing was saved.')
    }
  }

  return {
    ok: true,
    data: {
      baseUrl: url.data,
      refreshSeconds: clampRefreshSeconds(input.refreshSeconds),
      allowSelfSigned: input.allowSelfSigned === true,
      encryptedPassword
    }
  }
}

/** Decrypt the stored password. "" when none is stored. */
export function decryptPassword(stored: StoredSettings, cipher: Cipher): Result<string> {
  if (stored.encryptedPassword === null) return { ok: true, data: '' }
  try {
    if (!cipher.isAvailable()) throw new Error('unavailable')
    return { ok: true, data: cipher.decrypt(Buffer.from(stored.encryptedPassword, 'base64')) }
  } catch {
    return fail(
      'auth_failed',
      'The saved password could not be read. Enter it again in Settings.'
    )
  }
}

// ---------- Store ----------

export class SettingsStore {
  private readonly filePath: string
  private readonly cipher: Cipher
  private cached: StoredSettings | null = null

  constructor(filePath: string, cipher: Cipher) {
    this.filePath = filePath
    this.cipher = cipher
  }

  private read(): StoredSettings {
    if (this.cached) return this.cached
    let text: string | null = null
    try {
      text = readFileSync(this.filePath, 'utf8')
    } catch {
      text = null
    }
    this.cached = parseStored(text)
    return this.cached
  }

  get(): Settings {
    return toPublicSettings(this.read())
  }

  save(input: SaveSettingsInput): Result<Settings> {
    const merged = mergeSettings(this.read(), input, this.cipher)
    if (!merged.ok) return merged
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.tmp`
      writeFileSync(tmp, serializeStored(merged.data), { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, this.filePath)
    } catch {
      return fail('unknown', 'The settings file could not be written.')
    }
    this.cached = merged.data
    return { ok: true, data: toPublicSettings(merged.data) }
  }

  /** Decrypted stored password ("" when none). Main process only. */
  getPassword(): Result<string> {
    return decryptPassword(this.read(), this.cipher)
  }

  /** Connection for the saved settings; not_configured when no address is saved. */
  getConnection(): Result<PiholeConnection> {
    const stored = this.read()
    if (stored.baseUrl === '') {
      return fail('not_configured', 'No Pi-hole address has been set up yet.')
    }
    const password = this.getPassword()
    if (!password.ok) return password
    return {
      ok: true,
      data: {
        baseUrl: stored.baseUrl,
        password: password.data,
        allowSelfSigned: stored.allowSelfSigned
      }
    }
  }
}
