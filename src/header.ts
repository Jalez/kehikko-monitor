import { LIMITS, headerItemsSchema, type HeaderItem } from 'kehikot-module-protocol'

import { RANGES, STYLES, STYLE_SAID, callerName, type Caller, type Range, type Style } from './traffic/model.ts'

/**
 * What Monitor puts in its container's header: the range of the timeline, how it is drawn (Chart:
 * lines, bars or area), pause, which caller to show, and Clear. The host draws them; this page owns the state and declares the whole list again
 * whenever it changes.
 *
 * `agents: true` only on what loses nothing: the range, the chart, the pause and the caller. Clear puts away
 * what the page shows, so it is the person's.
 *
 * Labels are text the host draws as text: short words (`LABEL_FIT`), no markup, no links.
 */

/** How long a label may be and still read in a menu 200 pixels wide. The protocol's bound is 48. */
export const LABEL_FIT = 24

/** The most callers the Caller switch lists by name; the rest are reached by the page's own filter. */
export const CALLERS_LISTED = 12

/** The option of the Caller switch that is every caller. Not a module id: those have a dot. */
export const EVERY = 'all'

export interface HeaderState {
  range: Range
  /** How the timeline is drawn; kept with the host (`state.set`), so it is the same next time. */
  style: Style
  paused: boolean
  /** One caller, or every caller with null. */
  caller: Caller | null
  /** The callers seen, in the order the timeline colours them. */
  callers: readonly Caller[]
}

/** A header option id for a caller: its id, or what Kehikot named it (`unnamed` for a caller an older Kehikot could not). */
export function callerOption(caller: Caller): string {
  if (caller === '') return 'unnamed'
  /* A module id is at most 64 characters, inside the protocol's bound on a header id. */
  return caller.slice(0, LIMITS.HEADER_ID)
}

const clip = (label: string) => (label.length > LABEL_FIT ? `${label.slice(0, LABEL_FIT - 1)}…` : label)

export function headerItems(state: HeaderState): HeaderItem[] {
  const callers = state.callers.slice(0, CALLERS_LISTED)
  const value = state.caller === null ? EVERY : callerOption(state.caller)
  return headerItemsSchema.parse([
    {
      kind: 'switch',
      id: 'range',
      label: 'Range',
      agents: true,
      options: RANGES.map((minutes) => ({ id: `m${minutes}`, label: `Last ${minutes} minutes` })),
      value: `m${state.range}`,
    },
    {
      kind: 'switch',
      id: 'style',
      label: 'Chart',
      agents: true,
      options: STYLES.map((style) => ({ id: style, label: STYLE_SAID[style] })),
      value: state.style,
    },
    { kind: 'toggle', id: 'pause', label: 'Paused', agents: true, checked: state.paused },
    {
      kind: 'switch',
      id: 'caller',
      label: 'Caller',
      agents: true,
      options: [{ id: EVERY, label: 'Every caller' }, ...callers.map((caller) => ({ id: callerOption(caller), label: clip(callerName(caller)) }))],
      value: callers.some((caller) => callerOption(caller) === value) ? value : EVERY,
    },
    { kind: 'run', id: 'clear', label: 'Clear', state: 'idle' },
  ])
}

/** What Monitor keeps with the host (`state.set`): only how the chart is drawn. */
export interface Kept {
  style: Style
}

/** The chart style a kept value says, or Lines: anything else kept (an older Monitor's, or nothing) is ignored. */
export function keptStyle(kept: unknown): Style {
  const style = kept && typeof kept === 'object' ? (kept as { style?: unknown }).style : undefined
  return (STYLES as readonly unknown[]).includes(style) ? (style as Style) : 'lines'
}

export type Pressed = { range: Range } | { style: Style } | { paused: boolean } | { caller: Caller | null } | { clear: true }

/** What a press asks for, or a sentence saying why it was not taken. */
export function pressed(item: string, value: unknown, callers: readonly Caller[]): Pressed | string {
  if (item === 'range') {
    const minutes = typeof value === 'string' ? Number(value.replace(/^m/, '')) : NaN
    return (RANGES as readonly number[]).includes(minutes) ? { range: minutes as Range } : `"${String(value).slice(0, 40)}" is not a range Monitor shows.`
  }
  if (item === 'style') return (STYLES as readonly unknown[]).includes(value) ? { style: value as Style } : `"${String(value).slice(0, 40)}" is not a way Monitor draws its chart: lines, bars or area.`
  if (item === 'pause') return typeof value === 'boolean' ? { paused: value } : 'Pause is on or off.'
  if (item === 'caller') {
    if (value === EVERY) return { caller: null }
    const caller = callers.find((one) => callerOption(one) === value)
    return caller !== undefined ? { caller } : `Monitor has seen no caller called "${String(value).slice(0, 40)}".`
  }
  if (item === 'clear') return { clear: true }
  return `Monitor has nothing called "${item.slice(0, 40)}" to press.`
}
