import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppError, DashboardData, Result } from '@shared/contract'

export interface DashboardPolling {
  /** Last good snapshot; kept while later refreshes fail. */
  data: DashboardData | null
  /** Error from the most recent attempt, cleared by the next success. */
  error: AppError | null
  /** A request is in flight. */
  refreshing: boolean
  /** Refresh now (no-op while a request is already in flight). */
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

    const schedule = (): void => {
      clearTimeout(timer)
      if (disposed || document.visibilityState !== 'visible') return
      timer = setTimeout(run, Math.max(1, refreshSeconds) * 1000)
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
        } else {
          setError(result.error)
        }
        schedule()
      })
    }

    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') run()
      else clearTimeout(timer)
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
