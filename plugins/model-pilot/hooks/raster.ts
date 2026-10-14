// Cell grids for the terminal's Raster element: each cell a code point and a
// 24-bit foreground and background. Used for the radial chart and the graph.

export const DEFAULT = 0x01000000

export type Cell = { ch: number; fg: number; bg: number }

export type Palette = {
  track: number
  done: number
  partial: number
  failed: number
  text: number
  dim: number
  read: number
  write: number
  handoff: number
  dep: number
  hot: number
  store: number
  running: number
  queued: number
}

export const DARK: Palette = {
  track: 0x262b36,
  done: 0x3fb950,
  partial: 0xd29922,
  failed: 0xf85149,
  text: 0xe6edf3,
  dim: 0x7d8590,
  read: 0x58a6ff,
  write: 0x3fb950,
  handoff: 0xbc8cff,
  dep: 0x6e7681,
  hot: 0xffd33d,
  store: 0x8b949e,
  running: 0xd29922,
  queued: 0x6e7681,
}

export const LIGHT: Palette = {
  ...DARK,
  track: 0xd8dee4,
  done: 0x1a7f37,
  partial: 0x9a6700,
  failed: 0xcf222e,
  text: 0x1f2328,
  dim: 0x656d76,
  read: 0x0969da,
  write: 0x1a7f37,
  handoff: 0x8250df,
  dep: 0x8c959f,
  hot: 0xbf8700,
  store: 0x57606a,
  running: 0x9a6700,
  queued: 0x8c959f,
}

export class Grid {
  readonly cells: Cell[]
  constructor(
    readonly cols: number,
    readonly rows: number,
  ) {
    this.cells = Array.from({ length: cols * rows }, () => ({ ch: 0x20, fg: DEFAULT, bg: DEFAULT }))
  }
  at(x: number, y: number) {
    return x >= 0 && y >= 0 && x < this.cols && y < this.rows ? this.cells[y * this.cols + x] : undefined
  }
  set(x: number, y: number, ch: string | number, fg = DEFAULT, bg?: number) {
    const c = this.at(x, y)
    if (!c) return
    c.ch = typeof ch === 'number' ? ch : safe(ch)
    c.fg = fg
    if (bg !== undefined) c.bg = bg
  }
  text(x: number, y: number, s: string, fg = DEFAULT, max = Infinity) {
    let i = 0
    for (const ch of s) {
      if (i >= max) break
      this.set(x + i, y, ch, fg)
      i++
    }
    return i
  }
  // Row-major [codePoint, fg, bg] u32 triplets, little-endian, base64.
  encode() {
    const words = new Uint32Array(this.cells.length * 3)
    this.cells.forEach((c, i) => {
      words[i * 3] = c.ch
      words[i * 3 + 1] = c.fg
      words[i * 3 + 2] = c.bg
    })
    return base64(new Uint8Array(words.buffer))
  }
  // The grid as plain text, for tests and the narrow fallback.
  lines() {
    const out: string[] = []
    for (let y = 0; y < this.rows; y++) {
      let s = ''
      for (let x = 0; x < this.cols; x++) s += String.fromCodePoint(this.cells[y * this.cols + x]!.ch)
      out.push(s.replace(/\s+$/, ''))
    }
    return out
  }
}

// Width-1 BMP only: anything else becomes '?'.
const safe = (ch: string) => {
  const cp = ch.codePointAt(0) ?? 0x20
  return cp < 0x20 || cp > 0xffff || (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ? 0x3f : cp
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export const base64 = (bytes: Uint8Array) => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (b === undefined ? '=' : B64[(n >> 6) & 63]!) + (c === undefined ? '=' : B64[n & 63]!)
  }
  return out
}

export type Ring = { done: number; partial: number; failed: number }

// A donut of `cols` × `rows` cells drawn at twice the vertical resolution with
// half blocks, so it is round in a terminal. Segments clockwise from the top:
// done, partial (estimated), failed, then the track. `label` lines sit in the
// hole.
export const donut = (cols: number, rows: number, ring: Ring | undefined, pal: Palette, label: { text: string; color: number }[]) => {
  const g = new Grid(cols, rows)
  const cx = cols / 2
  const cy = rows
  const outer = Math.min(cols / 2, rows) - 0.4
  const inner = outer * 0.62
  const colorAt = (px: number, py: number) => {
    const dx = px - cx
    const dy = py - cy
    const r = Math.sqrt(dx * dx + dy * dy)
    if (r < inner || r > outer) return undefined
    if (!ring) return pal.track
    let a = Math.atan2(dx, -dy) / (2 * Math.PI)
    if (a < 0) a += 1
    if (a < ring.done) return pal.done
    if (a < ring.done + ring.partial) return pal.partial
    if (a < ring.done + ring.partial + ring.failed) return pal.failed
    return pal.track
  }
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const top = colorAt(x + 0.5, y * 2 + 0.5)
      const bottom = colorAt(x + 0.5, y * 2 + 1.5)
      if (top !== undefined && bottom !== undefined) g.set(x, y, 0x2580, top, bottom)
      else if (top !== undefined) g.set(x, y, 0x2580, top, DEFAULT)
      else if (bottom !== undefined) g.set(x, y, 0x2584, bottom, DEFAULT)
    }
  }
  const startRow = Math.round(rows / 2 - label.length / 2)
  label.forEach((l, i) => {
    const s = l.text.slice(0, Math.max(0, Math.floor(inner * 2) - 1))
    g.text(Math.round(cx - s.length / 2), startRow + i, s, l.color)
  })
  return g
}
