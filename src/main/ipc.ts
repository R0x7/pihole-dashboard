import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  IPC,
  type AppError,
  type ConnectionInfo,
  type DashboardData,
  type PiholeConnection,
  type Result,
  type Settings
} from '@shared/contract'
import { PiholeClient, PiholeError } from './pihole/client'
import {
  canReuseStoredPassword,
  isSaveSettingsInput,
  normalizeBaseUrl,
  reenterPasswordError,
  type SettingsStore
} from './settings'

function toAppError(err: unknown): AppError {
  if (err instanceof PiholeError) return { code: err.code, message: err.message }
  // Deliberately generic: unexpected errors may carry request details.
  return { code: 'unknown', message: 'Something went wrong while talking to the Pi-hole.' }
}

const BAD_ARGS: AppError = { code: 'unknown', message: 'Invalid request.' }
const SHUTTING_DOWN: AppError = { code: 'unknown', message: 'The app is closing.' }

function sameConnection(a: PiholeConnection, b: PiholeConnection): boolean {
  return (
    a.baseUrl === b.baseUrl && a.password === b.password && a.allowSelfSigned === b.allowSelfSigned
  )
}

async function quietLogout(client: PiholeClient): Promise<void> {
  try {
    await client.logout()
  } catch {
    // Best effort: the session will expire on the Pi-hole by itself.
  }
}

export interface IpcController {
  /** Release the Pi-hole session, giving up after timeoutMs. */
  shutdown(timeoutMs: number): Promise<void>
}

export interface IpcOptions {
  /** Return false to reject a call (e.g. not from the app's own window). */
  isTrustedSender?: (event: IpcMainInvokeEvent) => boolean
}

export function registerIpc(store: SettingsStore, options: IpcOptions = {}): IpcController {
  // One long-lived client so refreshes reuse a single Pi-hole API session.
  let active: { client: PiholeClient; connection: PiholeConnection } | null = null
  // Once shutdown() has started, no handler creates a client or logs in.
  let shuttingDown = false

  const trusted = (event: IpcMainInvokeEvent): boolean =>
    options.isTrustedSender ? options.isTrustedSender(event) : true

  /** Client for the saved settings, replacing (and logging out) a stale one. */
  function clientForSaved(): Result<PiholeClient> {
    if (shuttingDown) return { ok: false, error: SHUTTING_DOWN }
    const connection = store.getConnection()
    if (!connection.ok) {
      dropActive()
      return connection
    }
    if (active && sameConnection(active.connection, connection.data)) {
      return { ok: true, data: active.client }
    }
    dropActive()
    active = { client: new PiholeClient(connection.data), connection: connection.data }
    return { ok: true, data: active.client }
  }

  function dropActive(): void {
    if (!active) return
    const old = active.client
    active = null
    void quietLogout(old)
  }

  ipcMain.handle(IPC.getSettings, (event): Settings => {
    if (!trusted(event)) throw new Error('Forbidden')
    return store.get()
  })

  ipcMain.handle(IPC.saveSettings, (event, input: unknown): Result<Settings> => {
    if (!trusted(event) || !isSaveSettingsInput(input)) return { ok: false, error: BAD_ARGS }
    const saved = store.save(input)
    if (saved.ok) {
      // Swap the client now if the connection changed, so the old seat is freed promptly.
      const connection = store.getConnection()
      if (!connection.ok || (active && !sameConnection(active.connection, connection.data))) {
        dropActive()
      }
    }
    return saved
  })

  ipcMain.handle(
    IPC.testConnection,
    async (event, input: unknown): Promise<Result<ConnectionInfo>> => {
      if (!trusted(event)) return { ok: false, error: BAD_ARGS }

      if (input === undefined || input === null) {
        const client = clientForSaved()
        if (!client.ok) return client
        try {
          return { ok: true, data: await client.data.testConnection() }
        } catch (err) {
          return { ok: false, error: toAppError(err) }
        }
      }

      if (!isSaveSettingsInput(input)) return { ok: false, error: BAD_ARGS }
      if (shuttingDown) return { ok: false, error: SHUTTING_DOWN }
      const url = normalizeBaseUrl(input.baseUrl)
      if (!url.ok) return url
      let password = input.password
      if (password === undefined) {
        // The stored password only ever goes to the Pi-hole it was saved for.
        const saved = store.get()
        const next = { baseUrl: url.data, allowSelfSigned: input.allowSelfSigned }
        if (saved.hasPassword && !canReuseStoredPassword(saved, next)) {
          return reenterPasswordError()
        }
        const stored = store.getPassword()
        if (!stored.ok) return stored
        password = stored.data
      }
      const temp = new PiholeClient({
        baseUrl: url.data,
        password,
        allowSelfSigned: input.allowSelfSigned
      })
      try {
        return { ok: true, data: await temp.testConnection() }
      } catch (err) {
        return { ok: false, error: toAppError(err) }
      } finally {
        await quietLogout(temp)
      }
    }
  )

  ipcMain.handle(IPC.getDashboard, async (event): Promise<Result<DashboardData>> => {
    if (!trusted(event)) return { ok: false, error: BAD_ARGS }
    const client = clientForSaved()
    if (!client.ok) return client
    try {
      return { ok: true, data: await client.data.fetchDashboard() }
    } catch (err) {
      return { ok: false, error: toAppError(err) }
    }
  })

  return {
    async shutdown(timeoutMs: number): Promise<void> {
      shuttingDown = true
      if (!active) return
      const old = active.client
      active = null
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      })
      await Promise.race([quietLogout(old), timeout])
      clearTimeout(timer)
    }
  }
}
