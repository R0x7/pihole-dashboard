import { useCallback, useEffect, useState } from 'react'
import type { Settings } from '@shared/contract'
import { Dashboard } from './dashboard/Dashboard'
import { ErrorBanner } from './app/ErrorBanner'
import { SettingsScreen } from './app/SettingsScreen'
import { useDashboardPolling } from './app/useDashboardPolling'
import './app/app.css'

type LoadState =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; settings: Settings }

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit'
})

export function App() {
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' })
  const [showSettings, setShowSettings] = useState(false)
  // Bumped on every save so the dashboard restarts against the new settings.
  const [settingsVersion, setSettingsVersion] = useState(0)

  const loadSettings = useCallback(() => {
    let cancelled = false
    setLoad({ kind: 'loading' })
    window.pihole.getSettings().then(
      (settings) => {
        if (!cancelled) setLoad({ kind: 'ready', settings })
      },
      () => {
        if (!cancelled) setLoad({ kind: 'failed' })
      }
    )
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => loadSettings(), [loadSettings])

  const settings = load.kind === 'ready' ? load.settings : null
  const configured = settings !== null && settings.baseUrl !== ''
  const onSettingsScreen = settings !== null && (!configured || showSettings)

  const { data, error, refreshing, refresh } = useDashboardPolling({
    enabled: configured && !onSettingsScreen,
    refreshSeconds: settings?.refreshSeconds ?? 30,
    resetKey: settingsVersion
  })

  if (load.kind === 'loading') {
    return (
      <div className="app-centered" role="status">
        <span className="app-spinner" aria-hidden="true" />
        <span>Starting…</span>
      </div>
    )
  }

  if (settings === null) {
    return (
      <div className="app-centered">
        <span>The app settings could not be loaded.</span>
        <button type="button" className="app-button" onClick={loadSettings}>
          Try again
        </button>
      </div>
    )
  }

  if (onSettingsScreen) {
    return (
      <div className="app-shell">
        <SettingsScreen
          settings={settings}
          firstRun={!configured}
          onCancel={() => setShowSettings(false)}
          onSaved={(saved) => {
            setLoad({ kind: 'ready', settings: saved })
            setSettingsVersion((v) => v + 1)
            setShowSettings(false)
          }}
        />
      </div>
    )
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-title">
          <h1>Pi-hole Dashboard</h1>
          <span className="app-header-address" title={settings.baseUrl}>
            {settings.baseUrl}
          </span>
        </div>
        <span className="app-header-updated" aria-live="off">
          {data ? `Updated ${timeFormat.format(data.fetchedAt)}` : 'Not updated yet'}
        </span>
        <div className="app-header-actions">
          <button type="button" className="app-button" onClick={refresh} disabled={refreshing}>
            {refreshing && <span className="app-spinner" aria-hidden="true" />}
            Refresh
          </button>
          <button type="button" className="app-button" onClick={() => setShowSettings(true)}>
            Settings
          </button>
        </div>
      </header>

      <main className="app-main">
        {error && (
          <ErrorBanner
            error={error}
            stale={data !== null}
            busy={refreshing}
            onRetry={refresh}
            onOpenSettings={() => setShowSettings(true)}
          />
        )}
        {data ? (
          <Dashboard data={data} />
        ) : (
          !error && (
            <div className="app-skeleton" role="status">
              <span className="app-visually-hidden">Loading your Pi-hole statistics…</span>
              <div className="app-skeleton-block" />
              <div className="app-skeleton-block" />
              <div className="app-skeleton-block" />
              <div className="app-skeleton-block" />
              <div className="app-skeleton-block app-skeleton-wide" />
              <div className="app-skeleton-block app-skeleton-half" />
              <div className="app-skeleton-block app-skeleton-half" />
            </div>
          )
        )}
      </main>
    </div>
  )
}
