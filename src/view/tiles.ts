import { msSaid, nameOf, percent, sizeSaid, type Disk } from '../health/model.ts'

/**
 * How the Health view's glance tiles are laid out at a width, what each chart's tooltip says, and the
 * disk's doughnut. Pure: the page draws it, the tests read it.
 *
 * The tiles carry no card of their own: no border, no background, no gap, only a hairline between
 * them and a tight padding. In one column a tile is a compact row — its title, a line in words and
 * its number on one line, the plot directly under it, edge to edge. Side by side, the words go on a
 * line of their own under the title. A narrow tile (under `AXES_FROM`) draws a sparkline, with no
 * axes and no grid; a wider one adds a y-axis with two ticks, the first and last time, and gridlines.
 */

/** From this tile width up, a chart has axes and gridlines; below it, a sparkline. */
export const AXES_FROM = 260
/** The plot's own height: a sparkline, and a chart with axes. Both are a comfortable touch target. */
export const SPARK_HEIGHT = 44
export const AXES_HEIGHT = 72
/** The disk's doughnut, across: beside axes, large enough for a word in its hole; beside its list; alone. */
export const RING_WIDE = 88
export const RING_MID = 64
/** One row of the doughnut's list, in px. */
export const LEGEND_ROW = 14
/** The hairline between tiles, in px: the grid's gap, showing the border colour behind the tiles. */
export const DIVIDER = 1
/** A tile's padding, in px: across, and above and below. A line plot runs through the padding across. */
export const PAD_X = 8
export const PAD_Y = 6
/** A tile's head row (its title and number) and its line in words, in px; the gap under each row. */
export const HEAD_HEIGHT = 20
export const SUB_HEIGHT = 16
export const ROW_GAP = 2

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
  /** One row per tile: title, words and number on one line, the plot under it. */
  compact: boolean
}

export function columnsOf(width: number): number {
  return width < 360 ? 1 : width < 640 ? 3 : 5
}

/** In three columns the disk takes the last two cells, so the grid has no hole and the doughnut room for its list. */
export const diskSpan = (columns: number): number => (columns === 3 ? 2 : 1)

export function tileLayout(width: number | null): TileLayout {
  if (width === null || width <= 0) return { columns: 1, tile: null, axes: false, plot: SPARK_HEIGHT, ring: SPARK_HEIGHT, legend: false, compact: true }
  const columns = columnsOf(width)
  const tile = Math.floor((width - DIVIDER * (columns - 1)) / columns)
  const span = diskSpan(columns)
  const disk = tile * span + DIVIDER * (span - 1)
  const axes = tile >= AXES_FROM
  const legend = disk >= 180
  return { columns, tile, axes, plot: axes ? AXES_HEIGHT : SPARK_HEIGHT, ring: axes ? RING_WIDE : legend ? RING_MID : SPARK_HEIGHT, legend, compact: columns === 1 }
}

/** The disk's plot row: as tall as its doughnut, or its list beside it when that is taller, never cut off. */
export function ringRow(layout: Pick<TileLayout, 'ring' | 'legend'>, segments: number): number {
  return Math.max(layout.ring, layout.legend ? segments * LEGEND_ROW : 0)
}

/** How tall the five tiles stand in one column, in px: four plots, the disk's row, and the hairlines between. */
export function columnHeight(layout: TileLayout, segments: number): number {
  const chrome = 2 * PAD_Y + HEAD_HEIGHT + ROW_GAP + (layout.compact ? 0 : SUB_HEIGHT + ROW_GAP)
  return 4 * (chrome + layout.plot) + chrome + ringRow(layout, segments) + 4 * DIVIDER
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

/** Where a tooltip sits along its plot, so it never runs off the tile: under the point, kept inside. */
export function tipAlign(index: number, count: number): 'start' | 'center' | 'end' {
  if (count <= 1) return 'center'
  const at = index / (count - 1)
  return at < 1 / 3 ? 'start' : at > 2 / 3 ? 'end' : 'center'
}

/** The space between a tooltip and its plot, in px. */
export const TIP_GAP = 4

/**
 * Whether a tooltip goes above its plot or below it — outside the plot either way, so it never lies
 * over the chart's own labels. Above when it fits under the top of what clips the page (`room`: the
 * px from there to the plot's top), else below.
 */
export function tipSide(room: number, tipHeight: number): 'above' | 'below' {
  return room >= tipHeight + TIP_GAP ? 'above' : 'below'
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

/**
 * A tooltip: three short lines at most. The value first (drawn bold), then what or whose it is, then
 * a muted note — the time of the point, or a second figure. An empty line is left out.
 */
export interface Tip {
  value: string
  detail: string
  note: string
}

/** The longest line a tooltip holds, in characters: it fits about 15 rem at 12 px without wrapping. */
export const TIP_LINE_MAX = 28

/** A tooltip's lines, in order, none empty. */
export const tipLines = (tip: Tip): string[] => [tip.value, tip.detail, tip.note].filter(Boolean)

/** A name cut to fit a tooltip's line. */
export const clip = (text: string, most = TIP_LINE_MAX): string => (text.length <= most ? text : `${text.slice(0, most - 1).trimEnd()}…`)

export const clock = (t: number): string => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

export function cpuTip(point: { at: number; cpu: number }, of: number): Tip {
  return { value: `${percent(point.cpu)} CPU`, detail: `${Math.round(point.cpu * 10) / 10} of ${of} cores`, note: clock(point.at) }
}

export function memoryTip(point: { at: number; rss: number }, of: number): Tip {
  return { value: sizeSaid(point.rss), detail: of ? `${percent(point.rss / of)} of ${sizeSaid(of)}` : '', note: clock(point.at) }
}

export function callsTip(one: { by: string; p95: number; calls: number; errors: number }): Tip {
  return { value: `${msSaid(one.p95)} p95`, detail: clip(nameOf(one.by)), note: `${one.errors} of ${one.calls} failed` }
}

export function restartsTip(one: { id: string; starts: number; crashes: number }): Tip {
  return { value: `${one.starts} ${one.starts === 1 ? 'start' : 'starts'}`, detail: clip(nameOf(one.id)), note: one.crashes ? `${one.crashes} after a crash` : 'no crash' }
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
  return { value: `${sizeSaid(one.bytes)} · ${percent(one.fraction)}`, detail: one.short, note: '' }
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
