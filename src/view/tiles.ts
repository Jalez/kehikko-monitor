import { percent, sizeSaid } from '../health/model.ts'
import { rateSaid } from '../health/network.ts'

/**
 * How the Health view's glance tiles are laid out at a width, and what each chart's tooltip says. Pure: the page draws it, the tests read it.
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
  /** Tiles side by side: one under 360 px, then two (the grid's container queries). */
  columns: number
  /** One tile's width, null until the box is measured. */
  tile: number | null
  axes: boolean
  /** The plot's height in px. */
  plot: number
  /** One row per tile: title, words and number on one line, the plot under it. */
  compact: boolean
}

export function columnsOf(width: number): number {
  return width < 360 ? 1 : 2
}

export function tileLayout(width: number | null): TileLayout {
  if (width === null || width <= 0) return { columns: 1, tile: null, axes: false, plot: SPARK_HEIGHT, compact: true }
  const columns = columnsOf(width)
  const tile = Math.floor((width - DIVIDER * (columns - 1)) / columns)
  const axes = tile >= AXES_FROM
  return { columns, tile, axes, plot: axes ? AXES_HEIGHT : SPARK_HEIGHT, compact: columns === 1 }
}

/**
 * The Network tile's layout: one chart at every size, the whole row wide (it spans both columns), so a
 * sparkline under `AXES_FROM` and axes from there, as the others. Compact (title, rates and the verdict on
 * one row) in one column. Each host's round trip, the speed test and the busiest processes go under the
 * chart only when there is room (`top`).
 */
export function networkLayout(width: number | null, roomy = true): TileLayout & { top: boolean } {
  if (width === null || width <= 0) return { columns: 1, tile: null, axes: false, plot: SPARK_HEIGHT, compact: true, top: false }
  const columns = columnsOf(width)
  const axes = width >= AXES_FROM
  return { columns, tile: width, axes, plot: axes ? AXES_HEIGHT : SPARK_HEIGHT, compact: columns === 1, top: roomy && columns > 1 }
}

/** How tall the two tiles stand in one column, in px: two plots and the hairline between. */
export function columnHeight(layout: TileLayout): number {
  const chrome = 2 * PAD_Y + HEAD_HEIGHT + ROW_GAP + (layout.compact ? 0 : SUB_HEIGHT + ROW_GAP)
  return 2 * (chrome + layout.plot) + DIVIDER
}

/* ---- pointing at a chart ---- */

/** Which point a pointer `x` px across a plot `width` px wide is on: the nearest point of a line, the bar it is over. */
export function indexAt(x: number, width: number, count: number, kind: 'line' | 'bar'): number | null {
  if (count <= 0 || width <= 0) return null
  const at = Math.min(1, Math.max(0, x / width))
  const index = kind === 'line' ? Math.round(at * (count - 1)) : Math.floor(at * count)
  return Math.min(count - 1, Math.max(0, index))
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

/** Both rates on the first line, the round trip of the probes at that moment on the second ("probes lost" when none answered), the time last. */
export function networkTip(point: { at: number; down: number; up: number; ms?: number | null }): Tip {
  const latency = point.ms === undefined ? '' : point.ms === null ? 'probes lost' : `${Math.round(point.ms)} ms round trip`
  return { value: `↓ ${rateSaid(point.down)} · ↑ ${rateSaid(point.up)}`, detail: latency, note: clock(point.at) }
}

/** The top of a y-axis: a round number at or above the highest value. */
export function niceTop(max: number): number {
  if (!(max > 0)) return 1
  const power = 10 ** Math.floor(Math.log10(max))
  for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= max) return Math.round(step * power * 1000) / 1000
  return 10 * power
}
