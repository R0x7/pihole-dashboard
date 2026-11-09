import { nativeImage, type NativeImage } from 'electron'

const SIZE = 32
const SAMPLES = 4
const OUTER = 14.5
const INNER = 8
/** Fraction of the ring drawn in the "blocked" colour, starting at 12 o'clock. */
const BLOCKED_SHARE = 0.3
const ALLOWED = [0x1f, 0x9d, 0x55] as const
const BLOCKED = [0xd6, 0x45, 0x45] as const

/** The tray icon: a small allowed/blocked ring, drawn here so no image file is needed. */
export function createTrayIcon(): NativeImage {
  const pixels = Buffer.alloc(SIZE * SIZE * 4)
  const centre = SIZE / 2
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0
      let g = 0
      let b = 0
      let hits = 0
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const dx = x + (sx + 0.5) / SAMPLES - centre
          const dy = y + (sy + 0.5) / SAMPLES - centre
          const dist = Math.hypot(dx, dy)
          if (dist > OUTER || dist < INNER) continue
          // 0 at 12 o'clock, growing clockwise to 1.
          const turn = (Math.atan2(dx, -dy) / (2 * Math.PI) + 1) % 1
          const colour = turn < BLOCKED_SHARE ? BLOCKED : ALLOWED
          r += colour[0]
          g += colour[1]
          b += colour[2]
          hits++
        }
      }
      // BGRA with premultiplied alpha.
      const total = SAMPLES * SAMPLES
      const offset = (y * SIZE + x) * 4
      pixels[offset] = Math.round(b / total)
      pixels[offset + 1] = Math.round(g / total)
      pixels[offset + 2] = Math.round(r / total)
      pixels[offset + 3] = Math.round((hits / total) * 255)
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: SIZE, height: SIZE })
}
