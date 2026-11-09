import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_REFRESH_SECONDS, MIN_REFRESH_SECONDS } from '@shared/contract'
import {
  clampRefreshSeconds,
  isSaveSettingsInput,
  mergeSettings,
  normalizeBaseUrl,
  parseStored,
  SettingsStore,
  DEFAULT_STORED,
  type Cipher
} from '../../src/main/settings'

/** Reversible fake cipher whose output never contains the plain text. */
function fakeCipher(available = true): Cipher {
  return {
    isAvailable: () => available,
    encrypt: (plain) => Buffer.from(Buffer.from(`enc:${plain}`, 'utf8').map((b) => b ^ 0x5a)),
    decrypt: (data) => {
      const text = Buffer.from(data.map((b) => b ^ 0x5a)).toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('bad ciphertext')
      return text.slice(4)
    }
  }
}

const base = { baseUrl: 'http://pi.hole', refreshSeconds: 30, allowSelfSigned: false }

describe('normalizeBaseUrl', () => {
  const ok = (raw: string) => {
    const r = normalizeBaseUrl(raw)
    if (!r.ok) throw new Error(`expected ok for ${raw}: ${r.error.message}`)
    return r.data
  }

  it('trims and keeps http/https URLs', () => {
    expect(ok('  http://pi.hole  ')).toBe('http://pi.hole')
    expect(ok('https://192.168.1.2:8443')).toBe('https://192.168.1.2:8443')
  })

  it('assumes http:// when the scheme is omitted', () => {
    expect(ok('pi.hole')).toBe('http://pi.hole')
    expect(ok('192.168.1.2:8080')).toBe('http://192.168.1.2:8080')
  })

  it('drops trailing slashes, /admin, query, fragment and credentials', () => {
    expect(ok('http://pi.hole/')).toBe('http://pi.hole')
    expect(ok('http://pi.hole/admin/')).toBe('http://pi.hole')
    expect(ok('http://user:secret@pi.hole/proxy/?a=1#x')).toBe('http://pi.hole/proxy')
  })

  it('rejects empty, malformed and non-http addresses', () => {
    for (const bad of ['', '   ', 'ftp://pi.hole', 'file:///c:/x', 'http://', 'http://a b']) {
      const r = normalizeBaseUrl(bad)
      expect(r.ok, bad).toBe(false)
      if (!r.ok) expect(r.error.code).toBe('invalid_url')
    }
    expect(normalizeBaseUrl(42).ok).toBe(false)
  })
})

describe('clampRefreshSeconds', () => {
  it('clamps to the minimum and rounds', () => {
    expect(clampRefreshSeconds(1)).toBe(MIN_REFRESH_SECONDS)
    expect(clampRefreshSeconds(-10)).toBe(MIN_REFRESH_SECONDS)
    expect(clampRefreshSeconds(60)).toBe(60)
    expect(clampRefreshSeconds(12.6)).toBe(13)
  })

  it('falls back to the default for non-numbers', () => {
    expect(clampRefreshSeconds(Number.NaN)).toBe(DEFAULT_REFRESH_SECONDS)
    expect(clampRefreshSeconds('30')).toBe(DEFAULT_REFRESH_SECONDS)
    expect(clampRefreshSeconds(Number.POSITIVE_INFINITY)).toBe(DEFAULT_REFRESH_SECONDS)
  })
})

describe('mergeSettings', () => {
  const cipher = fakeCipher()
  const current = { ...DEFAULT_STORED, baseUrl: 'http://old', encryptedPassword: 'T0xE' }

  it('keeps the stored password when password is undefined', () => {
    const r = mergeSettings(current, { ...base }, cipher)
    expect(r.ok && r.data.encryptedPassword).toBe('T0xE')
    expect(r.ok && r.data.baseUrl).toBe('http://pi.hole')
  })

  it('clears the stored password when password is ""', () => {
    const r = mergeSettings(current, { ...base, password: '' }, cipher)
    expect(r.ok && r.data.encryptedPassword).toBeNull()
  })

  it('replaces the stored password with ciphertext', () => {
    const r = mergeSettings(current, { ...base, password: 'hunter2' }, cipher)
    if (!r.ok) throw new Error('expected ok')
    expect(r.data.encryptedPassword).not.toBe('T0xE')
    expect(cipher.decrypt(Buffer.from(r.data.encryptedPassword!, 'base64'))).toBe('hunter2')
  })

  it('refuses to store a password when encryption is unavailable', () => {
    const r = mergeSettings(current, { ...base, password: 'hunter2' }, fakeCipher(false))
    expect(r.ok).toBe(false)
  })

  it('still allows keep/clear when encryption is unavailable', () => {
    expect(mergeSettings(current, { ...base }, fakeCipher(false)).ok).toBe(true)
    expect(mergeSettings(current, { ...base, password: '' }, fakeCipher(false)).ok).toBe(true)
  })

  it('rejects an invalid URL and clamps the refresh interval', () => {
    const bad = mergeSettings(current, { ...base, baseUrl: 'ftp://x' }, cipher)
    expect(!bad.ok && bad.error.code).toBe('invalid_url')
    const r = mergeSettings(current, { ...base, refreshSeconds: 1 }, cipher)
    expect(r.ok && r.data.refreshSeconds).toBe(MIN_REFRESH_SECONDS)
  })
})

describe('parseStored', () => {
  it('returns defaults for missing or corrupt content', () => {
    expect(parseStored(null)).toEqual(DEFAULT_STORED)
    expect(parseStored('{not json')).toEqual(DEFAULT_STORED)
    expect(parseStored('[]')).toEqual(DEFAULT_STORED)
    expect(parseStored('null')).toEqual(DEFAULT_STORED)
  })

  it('repairs mistyped fields individually', () => {
    const parsed = parseStored(
      JSON.stringify({
        baseUrl: 'ftp://x',
        refreshSeconds: 'soon',
        allowSelfSigned: 'yes',
        encryptedPassword: 7
      })
    )
    expect(parsed).toEqual(DEFAULT_STORED)
    expect(parseStored(JSON.stringify({ baseUrl: 'pi.hole', refreshSeconds: 2 }))).toEqual({
      ...DEFAULT_STORED,
      baseUrl: 'http://pi.hole',
      refreshSeconds: MIN_REFRESH_SECONDS
    })
  })
})

describe('isSaveSettingsInput', () => {
  it('accepts valid input and rejects malformed input', () => {
    expect(isSaveSettingsInput(base)).toBe(true)
    expect(isSaveSettingsInput({ ...base, password: 'x' })).toBe(true)
    expect(isSaveSettingsInput(null)).toBe(false)
    expect(isSaveSettingsInput('x')).toBe(false)
    expect(isSaveSettingsInput({ ...base, password: 5 })).toBe(false)
    expect(isSaveSettingsInput({ ...base, baseUrl: undefined })).toBe(false)
    expect(isSaveSettingsInput({ ...base, refreshSeconds: '30' })).toBe(false)
  })
})

describe('SettingsStore', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pihole-settings-'))
    file = join(dir, 'nested', 'settings.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('returns defaults when the file is missing', () => {
    const store = new SettingsStore(file, fakeCipher())
    expect(store.get()).toEqual({
      baseUrl: '',
      refreshSeconds: DEFAULT_REFRESH_SECONDS,
      allowSelfSigned: false,
      hasPassword: false
    })
    const conn = store.getConnection()
    expect(!conn.ok && conn.error.code).toBe('not_configured')
  })

  it('returns defaults when the file is corrupt', () => {
    const plain = join(dir, 'settings.json')
    writeFileSync(plain, '\u0000garbage{{', 'utf8')
    expect(new SettingsStore(plain, fakeCipher()).get().baseUrl).toBe('')
  })

  it('never writes the password in plain text and never exposes it', () => {
    const store = new SettingsStore(file, fakeCipher())
    const saved = store.save({ ...base, password: 'correct horse battery' })
    expect(saved).toEqual({
      ok: true,
      data: { ...base, hasPassword: true }
    })
    const onDisk = readFileSync(file, 'utf8')
    expect(onDisk).not.toContain('correct horse battery')
    expect(onDisk).not.toContain(Buffer.from('correct horse battery').toString('base64'))
    expect(JSON.stringify(saved)).not.toContain('correct horse battery')
    expect(JSON.stringify(store.get())).not.toContain('correct horse battery')
  })

  it('round-trips through a fresh store and honours keep / clear / replace', () => {
    new SettingsStore(file, fakeCipher()).save({ ...base, password: 'first' })

    const store = new SettingsStore(file, fakeCipher())
    expect(store.getConnection()).toEqual({
      ok: true,
      data: { baseUrl: 'http://pi.hole', password: 'first', allowSelfSigned: false }
    })

    store.save({ ...base, allowSelfSigned: true })
    expect(store.getPassword()).toEqual({ ok: true, data: 'first' })

    store.save({ ...base, password: 'second' })
    expect(new SettingsStore(file, fakeCipher()).getPassword()).toEqual({ ok: true, data: 'second' })

    expect(store.save({ ...base, password: '' })).toMatchObject({ data: { hasPassword: false } })
    expect(store.getPassword()).toEqual({ ok: true, data: '' })
    expect(JSON.parse(readFileSync(file, 'utf8')).encryptedPassword).toBeNull()
  })

  it('refuses to store a password without encryption and writes nothing', () => {
    const store = new SettingsStore(file, fakeCipher(false))
    const r = store.save({ ...base, password: 'hunter2' })
    expect(r.ok).toBe(false)
    expect(() => readFileSync(file, 'utf8')).toThrow()
    expect(store.get().hasPassword).toBe(false)
  })

  it('reports an error instead of throwing when the ciphertext cannot be decrypted', () => {
    const plain = join(dir, 'settings.json')
    writeFileSync(
      plain,
      JSON.stringify({ baseUrl: 'http://pi.hole', encryptedPassword: 'bm90LW91cnM=' }),
      'utf8'
    )
    const store = new SettingsStore(plain, fakeCipher())
    expect(store.get().hasPassword).toBe(true)
    const conn = store.getConnection()
    expect(!conn.ok && conn.error.code).toBe('auth_failed')
  })
})
