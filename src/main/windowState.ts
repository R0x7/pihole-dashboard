/**
 * Where the widget sits and whether it is pinned to the desktop. Free of
 * Electron imports so it can be unit-tested under plain Node.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowState {
  /** null until the widget has been moved or resized. */
  bounds: Rect | null
  /** Sit on the desktop behind other windows (true) or float like a normal window. */
  pinned: boolean
}

export const DEFAULT_SIZE = { width: 460, height: 720 } as const
export const MIN_SIZE = { width: 340, height: 260 } as const
/** Gap between a freshly placed widget and the screen edge. */
const EDGE_MARGIN = 24
/** How much of the widget must be on a screen for a saved position to be kept. */
const MIN_VISIBLE = { width: 120, height: 60 } as const

function isRect(value: unknown): value is Rect {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return ['x', 'y', 'width', 'height'].every(
    (key) => typeof v[key] === 'number' && Number.isFinite(v[key])
  )
}

/** Anything missing, corrupt or mistyped falls back to the defaults. */
export function parseWindowState(text: string | null): WindowState {
  const state: WindowState = { bounds: null, pinned: true }
  if (text === null) return state
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return state
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return state
  const obj = raw as Record<string, unknown>
  if (typeof obj['pinned'] === 'boolean') state.pinned = obj['pinned']
  const b = obj['bounds']
  if (isRect(b) && b.width > 0 && b.height > 0) {
    state.bounds = {
      x: Math.round(b.x),
      y: Math.round(b.y),
      width: Math.round(b.width),
      height: Math.round(b.height)
    }
  }
  return state
}

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  return {
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  }
}

/**
 * Bounds to open with. A saved position is kept while enough of it is still
 * on some screen (monitors get unplugged); otherwise the widget goes to the
 * top-right corner of the primary screen.
 */
export function initialBounds(saved: Rect | null, workAreas: Rect[], primary: Rect): Rect {
  if (saved) {
    const width = Math.max(MIN_SIZE.width, saved.width)
    const height = Math.max(MIN_SIZE.height, saved.height)
    const rect = { x: saved.x, y: saved.y, width, height }
    const visible = workAreas.some((area) => {
      const o = overlap(rect, area)
      return o.width >= MIN_VISIBLE.width && o.height >= MIN_VISIBLE.height
    })
    if (visible) return rect
  }
  const width = Math.min(DEFAULT_SIZE.width, Math.max(MIN_SIZE.width, primary.width - 2 * EDGE_MARGIN))
  const height = Math.min(
    DEFAULT_SIZE.height,
    Math.max(MIN_SIZE.height, primary.height - 2 * EDGE_MARGIN)
  )
  return {
    x: primary.x + primary.width - width - EDGE_MARGIN,
    y: primary.y + EDGE_MARGIN,
    width,
    height
  }
}

export function loadWindowState(filePath: string): WindowState {
  try {
    return parseWindowState(readFileSync(filePath, 'utf8'))
  } catch {
    return parseWindowState(null)
  }
}

/** Best effort: losing the widget position is never worth an error. */
export function saveWindowState(filePath: string, state: WindowState): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp`
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    renameSync(tmp, filePath)
  } catch {
    // Ignored.
  }
}
