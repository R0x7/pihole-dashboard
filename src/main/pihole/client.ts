// STUB — owned by the Pi-hole client agent. Keep the exported names and signatures.
import type {
  AppErrorCode,
  ConnectionInfo,
  DashboardData,
  PiholeClientApi,
  PiholeConnection
} from '@shared/contract'

export class PiholeError extends Error {
  readonly code: AppErrorCode
  constructor(code: AppErrorCode, message: string) {
    super(message)
    this.name = 'PiholeError'
    this.code = code
  }
}

export class PiholeClient implements PiholeClientApi {
  readonly connection: PiholeConnection
  constructor(connection: PiholeConnection) {
    this.connection = connection
  }

  async testConnection(): Promise<ConnectionInfo> {
    throw new PiholeError('unknown', 'Pi-hole client not implemented yet')
  }

  async fetchDashboard(): Promise<DashboardData> {
    throw new PiholeError('unknown', 'Pi-hole client not implemented yet')
  }

  async logout(): Promise<void> {}
}
