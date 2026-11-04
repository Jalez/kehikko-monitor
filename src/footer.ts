import { LIMITS, footerItemsSchema, type FooterItem } from 'kehikot-module-protocol'

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
}

const cut = (text: string, most: number) => (text.length > most ? `${text.slice(0, most - 1)}…` : text)
const count = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n))

export function footerItems({ paused, rows, repeating, budgets, gap, problem }: FooterState): FooterItem[] {
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
  items.push({ kind: 'run', id: 'clear', label: 'Clear', icon: 'x', align: 'end', tooltip: 'Put away what Monitor shows; it goes on reading from now.' })
  return footerItemsSchema.parse(items)
}
