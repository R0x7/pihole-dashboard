// Decides what automatic polling does after a request settled. Pure: no React, no DOM.
import type { AppErrorCode } from '@shared/contract'

/** Longest wait between automatic retries while requests keep failing. */
export const MAX_BACKOFF_MS = 5 * 60 * 1000

/**
 * Errors that retrying cannot fix: polling stops until the user retries or
 * saves new settings. Each retry would be another failed login on the Pi-hole.
 */
const STOP_CODES: ReadonlySet<AppErrorCode> = new Set<AppErrorCode>([
  'auth_failed',
  'totp_required',
  'invalid_url',
  'not_configured',
  'tls'
])

export type NextPoll = { kind: 'stop' } | { kind: 'wait'; delayMs: number }

/**
 * @param errorCode null after a success, otherwise the code of the failure.
 * @param refreshSeconds the configured refresh interval.
 * @param consecutiveFailures failures in a row including this one (0 after a success).
 */
export function nextPoll(
  errorCode: AppErrorCode | null,
  refreshSeconds: number,
  consecutiveFailures: number
): NextPoll {
  const intervalMs = Math.max(1, refreshSeconds) * 1000
  if (errorCode === null) return { kind: 'wait', delayMs: intervalMs }
  if (STOP_CODES.has(errorCode)) return { kind: 'stop' }
  // Double per failure, capped; never faster than the normal interval.
  const doublings = Math.min(Math.max(1, consecutiveFailures), 30)
  const backoffMs = Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** doublings)
  return { kind: 'wait', delayMs: Math.max(intervalMs, backoffMs) }
}
