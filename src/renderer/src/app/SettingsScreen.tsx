import { useId, useRef, useState, type FormEvent } from 'react'
import {
  DEFAULT_REFRESH_SECONDS,
  MIN_REFRESH_SECONDS,
  type SaveSettingsInput,
  type Settings
} from '@shared/contract'

interface Props {
  settings: Settings
  /** First run: no Cancel button, connect wording. */
  firstRun: boolean
  onSaved: (settings: Settings) => void
  onCancel: () => void
}

type TestState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'ok'; version: string | null }
  | { kind: 'error'; message: string }

export function SettingsScreen({ settings, firstRun, onSaved, onCancel }: Props) {
  const id = useId()
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl)
  const [password, setPassword] = useState('')
  const [removePassword, setRemovePassword] = useState(false)
  const [refresh, setRefresh] = useState(String(settings.refreshSeconds))
  const [allowSelfSigned, setAllowSelfSigned] = useState(settings.allowSelfSigned)
  const [test, setTest] = useState<TestState>({ kind: 'idle' })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // Ignore a test result that arrives after the form was edited or unmounted.
  const testToken = useRef(0)

  const edited = (): void => {
    testToken.current += 1
    setTest({ kind: 'idle' })
    setSaveError(null)
  }

  const buildInput = (): SaveSettingsInput => {
    const seconds = Number.parseInt(refresh, 10)
    const input: SaveSettingsInput = {
      baseUrl: baseUrl.trim(),
      refreshSeconds: Number.isFinite(seconds)
        ? Math.max(MIN_REFRESH_SECONDS, seconds)
        : DEFAULT_REFRESH_SECONDS,
      allowSelfSigned
    }
    // undefined keeps the stored password, "" clears it, anything else replaces it.
    if (password !== '') input.password = password
    else if (!settings.hasPassword || removePassword) input.password = ''
    return input
  }

  const runTest = async (): Promise<void> => {
    const token = ++testToken.current
    setTest({ kind: 'running' })
    let next: TestState
    try {
      const result = await window.pihole.testConnection(buildInput())
      next = result.ok
        ? { kind: 'ok', version: result.data.version }
        : { kind: 'error', message: result.error.message }
    } catch {
      next = { kind: 'error', message: 'The connection test could not be run.' }
    }
    if (testToken.current === token) setTest(next)
  }

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (saving) return
    setSaving(true)
    setSaveError(null)
    try {
      const result = await window.pihole.saveSettings(buildInput())
      if (result.ok) {
        testToken.current += 1
        onSaved(result.data)
        return
      }
      setSaveError(result.error.message)
    } catch {
      setSaveError('The settings could not be saved.')
    }
    setSaving(false)
  }

  const busy = saving || test.kind === 'running'

  return (
    <div className="app-settings-wrap">
      <form className="app-settings" onSubmit={(e) => void save(e)} noValidate>
        <h1>{firstRun ? 'Connect to your Pi-hole' : 'Settings'}</h1>
        <p className="app-settings-intro">
          {firstRun
            ? 'Enter the address and password of your Pi-hole to see its statistics.'
            : 'Change how this app connects to your Pi-hole.'}
        </p>

        <div className="app-field">
          <label htmlFor={`${id}-url`}>Pi-hole address</label>
          <input
            id={`${id}-url`}
            className="app-input"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            autoFocus={firstRun}
            placeholder="http://pi.hole"
            value={baseUrl}
            onChange={(e) => {
              setBaseUrl(e.target.value)
              edited()
            }}
          />
          <span className="app-hint">
            For example http://pi.hole or https://192.168.1.2. If you leave out http://, it is
            assumed.
          </span>
        </div>

        <div className="app-field">
          <label htmlFor={`${id}-password`}>Password</label>
          <input
            id={`${id}-password`}
            className="app-input"
            type="password"
            autoComplete="off"
            placeholder={
              settings.hasPassword
                ? 'A password is saved. Leave blank to keep it.'
                : 'Leave blank if your Pi-hole has no password'
            }
            value={password}
            disabled={removePassword}
            onChange={(e) => {
              setPassword(e.target.value)
              edited()
            }}
          />
          <span className="app-hint">
            If two-factor authentication is turned on for your Pi-hole, create an app password in
            its web interface and use that here. The password is stored encrypted on this computer.
          </span>
        </div>

        {settings.hasPassword && (
          <label className="app-checkbox">
            <input
              type="checkbox"
              checked={removePassword}
              onChange={(e) => {
                setRemovePassword(e.target.checked)
                if (e.target.checked) setPassword('')
                edited()
              }}
            />
            <span>Remove the saved password (my Pi-hole has no password)</span>
          </label>
        )}

        <div className="app-field">
          <label htmlFor={`${id}-refresh`}>Refresh every (seconds)</label>
          <input
            id={`${id}-refresh`}
            className="app-input app-input-narrow"
            type="number"
            min={MIN_REFRESH_SECONDS}
            step={1}
            value={refresh}
            onChange={(e) => setRefresh(e.target.value)}
          />
          <span className="app-hint">Minimum {MIN_REFRESH_SECONDS} seconds.</span>
        </div>

        <label className="app-checkbox">
          <input
            type="checkbox"
            checked={allowSelfSigned}
            onChange={(e) => {
              setAllowSelfSigned(e.target.checked)
              edited()
            }}
          />
          <span>
            Allow self-signed certificate
            <br />
            <span className="app-hint">
              Only needed for https:// addresses whose certificate Windows does not trust.
            </span>
          </span>
        </label>

        <div className="app-test-row">
          <button
            type="button"
            className="app-button"
            onClick={() => void runTest()}
            disabled={busy || baseUrl.trim() === ''}
          >
            {test.kind === 'running' && <span className="app-spinner" aria-hidden="true" />}
            Test connection
          </button>
          <div aria-live="polite" style={{ flex: '1 1 auto', minWidth: 0 }}>
            {test.kind === 'ok' && (
              <div className="app-status app-status-ok">
                Connected{test.version ? ` (Pi-hole ${test.version})` : ''}
              </div>
            )}
            {test.kind === 'error' && (
              <div className="app-status app-status-error">{test.message}</div>
            )}
          </div>
        </div>

        {saveError && (
          <div className="app-status app-status-error" role="alert" style={{ marginBottom: 16 }}>
            {saveError}
          </div>
        )}

        <div className="app-settings-actions">
          {!firstRun && (
            <button type="button" className="app-button app-button-quiet" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button
            type="submit"
            className="app-button app-button-primary"
            disabled={saving || baseUrl.trim() === ''}
          >
            {firstRun ? 'Save and connect' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  )
}
