import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppError, DashboardData, Result } from '@shared/contract'
import { nextPoll } from './pollingPolicy'

export interface DashboardPolling {
  /** Last good snapshot; kept while later refreshes fail. */
  data: DashboardData | null
  /** Error from the most recent attempt, cleared by the next success. */
  error: AppError | null
  /** A request is in flight. */
  refreshing: boolean
  /** Refresh now (no-op while a request is already in flight). Restarts stopped polling. */
  refresh: () => void
}

interface Options {
  enabled: boolean
  refreshSeconds: number
  /** Change to discard current data and start over (e.g. after saving settings). */
  resetKey: number
}

/**
 * Fetches immediately, then every `refreshSeconds` after the previous request
 * settled. Requests never overlap, polling pauses while the window is hidden
 * and resumes with an immediate refresh when it becomes visible again.
 *
 * After a failure the next attempt is decided by nextPoll: transient errors
 * back off, errors that need the user (wrong password, ...) stop automatic
 * polling until refresh() is called or resetKey changes.
 */
export function useDashboardPolling({ enabled, refreshSeconds, resetKey }: Options): DashboardPolling {
  const [data, setData] = useState<DashboardData | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  // Serialises requests across effect restarts, so a restart can't overlap
  // with a request the previous effect left in flight.
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const runRef = useRef<() => void>(() => {})

  useEffect(() => {
    setData(null)
    setError(null)
  }, [resetKey])

  useEffect(() => {
    if (!enabled) {
      setRefreshing(false)
      return
    }

    let disposed = false
    let inFlight = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    // Automatic polling is off until a manual refresh succeeds.
    let stopped = false
    // Earliest time (ms) for the next automatic attempt.
    let nextAt = 0

    const schedule = (): void => {
      clearTimeout(timer)
      if (disposed || stopped || document.visibilityState !== 'visible') return
      timer = setTimeout(run, Math.max(0, nextAt - Date.now()))
    }

    const run = (): void => {
      if (disposed || inFlight) return
      clearTimeout(timer)
      inFlight = true
      setRefreshing(true)

      const request = chain.current.then(async (): Promise<Result<DashboardData> | null> => {
        if (disposed) return null
        try {
          return await window.pihole.getDashboard()
        } catch {
          return {
            ok: false,
            error: { code: 'unknown', message: 'The dashboard could not be loaded.' }
          }
        }
      })
      chain.current = request

      void request.then((result) => {
        inFlight = false
        if (disposed || result === null) return
        setRefreshing(false)
        if (result.ok) {
          setData(result.data)
          setError(null)
          failures = 0
        } else {
          setError(result.error)
          failures += 1
        }
        const next = nextPoll(result.ok ? null : result.error.code, refreshSeconds, failures)
        stopped = next.kind === 'stop'
        if (next.kind === 'wait') nextAt = Date.now() + next.delayMs
        schedule()
      })
    }

    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible') clearTimeout(timer)
      // While failing, becoming visible keeps the stop / the remaining back-off.
      else if (failures > 0) schedule()
      else run()
    }

    runRef.current = run
    document.addEventListener('visibilitychange', onVisibility)
    run()

    return () => {
      disposed = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      runRef.current = () => {}
    }
  }, [enabled, refreshSeconds, resetKey])

  const refresh = useCallback(() => runRef.current(), [])

  return { data, error, refreshing, refresh }
}
