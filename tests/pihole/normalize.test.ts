import { describe, expect, it } from 'vitest'
import {
  MAX_HISTORY_POINTS,
  normalizeClientHistory,
  normalizeHistory
} from '../../src/main/pihole/normalize'

describe('history length caps', () => {
  const count = MAX_HISTORY_POINTS + 500
  // Newest first, to check the cap is applied after sorting.
  const timestamps = Array.from({ length: count }, (_, i) => (count - i) * 600)

  it('caps at 2000 entries', () => {
    expect(MAX_HISTORY_POINTS).toBe(2000)
  })

  it('keeps the most recent history points', () => {
    const history = normalizeHistory({
      history: timestamps.map((timestamp) => ({ timestamp, total: 3, blocked: 1 }))
    })
    expect(history).toHaveLength(MAX_HISTORY_POINTS)
    expect(history[0].timestamp).toBe(501 * 600)
    expect(history[history.length - 1].timestamp).toBe(count * 600)
    expect(history[0]).toMatchObject({ total: 3, blocked: 1, allowed: 2 })
  })

  it('keeps the most recent client history points', () => {
    const clientHistory = normalizeClientHistory({
      clients: { '10.0.0.1': { name: 'a.lan', total: 5 } },
      history: timestamps.map((timestamp) => ({ timestamp, data: { '10.0.0.1': 1 } }))
    })
    expect(clientHistory.points).toHaveLength(MAX_HISTORY_POINTS)
    expect(clientHistory.points[0].timestamp).toBe(501 * 600)
    expect(clientHistory.points[MAX_HISTORY_POINTS - 1].timestamp).toBe(count * 600)
    expect(clientHistory.clients).toEqual([{ name: 'a.lan', ip: '10.0.0.1' }])
  })

  it('leaves a normal-sized history alone', () => {
    const history = normalizeHistory({
      history: timestamps.slice(0, 144).map((timestamp) => ({ timestamp, total: 1, blocked: 0 }))
    })
    expect(history).toHaveLength(144)
  })
})
