import { TRAFFIC_HOST_BY, type TrafficCall } from 'kehikot-module-protocol'

/**
 * What the Monitor makes of the host's record of traffic: who is calling, how often, and what
 * repeats. Pure, and shared by the page and the MCP door, so an agent is told what the person sees.
 */

/** The ranges the timeline shows, in minutes. */
export const RANGES = [5, 15, 60] as const
export type Range = (typeof RANGES)[number]

/**
 * How the timeline is drawn. `lines`: one line per caller, the default — who is busy, and when.
 * `bars`: every caller stacked, a bar a bucket — the whole load. `area`: the same stack, smoothed.
 */
export const STYLES = ['lines', 'bars', 'area'] as const
export type Style = (typeof STYLES)[number]
export const STYLE_SAID: Record<Style, string> = { lines: 'Lines', bars: 'Bars', area: 'Area' }

/**
 * How wide a bucket is, by style and range. Bars show each second over five minutes; lines and
 * area are smoothed into buckets a line can be read through: 5 s over 5 min, 15 s over 15, a minute
 * over an hour — sixty points each.
 */
export const BUCKETS_MS: Record<Style, Record<Range, number>> = {
  bars: { 5: 1000, 15: 5000, 60: 15_000 },
  lines: { 5: 5000, 15: 15_000, 60: 60_000 },
  area: { 5: 5000, 15: 15_000, 60: 60_000 },
}
/** The bars' buckets, as before there were styles. */
export const BUCKET_MS: Record<Range, number> = BUCKETS_MS.bars

/**
 * A caller is who made or sent a call: the host (`kehikko`), a module id — an agent module's
 * sessions are filed under it — or, for a request from anything else, the name Kehikot gave it
 * (protocol 2.25.0: `~program:curl, from your terminal (zsh)`). `''` only from a Kehikot before
 * 2.25.0 that could not tell.
 */
export type Caller = string

/** Who a call is filed under. */
export function callerOf(call: TrafficCall): Caller {
  if (call.by) return call.by
  if (call.caller) return `~${call.caller.kind}:${call.caller.name}`
  return ''
}

/** What a Kehikot before 2.25.0 could not tell, said as what it is. */
export const UNNAMED = 'A program this Kehikot did not name'

/** The name a person knows a caller by: "Kehikot", "Kanban", "curl, from your terminal (zsh)". */
export function callerName(by: Caller): string {
  if (by === TRAFFIC_HOST_BY) return 'Kehikot'
  if (!by) return UNNAMED
  if (by.startsWith('~')) return by.slice(by.indexOf(':') + 1) || UNNAMED
  const last = by.replace(/^(kehikot|roadmap)\./, '').replace(/[-_.]+/g, ' ').trim()
  return last ? last[0]!.toUpperCase() + last.slice(1) : by
}

/** Who asked, as the row itself names it: a session by its place, else its caller. */
export const whoSaid = (call: TrafficCall): string => call.caller?.name ?? callerName(callerOf(call))

/** How many of an agent module's sessions are in the calls: one per process, or per place when no process was found. */
export function sessionsOf(calls: readonly TrafficCall[], by: Caller): number {
  const seen = new Set<string>()
  for (const call of calls) if (call.by === by && call.caller?.kind === 'session') seen.add(call.caller.pid ? `p${call.caller.pid}` : `n${call.caller.name}`)
  return seen.size
}

/** A caller's name with its sessions, when it has any: "Claude: 3 sessions". */
export function callerLabel(by: Caller, calls: readonly TrafficCall[]): string {
  const sessions = by && !by.startsWith('~') ? sessionsOf(calls, by) : 0
  return sessions ? `${callerName(by)}: ${sessions} session${sessions === 1 ? '' : 's'}` : callerName(by)
}

/** How Kehikot told who it was, in a sentence's words. */
export const HOW_SAID: Record<NonNullable<TrafficCall['caller']>['how'], string> = {
  route: 'by the route it asked: a module’s server, with its pass',
  origin: 'by the origin of the page that asked',
  token: 'by the place token on its MCP call',
  process: 'by the process holding the connection, and its parents',
  address: 'by its address: it is not this computer',
  closed: 'it could not: the program had closed its connection before Kehikot looked',
}

/** Whether a call cost nothing on the network: answered from a cache, a 304, or held back by a budget. */
export const isFree = (call: TrafficCall): boolean => call.cache !== undefined

/** Whether a call came with no reason. */
export const unlabelled = (call: TrafficCall): boolean => call.reason === null

/** Where a call went, as a person reads it. */
export function destination(call: TrafficCall): string {
  if (call.side === 'in') return `Kehikot ${call.path || '/'}`
  if (!call.host) return call.path || 'somewhere it did not say'
  return `${call.host}${call.path}`
}

/** What a call did, in a few words: "asks Kehikot", "calls", "opened a connection to". */
export function verb(call: TrafficCall): string {
  if (call.side === 'in') return 'asks'
  if (call.side === 'seen') return 'connected to'
  return 'called'
}

/** "2 s", "1.5 min", "under a second". */
export function spoken(ms: number): string {
  if (ms < 1000) return 'under a second'
  if (ms < 60_000) {
    const s = ms / 1000
    return `${s < 10 ? Math.round(s * 10) / 10 : Math.round(s)} s`
  }
  const min = ms / 60_000
  return `${min < 10 ? Math.round(min * 10) / 10 : Math.round(min)} min`
}

/** "1.2 kB", "340 B". */
export function bytesSaid(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`
  if (bytes < 1_000_000) return `${Math.round(bytes / 100) / 10} kB`
  return `${Math.round(bytes / 100_000) / 10} MB`
}

/* ------------------------------------------------------------------------ *
 * Keeping the rows the page holds.
 * ------------------------------------------------------------------------ */

/** The most rows the page holds: the host's own ring. */
export const HELD = 5000

/**
 * The rows held after a read: the new ones appended, an hour kept, at most `HELD`. A host that
 * restarted (`started` moved) is a new record: what was held from before is kept, newest last.
 */
export function held(before: readonly TrafficCall[], fresh: readonly TrafficCall[], now: number, keepMs = 60 * 60_000): TrafficCall[] {
  const from = now - keepMs
  const all = fresh.length ? [...before, ...fresh] : [...before]
  let first = 0
  while (first < all.length && all[first]!.at < from) first++
  const kept = first ? all.slice(first) : all
  return kept.length > HELD ? kept.slice(kept.length - HELD) : kept
}

/* ------------------------------------------------------------------------ *
 * The timeline: calls per second, stacked by caller, free calls apart.
 * ------------------------------------------------------------------------ */

/** The key of a caller's free calls in a bucket. */
export const freeKey = (caller: Caller) => `${caller}~free`

export interface Bucket {
  /** When the bucket starts, ms. */
  t: number
  [series: string]: number
}

/**
 * The buckets of the last `range` minutes, oldest first, each with calls per second for each
 * caller (`caller`, and `freeKey(caller)` for the free ones). Callers outside `shown` fold into
 * "Other". A bucket with no calls is all zeros, so the bars stand where the time is.
 */
export function buckets(calls: readonly TrafficCall[], now: number, range: Range, shown: readonly Caller[], width: number = BUCKET_MS[range]): Bucket[] {
  const end = Math.floor(now / width) * width
  const count = Math.round((range * 60_000) / width)
  const start = end - (count - 1) * width
  const keys = [...shown, OTHER]
  const out: Bucket[] = Array.from({ length: count }, (_, i) => {
    const bucket: Bucket = { t: start + i * width }
    for (const key of keys) {
      bucket[key] = 0
      bucket[freeKey(key)] = 0
    }
    return bucket
  })
  const perSecond = 1000 / width
  for (const call of calls) {
    /* A connection the sampler saw is not a call: it is listed, not counted. */
    if (call.side === 'seen') continue
    const i = Math.floor((call.at - start) / width)
    if (i < 0 || i >= count) continue
    const who = callerOf(call)
    const caller = shown.includes(who) ? who : OTHER
    const key = isFree(call) ? freeKey(caller) : caller
    out[i]![key] = (out[i]![key] ?? 0) + perSecond
  }
  return out
}

/** The series that folds the callers past the palette. */
export const OTHER = '~other'

/** How many callers get a colour of their own; the rest are "Other". */
export const COLOURED = 7

/**
 * The callers in the order they get their colours: kept from before (a colour follows its caller,
 * never its rank), new ones after, in the order they first called. At most `COLOURED`.
 */
export function colourOrder(before: readonly Caller[], calls: readonly TrafficCall[]): Caller[] {
  const order = [...before]
  for (const call of calls) {
    if (order.length >= COLOURED) break
    const who = callerOf(call)
    if (!order.includes(who)) order.push(who)
  }
  return order
}

/* ------------------------------------------------------------------------ *
 * Repeats: the redundant-call finder.
 * ------------------------------------------------------------------------ */

export interface Repeat {
  key: string
  by: Caller
  side: TrafficCall['side']
  kind: string
  where: string
  reason: string | null
  /** How many in the window. */
  count: number
  /** The typical time between two of them, ms (the median). */
  every: number
  /** Of the pairs in a row, how many got the same answer back (the same status and size, or a 304). */
  same: number
  /** How many were free (a cache, a 304, held back). */
  free: number
  /** From the first to the last, ms. */
  span: number
  /** Made in bursts rather than on a beat: the typical gap is far shorter than the average one. */
  bursty: boolean
  last: number
  /** The sentence: "Kanban asks Kehikot /host/call (tracker.get) every 2 s". */
  said: string
}

/** What counts as a repeat: this many of the same call in this window. */
export const REPEAT_MIN = 5
export const REPEAT_WINDOW_MS = 2 * 60_000

const keyOf = (call: TrafficCall) => [callerOf(call), call.via, call.side, call.kind, call.host, call.path, call.reason ?? ''].join('\u0000')

const median = (values: number[]) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** One repeat's sentence. */
export function repeatSaid(repeat: Pick<Repeat, 'by' | 'side' | 'kind' | 'where' | 'reason' | 'count' | 'every' | 'same' | 'bursty' | 'span'>): string {
  const who = callerName(repeat.by)
  const what = repeat.reason ? `${repeat.where} (${repeat.reason})` : `${repeat.where} (no reason given)`
  const how = repeat.side === 'in' ? 'asks' : repeat.side === 'seen' ? 'opens a connection to' : repeat.kind.startsWith('git') || repeat.kind.startsWith('gh') || repeat.kind.startsWith('glab') ? `runs ${repeat.kind} on` : 'calls'
  const sameSaid = repeat.count > 1 && repeat.same >= repeat.count - 1 ? ', getting the same answer each time' : repeat.same > 0 ? `, ${repeat.same} of them answered as the one before` : ''
  const often = repeat.bursty ? `in bursts over ${spoken(repeat.span)}` : repeat.every < 1000 ? 'several times a second' : `every ${spoken(repeat.every)}`
  return `${who} ${how} ${what} ${often} — ${repeat.count} times${sameSaid}`
}

/**
 * The calls made again and again in the last `windowMs`: the same caller, kind, destination and
 * reason at least `min` times, most first. The connections the sampler saw are left out: a
 * connection is not a call.
 */
export function repeats(calls: readonly TrafficCall[], now: number, windowMs = REPEAT_WINDOW_MS, min = REPEAT_MIN): Repeat[] {
  const from = now - windowMs
  const groups = new Map<string, TrafficCall[]>()
  for (const call of calls) {
    if (call.at < from || call.side === 'seen') continue
    const key = keyOf(call)
    const group = groups.get(key)
    if (group) group.push(call)
    else groups.set(key, [call])
  }
  const out: Repeat[] = []
  for (const [key, group] of groups) {
    if (group.length < min) continue
    group.sort((a, b) => a.at - b.at)
    const gaps: number[] = []
    let same = 0
    for (let i = 1; i < group.length; i++) {
      const a = group[i - 1]!
      const b = group[i]!
      gaps.push(b.at - a.at)
      if (b.status === 304 || (a.status === b.status && a.bytesOut === b.bytesOut && a.bytesIn === b.bytesIn)) same++
    }
    const first = group[0]!
    const span = group[group.length - 1]!.at - first.at
    const every = median(gaps)
    const repeat = {
      key,
      by: callerOf(first),
      side: first.side,
      kind: first.kind,
      where: destination(first),
      reason: first.reason,
      count: group.length,
      every,
      span,
      bursty: span > 0 && every < span / (group.length - 1) / 2,
      same,
      free: group.filter(isFree).length,
      last: group[group.length - 1]!.at,
    }
    out.push({ ...repeat, said: repeatSaid(repeat) })
  }
  return out.sort((a, b) => b.count - a.count || a.every - b.every)
}

/* ------------------------------------------------------------------------ *
 * The summary per caller.
 * ------------------------------------------------------------------------ */

export interface CallerSummary {
  by: Caller
  name: string
  calls: number
  perMinute: number
  bytes: number
  free: number
  /** Free calls as a share of all, 0–1. */
  freeRate: number
  unlabelled: number
  /** Connections the sampler saw that nobody reported. */
  seen: number
}

/** Each caller's last `windowMs`, busiest first. */
export function summary(calls: readonly TrafficCall[], now: number, windowMs = 5 * 60_000): CallerSummary[] {
  const from = now - windowMs
  const by = new Map<Caller, CallerSummary>()
  for (const call of calls) {
    if (call.at < from) continue
    const who = callerOf(call)
    const one = by.get(who) ?? { by: who, name: callerName(who), calls: 0, perMinute: 0, bytes: 0, free: 0, freeRate: 0, unlabelled: 0, seen: 0 }
    if (call.side === 'seen') one.seen++
    else {
      one.calls++
      if (isFree(call)) one.free++
      if (unlabelled(call)) one.unlabelled++
    }
    one.bytes += (call.bytesIn ?? 0) + (call.bytesOut ?? 0)
    by.set(who, one)
  }
  const minutes = windowMs / 60_000
  const recent = calls.filter((call) => call.at >= from)
  return [...by.values()]
    .map((one) => ({ ...one, name: callerLabel(one.by, recent), perMinute: Math.round((one.calls / minutes) * 10) / 10, freeRate: one.calls ? one.free / one.calls : 0 }))
    .sort((a, b) => b.calls - a.calls || b.seen - a.seen)
}

/* ------------------------------------------------------------------------ *
 * Filtering the list.
 * ------------------------------------------------------------------------ */

export interface Filter {
  /** One caller, or every caller with null. */
  by: Caller | null
  /** Words matched against the destination, the kind and the reason. */
  text: string
}

export function filtered(calls: readonly TrafficCall[], filter: Filter): TrafficCall[] {
  const words = filter.text.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return calls.filter((call) => {
    if (filter.by !== null && callerOf(call) !== filter.by) return false
    if (!words.length) return true
    const hay = `${destination(call)} ${call.kind} ${call.reason ?? 'no reason given'} ${callerName(callerOf(call))} ${call.caller?.name ?? ''}`.toLowerCase()
    return words.every((word) => hay.includes(word))
  })
}

/** One row of the list, as a line: for the door, and for a screen reader. */
export function callLine(call: TrafficCall): string {
  const when = new Date(call.at).toISOString().slice(11, 19)
  const status = call.status === null ? '' : ` → ${call.status}`
  const free = call.cache === 'not-modified' ? ' (304, free)' : call.cache === 'hit' ? ' (from a cache, not sent)' : call.cache === 'refused' ? ' (held back by a budget, not sent)' : ''
  const took = call.ms === null ? '' : ` in ${call.ms} ms`
  const size = call.bytesIn || call.bytesOut ? `, ${bytesSaid((call.bytesIn ?? 0) + (call.bytesOut ?? 0))}` : ''
  const why = call.reason ?? 'no reason given'
  return `${when} ${whoSaid(call)} ${verb(call)} ${call.kind} ${destination(call)}${status}${free}${took}${size} — ${why}`
}
