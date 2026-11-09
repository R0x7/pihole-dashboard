import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SIZE,
  initialBounds,
  MIN_SIZE,
  parseWindowState
} from '../../src/main/windowState'

const primary = { x: 0, y: 0, width: 1920, height: 1040 }
const second = { x: 1920, y: 0, width: 1280, height: 984 }

describe('parseWindowState', () => {
  it('defaults to pinned with no saved position', () => {
    expect(parseWindowState(null)).toEqual({ bounds: null, pinned: true })
    expect(parseWindowState('not json')).toEqual({ bounds: null, pinned: true })
    expect(parseWindowState('[1,2]')).toEqual({ bounds: null, pinned: true })
  })

  it('reads a saved state and rounds fractional pixels', () => {
    const text = JSON.stringify({
      pinned: false,
      bounds: { x: 10.4, y: 20.6, width: 500, height: 600 }
    })
    expect(parseWindowState(text)).toEqual({
      pinned: false,
      bounds: { x: 10, y: 21, width: 500, height: 600 }
    })
  })

  it('drops bounds that are mistyped or empty but keeps the rest', () => {
    for (const bounds of [
      { x: '1', y: 2, width: 3, height: 4 },
      { x: 1, y: 2, width: 0, height: 4 },
      { x: 1, y: 2, width: 3 },
      { x: 1, y: 2, width: 3, height: null },
      'big'
    ]) {
      expect(parseWindowState(JSON.stringify({ pinned: false, bounds }))).toEqual({
        pinned: false,
        bounds: null
      })
    }
  })
})

describe('initialBounds', () => {
  it('places a new widget in the top-right corner of the primary screen', () => {
    expect(initialBounds(null, [primary, second], primary)).toEqual({
      x: 1920 - DEFAULT_SIZE.width - 24,
      y: 24,
      ...DEFAULT_SIZE
    })
  })

  it('keeps a saved position that is still on a screen', () => {
    const saved = { x: 2000, y: 100, width: 500, height: 640 }
    expect(initialBounds(saved, [primary, second], primary)).toEqual(saved)
  })

  it('falls back to the default when the saved screen is gone', () => {
    const saved = { x: 2000, y: 100, width: 500, height: 640 }
    expect(initialBounds(saved, [primary], primary).x).toBe(1920 - DEFAULT_SIZE.width - 24)
  })

  it('falls back when only a sliver would be visible', () => {
    const saved = { x: 1900, y: 100, width: 500, height: 640 }
    expect(initialBounds(saved, [primary], primary).x).toBe(1920 - DEFAULT_SIZE.width - 24)
  })

  it('never opens smaller than the minimum size', () => {
    const saved = { x: 100, y: 100, width: 50, height: 50 }
    expect(initialBounds(saved, [primary], primary)).toEqual({ x: 100, y: 100, ...MIN_SIZE })
  })

  it('shrinks the default to fit a small screen', () => {
    const small = { x: 0, y: 0, width: 400, height: 500 }
    expect(initialBounds(null, [small], small)).toEqual({ x: 24, y: 24, width: 352, height: 452 })
  })
})
