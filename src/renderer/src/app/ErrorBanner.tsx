import type { AppError, AppErrorCode } from '@shared/contract'

const SETTINGS_CODES: ReadonlySet<AppErrorCode> = new Set<AppErrorCode>([
  'auth_failed',
  'not_configured',
  'invalid_url',
  'tls',
  'totp_required'
])

const TITLES: Record<AppErrorCode, string> = {
  not_configured: 'Pi-hole is not set up',
  invalid_url: 'The Pi-hole address is not valid',
  unreachable: 'Could not reach the Pi-hole',
  tls: 'The Pi-hole certificate was not trusted',
  auth_failed: 'Sign-in failed',
  totp_required: 'Two-factor sign-in needs an app password',
  rate_limited: 'The Pi-hole is refusing new sessions for now',
  bad_response: 'Unexpected response from the Pi-hole',
  unknown: 'Something went wrong'
}

interface Props {
  error: AppError
  /** True when older data is still being shown underneath. */
  stale: boolean
  busy: boolean
  onRetry: () => void
  onOpenSettings: () => void
}

export function ErrorBanner({ error, stale, busy, onRetry, onOpenSettings }: Props) {
  return (
    <div className="app-banner" role="alert">
      <div className="app-banner-text">
        <div className="app-banner-title">{TITLES[error.code] ?? TITLES.unknown}</div>
        <div className="app-banner-message">
          {error.message}
          {stale ? ' Showing the last data that loaded.' : ''}
        </div>
      </div>
      <div className="app-banner-actions">
        {SETTINGS_CODES.has(error.code) && (
          <button type="button" className="app-button" onClick={onOpenSettings}>
            Open settings
          </button>
        )}
        <button type="button" className="app-button" onClick={onRetry} disabled={busy}>
          Retry
        </button>
      </div>
    </div>
  )
}
