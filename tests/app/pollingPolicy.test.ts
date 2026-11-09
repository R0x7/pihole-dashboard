import { describe, expect, it } from 'vitest'
import type { AppErrorCode } from '@shared/contract'
import { MAX_BACKOFF_MS, nextPoll } from '../../src/renderer/src/app/pollingPolicy'

describe('nextPoll', () => {
  it('waits one refresh interval after a success', () => {
    expect(nextPoll(null, 30, 0)).toEqual({ kind: 'wait', delayMs: 30_000 })
    expect(nextPoll(null, 5, 0)).toEqual({ kind: 'wait', delayMs: 5_000 })
    // Guards against a zero or negative interval.
    expect(nextPoll(null, 0, 0)).toEqual({ kind: 'wait', delayMs: 1_000 })
  })

  it.each<AppErrorCode>(['auth_failed', 'totp_required', 'invalid_url', 'not_configured', 'tls'])(
    'stops after %s, however often it happened',
    (code) => {
      expect(nextPoll(code, 5, 1)).toEqual({ kind: 'stop' })
      expect(nextPoll(code, 5, 50)).toEqual({ kind: 'stop' })
    }
  )

  it.each<AppErrorCode>(['rate_limited', 'unreachable', 'bad_response', 'unknown'])(
    'backs off exponentially after %s, up to five minutes',
    (code) => {
      const delays = [1, 2, 3, 4, 5, 6, 7, 8].map((failures) => {
        const next = nextPoll(code, 5, failures)
        if (next.kind !== 'wait') throw new Error('expected a wait')
        return next.delayMs
      })
      expect(delays).toEqual([10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000])
      expect(MAX_BACKOFF_MS).toBe(300_000)
      expect(nextPoll(code, 5, 100_000)).toEqual({ kind: 'wait', delayMs: MAX_BACKOFF_MS })
    }
  )

  it('starts over at the refresh interval after a success', () => {
    expect(nextPoll('unreachable', 30, 4)).toEqual({ kind: 'wait', delayMs: 300_000 })
    expect(nextPoll(null, 30, 0)).toEqual({ kind: 'wait', delayMs: 30_000 })
    expect(nextPoll('unreachable', 30, 1)).toEqual({ kind: 'wait', delayMs: 60_000 })
  })

  it('never retries faster than a refresh interval longer than the cap', () => {
    expect(nextPoll('unreachable', 600, 1)).toEqual({ kind: 'wait', delayMs: 600_000 })
    expect(nextPoll('unreachable', 600, 9)).toEqual({ kind: 'wait', delayMs: 600_000 })
  })
})
