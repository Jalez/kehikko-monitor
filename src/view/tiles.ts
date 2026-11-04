import { LIMITS, msSaid, nameOf, percent, sizeSaid, type Disk } from '../health/model.ts'

/**
 * How the Health view's glance tiles are laid out at a width, what each chart's tooltip says, and the
 * disk's doughnut. Pure: the page draws it, the tests read it.
 *
 * A tile is three rows, never overlaid: its title and number, a line in words, then the plot at a
 * height of its own. A narrow tile (under `AXES_FROM`) draws a sparkline, with no axes and no grid;
 * a wider one adds a y-axis with two ticks, the first and last time, and horizontal gridlines.
 */

/** From this tile width up, a chart has axes and gridlines; below it, a sparkline. */
export const AXES_FROM = 260
/** The plot's own height: a sparkline, and a chart with axes. Both are a comfortable touch target. */
export const SPARK_HEIGHT = 44
export const AXES_HEIGHT = 72
/** The disk's doughnut, across: as tall as a sparkline, larger beside axes so its hole can hold a word. */
export const RING_WIDE = 88
/** The gap between tiles, in px (`gap-2`). */
export const GAP = 8

export interface TileLayout {
  /** Tiles side by side: one under 360 px, three under 640, then five (the grid's container queries). */
  columns: number
  /** One tile's width, null until the box is measured. */
  tile: number | null
  axes: boolean
  /** The plot's height in px. */
  plot: number
  /** The disk's doughnut, across, in px. */
  ring: number
  /** Whether the disk's list of segments shows beside its doughnut (else it is read by screen readers only). */
  legend: boolean
}

export function columnsOf(width: number): number {
  return width < 360 ? 1 : width < 640 ? 3 : 5
}

export function tileLayout(width: number | null): TileLayout {
  if (width === null || width <= 0) return { columns: 1, tile: null, axes: false, plot: SPARK_HEIGHT, ring: SPARK_HEIGHT, legend: false }
  const columns = columnsOf(width)
  const tile = Math.floor((width - GAP * (columns - 1)) / columns)
  const axes = tile >= AXES_FROM
  return { columns, tile, axes, plot: axes ? AXES_HEIGHT : SPARK_HEIGHT, ring: axes ? RING_WIDE : SPARK_HEIGHT, legend: tile >= 180 }
}

/* ---- pointing at a chart ---- */

/** Which point a pointer `x` px across a plot `width` px wide is on: the nearest point of a line, the bar it is over. */
export function indexAt(x: number, width: number, count: number, kind: 'line' | 'bar'): number | null {
  if (count <= 0 || width <= 0) return null
  const at = Math.min(1, Math.max(0, x / width))
  const index = kind === 'line' ? Math.round(at * (count - 1)) : Math.floor(at * count)
  return Math.min(count - 1, Math.max(0, index))
}

/**
 * Which segment of a doughnut `size` px square a pointer at (`x`, `y`) is on. Segments run clockwise
 * from twelve o'clock, as drawn; `fractions` add up to 1. Null in the hole or outside the ring.
 */
export function segmentAt(x: number, y: number, size: number, fractions: readonly number[], hole = HOLE): number | null {
  const r = size / 2
  const dx = x - r
  const dy = y - r
  const distance = Math.hypot(dx, dy)
  if (!fractions.length || distance > r || distance < r * hole) return null
  /* 0 at twelve o'clock, growing clockwise, in turns. */
  const turn = (Math.atan2(dx, -dy) / (2 * Math.PI) + 1) % 1
  let sum = 0
  for (let i = 0; i < fractions.length; i++) {
    sum += fractions[i] as number
    if (turn < sum) return i
  }
  return fractions.length - 1
}

/** Where a tooltip sits over its plot, so it never runs off the tile: under the point, kept inside. */
export function tipAlign(index: number, count: number): 'start' | 'center' | 'end' {
  if (count <= 1) return 'center'
  const at = index / (count - 1)
  return at < 1 / 3 ? 'start' : at > 2 / 3 ? 'end' : 'center'
}

/** The key that moves the point a chart's tooltip is on: the next index, or null to close it. */
export function stepped(key: string, index: number | null, count: number): number | null | undefined {
  if (!count) return undefined
  const from = index ?? count - 1
  if (key === 'ArrowRight' || key === 'ArrowUp') return Math.min(count - 1, index === null ? from : from + 1)
  if (key === 'ArrowLeft' || key === 'ArrowDown') return Math.max(0, index === null ? from : from - 1)
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  if (key === 'Escape') return null
  return undefined
}

/* ---- what a tooltip says ---- */

/** A tooltip: the value against its limit, what it is, and when. */
export interface Tip {
  value: string
  detail: string
  at: string
}

export const clock = (t: number): string => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

export function cpuTip(point: { at: number; cpu: number }, of: number): Tip {
  return { value: `${percent(point.cpu)} CPU`, detail: `${Math.round(point.cpu * 10) / 10} of ${of} cores`, at: clock(point.at) }
}

export function memoryTip(point: { at: number; rss: number }, of: number): Tip {
  return { value: sizeSaid(point.rss), detail: of ? `of ${sizeSaid(of)} (${percent(point.rss / of)})` : 'resident', at: clock(point.at) }
}

export function callsTip(one: { by: string; p95: number; p50: number | null; calls: number; errors: number }): Tip {
  return {
    value: `${msSaid(one.p95)} p95`,
    detail: `${nameOf(one.by)} · ${one.errors} of ${one.calls} failed · flagged from ${msSaid(LIMITS.p95Warn)}`,
    at: 'last 5 min',
  }
}

export function restartsTip(one: { id: string; starts: number; crashes: number }): Tip {
  return {
    value: `${one.starts} ${one.starts === 1 ? 'start' : 'starts'}`,
    detail: `${nameOf(one.id)} · ${one.crashes ? `${one.crashes} after a crash` : 'no crash'} · flagged from ${LIMITS.startsWarn}`,
    at: 'last 24 h',
  }
}

/* ---- the disk, as a doughnut ---- */

/** The doughnut's hole, as a share of its radius. */
export const HOLE = 0.66

export type SegmentKey = 'frame' | 'modules' | 'logs' | 'worktrees' | 'other'

export interface Segment {
  key: SegmentKey
  /** Said in full, in the tooltip and the list. */
  label: string
  /** Short enough for the doughnut's hole. */
  short: string
  bytes: number
  fraction: number
}

const NAMES: Record<SegmentKey, { label: string; short: string }> = {
  frame: { label: 'Kehikot’s database (frame.sqlite)', short: 'frame.sqlite' },
  modules: { label: 'Installed modules', short: 'Modules' },
  logs: { label: 'Logs', short: 'Logs' },
  worktrees: { label: 'Agent worktrees', short: 'Worktrees' },
  other: { label: 'Other', short: 'Other' },
}

/** What Kehikot takes on the disk, one segment per consumer, the biggest first; nothing of size 0. */
export function diskSegments(disk: Disk): Segment[] {
  const bytes: Record<SegmentKey, number> = { frame: 0, modules: 0, logs: 0, worktrees: 0, other: 0 }
  const others: string[] = []
  for (const use of disk.uses) {
    const key: SegmentKey =
      use.kind === 'worktrees' ? 'worktrees' : use.kind === 'logs' ? 'logs' : /frame\.sqlite/.test(use.label) ? 'frame' : use.label === 'Installed modules' ? 'modules' : 'other'
    bytes[key] += use.bytes
    if (key === 'other' && use.bytes > 0) others.push(use.label.toLowerCase())
  }
  const total = Object.values(bytes).reduce((sum, n) => sum + n, 0)
  if (!total) return []
  return (Object.keys(bytes) as SegmentKey[])
    .filter((key) => bytes[key] > 0)
    .map((key) => ({
      key,
      label: key === 'other' && others.length ? `Other (${others.join(', ')})` : NAMES[key].label,
      short: NAMES[key].short,
      bytes: bytes[key],
      fraction: bytes[key] / total,
    }))
    .sort((a, b) => b.bytes - a.bytes)
}

export function segmentTip(one: Segment): Tip {
  return { value: one.short, detail: `${sizeSaid(one.bytes)} (${percent(one.fraction)})`, at: '' }
}

/** The doughnut as a sentence: every segment and its size. */
export function segmentsSaid(segments: readonly Segment[]): string {
  if (!segments.length) return 'Kehikot’s folders are being measured.'
  const total = segments.reduce((sum, one) => sum + one.bytes, 0)
  return `Kehikot takes ${sizeSaid(total)}: ${segments.map((one) => `${one.label} ${sizeSaid(one.bytes)}`).join(', ')}.`
}

/**
 * The biggest segment's short label for the doughnut's hole, when it fits a doughnut `size` px across
 * at about 5.5 px a character (9 px text); null when it does not.
 */
export function centreLabel(segments: readonly Segment[], size: number, charPx = 5.5): string | null {
  const big = segments[0]
  if (!big) return null
  return big.short.length * charPx <= size * HOLE * 0.9 ? big.short : null
}

/** The top of a y-axis: a round number at or above the highest value. */
export function niceTop(max: number): number {
  if (!(max > 0)) return 1
  const power = 10 ** Math.floor(Math.log10(max))
  for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= max) return Math.round(step * power * 1000) / 1000
  return 10 * power
}
