import { LIMITS, footerItemsSchema, type FooterItem } from 'kehikot-module-protocol'

import { outsideSaid, outsideWhat } from './health/heavy.ts'
import { percent, sizeSaid, totals, type Judged, type Snapshot } from './health/model.ts'
import { rateSaid, ratesSaid, type NetSnapshot } from './health/network.ts'
import type { BudgetLine } from './traffic/budgets.ts'
import type { CallerSummary } from './traffic/model.ts'

/**
 * What Monitor puts in its container's footer (`kehikot.footer`, protocol 2.38.0): what this
 * computer's calls are doing now, so a container folded to its header and footer still says it.
 * The header keeps how the picture is set up (Range, Chart, Paused, Caller); the status line the
 * page drew above the timeline (live or paused, calls missed, a problem) is here instead.
 *
 * - live or paused;
 * - calls per minute over the last five minutes, and how many callers made them;
 * - how many calls repeat;
 * - the first limit Kehikot spends for you, as a meter, and a limit that paused calls;
 * - calls missed, and a problem reading the traffic;
 * - the health of Kehikot and its modules, when Monitor has sampled it: the worst module (or the
 *   busiest, when none is worth a word), CPU of every running module as a meter of the computer's
 *   cores, and their memory;
 * - this computer's network throughput, "↓ 2.4 MB/s · ↑ 120 kB/s", once two readings are held;
 * - Clear, beside the readouts it clears: it puts away what the page shows, so it is the person's
 *   alone, and it is here rather than in the header (never in both).
 */
export interface FooterState {
  paused: boolean
  rows: readonly CallerSummary[]
  repeating: number
  budgets: readonly BudgetLine[]
  gap: boolean
  problem: string | null
  /** The processes' health: the latest snapshot and its modules judged, the worst first. */
  health?: { snapshot: Snapshot; judged: readonly Judged[] } | null
  /** The machine's network throughput, as the server last read it. */
  network?: NetSnapshot | null
}

const cut = (text: string, most: number) => (text.length > most ? `${text.slice(0, most - 1)}…` : text)
const count = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n))

/** The health readouts: the worst module, CPU and memory. Empty before the first sample. */
export function healthItems(health: FooterState['health']): unknown[] {
  if (!health || !health.snapshot.at) return []
  const { snapshot, judged } = health
  const items: unknown[] = []
  const worst = judged.find((one) => snapshot.modules.find((m) => m.id === one.id)?.running || one.level !== 'normal')
  if (worst) {
    const text = worst.level === 'normal' ? `Busiest: ${worst.name} · ${worst.said}` : `${worst.name}: ${worst.said}`
    items.push({
      kind: 'text',
      id: 'worst',
      text: cut(text, LIMITS.FOOTER_TEXT),
      level: worst.level,
      tooltip: cut(worst.level === 'normal' ? `Nothing needs a look. The busiest is ${worst.name}: ${worst.said}.` : `The worst right now. ${worst.name}: ${worst.said}.`, LIMITS.FOOTER_TOOLTIP),
    })
  }
  const sum = totals(snapshot)
  const share = Math.min(1, sum.cpu / Math.max(1, snapshot.cores))
  items.push({
    kind: 'meter',
    id: 'cpu',
    label: 'CPU',
    value: share,
    text: cut(`${percent(sum.cpu)} · ${snapshot.cores} cores`, LIMITS.FOOTER_METER_TEXT),
    level: share >= 0.8 ? 'critical' : share >= 0.5 ? 'warn' : 'normal',
    align: 'center',
    tooltip: cut(`Kehikot and its ${sum.running} running programs use ${percent(sum.cpu)} of one core, ${percent(share)} of this computer's ${snapshot.cores} cores.`, LIMITS.FOOTER_TOOLTIP),
  })
  items.push({
    kind: 'text',
    id: 'memory',
    text: cut(`${sizeSaid(sum.rss)} memory`, LIMITS.FOOTER_TEXT),
    align: 'center',
    level: snapshot.memory && sum.rss / snapshot.memory >= 0.5 ? 'warn' : 'normal',
    tooltip: cut(`Kehikot and its running modules hold ${sizeSaid(sum.rss)}${snapshot.memory ? ` of this computer's ${sizeSaid(snapshot.memory)}` : ''}.`, LIMITS.FOOTER_TOOLTIP),
  })
  const outside = snapshot.outside ?? []
  if (outside.length) {
    /* Live state, one item in the existing row; each run is also an Inbox item (`src/inbox.ts`). */
    items.push({
      kind: 'text',
      id: 'outside',
      text: cut(`${outside.length} heavy run${outside.length === 1 ? '' : 's'} outside ${outsideWhat(snapshot.provider ?? null)}`, LIMITS.FOOTER_TEXT),
      level: 'warn',
      align: 'center',
      tooltip: cut(`${outsideSaid(outside, snapshot.provider ?? null)}.`, LIMITS.FOOTER_TOOLTIP),
    })
  }
  return items
}

/** The network readout: download and upload now. None before two readings. */
export function networkItems(net: FooterState['network']): unknown[] {
  if (!net) return []
  const said = ratesSaid(net)
  if (!said) return []
  return [
    {
      kind: 'text',
      id: 'network',
      text: cut(said, LIMITS.FOOTER_TEXT),
      align: 'center',
      tooltip: cut(`This computer downloads ${rateSaid(net.down as number)} and uploads ${rateSaid(net.up as number)} now, over all its network interfaces, read every ${net.every} s.`, LIMITS.FOOTER_TOOLTIP),
    },
  ]
}

export function footerItems({ paused, rows, repeating, budgets, gap, problem, health = null, network = null }: FooterState): FooterItem[] {
  const items: unknown[] = [
    paused
      ? { kind: 'text', id: 'live', text: 'Paused', level: 'warn', tooltip: 'The picture stands still. Turn Paused off to go on.' }
      : { kind: 'text', id: 'live', text: 'Live', tooltip: 'Read every second, on this computer only.' },
  ]
  const perMinute = rows.reduce((sum, row) => sum + row.perMinute, 0)
  items.push({
    kind: 'text',
    id: 'rate',
    text: `${Math.round(perMinute * 10) / 10}/min · ${rows.length} ${rows.length === 1 ? 'caller' : 'callers'}`,
    /* With the health readouts beside it, the rate is the first to go in a narrow row. */
    optional: true,
    tooltip: 'Calls per minute over the last five minutes, and how many callers made them.',
  })
  if (repeating) items.push({ kind: 'text', id: 'repeats', text: `${repeating} repeating`, level: 'warn', optional: true, tooltip: 'Calls made again and again: see Repeats.' })
  const stopped = budgets.find((line) => line.paused)
  if (stopped) items.push({ kind: 'text', id: 'stopped', text: cut(stopped.text, LIMITS.FOOTER_TEXT), level: 'critical', align: 'center', tooltip: cut(stopped.text, LIMITS.FOOTER_TOOLTIP) })
  const metered = budgets.find((line) => line.meter)
  if (metered?.meter) {
    const { used, limit, label } = metered.meter
    const share = limit > 0 ? Math.min(1, used / limit) : 1
    items.push({
      kind: 'meter',
      id: 'limit',
      label: 'Limit',
      value: share,
      text: cut(`${count(used)} / ${count(limit)}`, LIMITS.FOOTER_METER_TEXT),
      level: share >= 1 ? 'critical' : share >= 0.8 ? 'warn' : 'normal',
      align: 'center',
      optional: true,
      tooltip: cut(label, LIMITS.FOOTER_TOOLTIP),
    })
  }
  if (problem) items.push({ kind: 'text', id: 'problem', text: cut(problem, LIMITS.FOOTER_TEXT), level: 'warn', align: 'center', tooltip: cut(problem, LIMITS.FOOTER_TOOLTIP) })
  else if (gap) items.push({ kind: 'text', id: 'gap', text: 'Some calls missed', level: 'warn', optional: true, tooltip: 'Some calls were made faster than Monitor read them and are not shown.' })
  items.push(...healthItems(health))
  items.push(...networkItems(network))
  items.push({ kind: 'run', id: 'clear', label: 'Clear', icon: 'x', align: 'end', tooltip: 'Put away what Monitor shows; it goes on reading from now.' })
  return footerItemsSchema.parse(items)
}
